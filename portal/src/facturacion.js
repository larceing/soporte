// Horas y gastos de cada trabajo, con su tarifa: lo que luego se factura en Sindri (src/sindri.js).
// El gestor ya no cobra ni emite documentos; las tablas de cobros y documentos de antes (ha_pago,
// ha_documento) se conservan tal cual y solo se leen para no volver a facturar lo ya cobrado.

const { consulta } = require('./db');
const { ErrorUsuario, diaLocal, selloLocal, esDia, redondear, texto } = require('./util');

const CONFIG_DEFECTO = {
  TARIFA_HORA: '15',
  MONEDA: '€',
  HORAS_MINIMAS: '1',
  // El IVA y la retención con que se dan de alta los servicios y los clientes en Sindri.
  IVA: '0',
  IRPF: '0'
};

/* Configuración */

async function config() {
  const filas = await consulta('SELECT clave, valor FROM ha_config');
  const mapa = { ...CONFIG_DEFECTO };
  // La conexión con Sindri (su llave) no sale de aquí: la lleva src/sindri.js.
  filas.forEach(f => { if (!f.clave.startsWith('SINDRI_')) mapa[f.clave] = f.valor; });
  return mapa;
}

async function configGuardar(datos) {
  for (const clave of Object.keys(CONFIG_DEFECTO)) {
    if (datos[clave] === undefined) continue;
    await consulta(
      'INSERT INTO ha_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      [clave, texto(datos[clave], 2000)]
    );
  }
  return config();
}

/* Clientes */

async function clientes() {
  return consulta('SELECT * FROM ha_cliente WHERE activo = 1 ORDER BY nombre');
}

// Mientras solo haya un cliente, todo el trabajo es suyo.
async function clientePorDefecto() {
  const lista = await clientes();
  if (!lista.length) throw new ErrorUsuario('Da de alta un cliente en Ajustes antes de registrar trabajo.');
  return lista[0];
}

async function clientePorId(id) {
  if (!id) return clientePorDefecto();
  const filas = await consulta('SELECT * FROM ha_cliente WHERE id = ?', [Number(id)]);
  if (!filas.length) throw new ErrorUsuario('Cliente no encontrado.', 404);
  return filas[0];
}

async function clienteGuardar(datos) {
  const nombre = texto(datos.nombre, 120);
  if (!nombre) throw new ErrorUsuario('Indica el nombre del cliente.');

  const tarifa = datos.tarifa_hora === '' || datos.tarifa_hora == null ? null : Number(datos.tarifa_hora);
  const valores = [
    nombre, texto(datos.razon_social, 200), texto(datos.nif, 32), texto(datos.direccion, 1000),
    tarifa > 0 ? tarifa : null, texto(datos.telefono, 64), texto(datos.email, 200),
    texto(datos.contacto, 200), texto(datos.notas, 4000)
  ];

  if (datos.id) {
    await consulta(
      `UPDATE ha_cliente SET nombre = ?, razon_social = ?, nif = ?, direccion = ?, tarifa_hora = ?,
              telefono = ?, email = ?, contacto = ?, notas = ? WHERE id = ?`,
      [...valores, Number(datos.id)]
    );
  } else {
    await consulta(
      `INSERT INTO ha_cliente (nombre, razon_social, nif, direccion, tarifa_hora, telefono, email, contacto, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      valores
    );
  }
  return clientes();
}

/* Trabajos */

function horasFacturables(minutos, cfg) {
  const minimas = Number(cfg.HORAS_MINIMAS || 1);
  return Math.max(minimas, Math.ceil(Number(minutos || 0) / 60));
}

function tarifaDe(cliente, cfg) {
  return Number(cliente.tarifa_hora) > 0 ? Number(cliente.tarifa_hora) : Number(cfg.TARIFA_HORA || 0);
}

async function codigoLibre(prefijo, fecha) {
  const base = prefijo + '-' + selloLocal(fecha);
  for (let n = 0; ; n++) {
    const codigo = n ? base + '-' + n : base;
    const filas = await consulta(
      'SELECT 1 FROM ha_trabajo WHERE codigo = ? UNION SELECT 1 FROM ha_pago WHERE codigo = ?',
      [codigo, codigo]
    );
    if (!filas.length) return codigo;
  }
}

// Sesión de trabajo: cada una se redondea a horas enteras con el mínimo
// configurado, como hacía el gestor antiguo.
async function trabajoDeTiempo({ incidenciaId, notaId, concepto, detalle, minutos, fecha }) {
  const cfg = await config();
  const cliente = await clientePorDefecto();
  const horas = horasFacturables(minutos, cfg);
  const tarifa = tarifaDe(cliente, cfg);
  const momento = fecha || new Date();

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, incidencia_id, nota_id, concepto, detalle, dia,
                             minutos, horas, tarifa, importe, tipo, estado, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TIEMPO', 'CERRADA', UTC_TIMESTAMP())`,
    [await codigoLibre('SES', momento), cliente.id, incidenciaId, notaId || null, texto(concepto, 255),
      texto(detalle, 20000), diaLocal(momento), minutos, horas, tarifa, redondear(horas * tarifa)]
  );
}

async function gastoCrear(datos) {
  const concepto = texto(datos.concepto, 255);
  const importe = Number(String(datos.importe || '').replace(',', '.'));
  if (!concepto) throw new ErrorUsuario('Indica el concepto.');
  if (!importe || importe <= 0) throw new ErrorUsuario('Indica un importe mayor que cero.');

  const cliente = await clientePorId(datos.clienteId);
  const dia = esDia(datos.dia) ? datos.dia : diaLocal();

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, concepto, detalle, dia, importe, tipo, estado, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, 'UNICO', 'CERRADA', UTC_TIMESTAMP())`,
    [await codigoLibre('COB'), cliente.id, concepto, texto(datos.detalle, 20000), dia, redondear(importe)]
  );
}

async function trabajos(filtros) {
  const donde = [];
  const params = [];

  if (esDia(filtros.desde)) { donde.push('t.dia >= ?'); params.push(filtros.desde); }
  if (esDia(filtros.hasta)) { donde.push('t.dia <= ?'); params.push(filtros.hasta); }
  if (filtros.incidenciaId) { donde.push('t.incidencia_id = ?'); params.push(Number(filtros.incidenciaId)); }
  if (filtros.cobro === 'PENDIENTE') donde.push("t.pago_id IS NULL AND t.estado = 'CERRADA' AND t.sindri_pedido IS NULL");
  if (filtros.cobro === 'SINDRI') donde.push('t.sindri_pedido IS NOT NULL');
  if (filtros.cobro === 'COBRADO') donde.push('t.pago_id IS NOT NULL');
  if (filtros.cobro === 'NO_COBRAR') donde.push("t.estado = 'NO_COBRAR'");
  if (filtros.q) {
    donde.push('(t.concepto LIKE ? OR t.detalle LIKE ? OR t.codigo LIKE ?)');
    const patron = '%' + String(filtros.q).slice(0, 100) + '%';
    params.push(patron, patron, patron);
  }

  const filas = await consulta(
    `SELECT t.id, t.codigo, t.incidencia_id AS incidenciaId, t.concepto, t.detalle, t.dia, t.minutos,
            t.horas, t.tarifa, t.importe, t.tipo, t.estado, t.pago_id AS pagoId, t.sindri_pedido AS sindriPedido, c.nombre AS cliente
       FROM ha_trabajo t JOIN ha_cliente c ON c.id = t.cliente_id
      ${donde.length ? 'WHERE ' + donde.join(' AND ') : ''}
      ORDER BY t.dia DESC, t.id DESC`,
    params
  );

  const ocupados = await trabajosOcupados();
  return filas.map(f => ({ ...f, situacion: situacionDe(f, ocupados.get(Number(f.id))) }));
}

// En qué punto de la facturación está un trabajo. Lo cobrado o facturado antes en el gestor y lo
// que ya está en un pedido de Sindri no se puede tocar.
function situacionDe(trabajo, doc) {
  if (trabajo.pagoId) return { clave: 'COBRADO', texto: 'Cobrado' + (doc ? ' · ' + doc.codigo : '') };
  if (doc) return { clave: 'FACTURADO', texto: 'Facturado ' + doc.codigo };
  if (trabajo.sindriPedido) return { clave: 'SINDRI', texto: 'En pedido Sindri ' + trabajo.sindriPedido };
  if (trabajo.estado === 'NO_COBRAR') return { clave: 'NO_COBRAR', texto: 'No se factura' };
  return { clave: 'PENDIENTE', texto: 'Pendiente' };
}

async function trabajoEstado(id, estado) {
  if (['CERRADA', 'NO_COBRAR'].indexOf(estado) === -1) throw new ErrorUsuario('Estado no válido.');

  const [trabajo] = await consulta('SELECT id, pago_id, sindri_pedido FROM ha_trabajo WHERE id = ?', [Number(id) || 0]);
  if (!trabajo) throw new ErrorUsuario('Trabajo no encontrado.', 404);
  if (trabajo.pago_id) throw new ErrorUsuario('No se puede cambiar un trabajo ya cobrado.', 409);
  if (trabajo.sindri_pedido) throw new ErrorUsuario('No se puede cambiar: el trabajo está en el pedido ' + trabajo.sindri_pedido + ' de Sindri.', 409);

  const doc = (await trabajosOcupados()).get(trabajo.id);
  if (doc) throw new ErrorUsuario('No se puede cambiar: el trabajo está en ' + doc.codigo + '.', 409);

  await consulta('UPDATE ha_trabajo SET estado = ? WHERE id = ?', [estado, trabajo.id]);
}

function datosDe(doc) {
  try {
    return JSON.parse(doc.datos_json || '{}');
  } catch (e) {
    return {};
  }
}

// Trabajos que están en una factura emitida antes, cuando el gestor facturaba: no se vuelven a
// facturar. Las proformas no cuentan: no eran facturas.
async function trabajosOcupados() {
  const docs = await consulta(
    "SELECT codigo, tipo, datos_json FROM ha_documento WHERE tipo = 'FACTURA' AND estado IN ('EMITIDA', 'COBRADA')"
  );
  const ocupados = new Map();
  docs.forEach(doc => (datosDe(doc).lineas || []).forEach(l => {
    ocupados.set(Number(l.id), { codigo: doc.codigo, tipo: doc.tipo });
  }));
  return ocupados;
}

module.exports = {
  config, configGuardar,
  clientes, clienteGuardar,
  trabajoDeTiempo, gastoCrear, trabajos, trabajoEstado, trabajosOcupados
};
