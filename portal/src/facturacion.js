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
  // Las conexiones con Sindri y Tareas (sus llaves) no salen de aquí: src/sindri.js y src/tareas.js.
  filas.forEach(f => { if (!f.clave.startsWith('SINDRI_') && !f.clave.startsWith('TAREAS_')) mapa[f.clave] = f.valor; });
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

// usuario: los clientes que ve esa persona (los de su grupo y los que le compartan). Sin usuario,
// todos (uso interno). Cada fila dice si es de otro (deOtro): se usa, pero no se cambia.
async function clientes(usuario) {
  const todos = await consulta('SELECT * FROM ha_cliente WHERE activo = 1 ORDER BY nombre');
  if (usuario === undefined) return todos;
  const v = await vista(usuario);
  return todos.filter(c => v.veDe('clientes', c.dueno)).map(c => ({ ...c, deOtro: (c.dueno || '') !== v.mio }));
}

// El cliente de un trabajo nuevo: el primero de su grupo; si no tiene, el primero que le compartan.
async function clientePorDefecto(usuario) {
  const lista = await clientes(usuario);
  const v = usuario !== undefined ? await vista(usuario) : null;
  const propio = v ? lista.find(c => (c.dueno || '') === v.mio) : null;
  if (!lista.length) throw new ErrorUsuario('Da de alta un cliente en Ajustes antes de registrar trabajo.');
  return propio || lista[0];
}

async function clientePorId(id, usuario) {
  if (!id) return clientePorDefecto(usuario);
  const filas = await consulta('SELECT * FROM ha_cliente WHERE id = ?', [Number(id)]);
  if (!filas.length) throw new ErrorUsuario('Cliente no encontrado.', 404);
  if (usuario !== undefined && !(await vista(usuario)).veDe('clientes', filas[0].dueno)) throw new ErrorUsuario('Cliente no encontrado.', 404);
  return filas[0];
}

async function clienteGuardar(datos, usuario) {
  const v = await vista(usuario);
  const nombre = texto(datos.nombre, 120);
  if (!nombre) throw new ErrorUsuario('Indica el nombre del cliente.');

  const tarifa = datos.tarifa_hora === '' || datos.tarifa_hora == null ? null : Number(datos.tarifa_hora);
  const valores = [
    nombre, texto(datos.razon_social, 200), texto(datos.nif, 32), texto(datos.direccion, 1000),
    tarifa > 0 ? tarifa : null, texto(datos.telefono, 64), texto(datos.email, 200),
    texto(datos.contacto, 200), texto(datos.notas, 4000)
  ];

  if (datos.id) {
    const [antes] = await consulta('SELECT dueno FROM ha_cliente WHERE id = ?', [Number(datos.id)]);
    if (!antes || (antes.dueno || '') !== v.mio) throw new ErrorUsuario('Ese cliente no es tuyo: lo cambia quien lo dio de alta.', 403);
    await consulta(
      `UPDATE ha_cliente SET nombre = ?, razon_social = ?, nif = ?, direccion = ?, tarifa_hora = ?,
              telefono = ?, email = ?, contacto = ?, notas = ? WHERE id = ?`,
      [...valores, Number(datos.id)]
    );
  } else {
    const [ya] = await consulta('SELECT id FROM ha_cliente WHERE nombre = ?', [nombre]);
    if (ya) throw new ErrorUsuario('Ya hay un cliente con ese nombre. Si es de otra persona, pídele que te lo comparta.', 409);
    await consulta(
      `INSERT INTO ha_cliente (nombre, razon_social, nif, direccion, tarifa_hora, telefono, email, contacto, notas, dueno)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...valores, v.mio]
    );
  }
  return clientes(usuario);
}

/* Trabajos */

function horasFacturables(minutos, cfg) {
  const minimas = Number(cfg.HORAS_MINIMAS || 1);
  return Math.max(minimas, Math.ceil(Number(minutos || 0) / 60));
}

function tarifaDe(cliente, cfg) {
  return Number(cliente.tarifa_hora) > 0 ? Number(cliente.tarifa_hora) : Number(cfg.TARIFA_HORA || 0);
}

// Tarifa por hora de cada persona (ha_tarifa_persona). Quien trabaja con su propia empresa cobra
// la suya y, si no ha puesto ninguna, 1: la de la ficha del cliente y la general son de quien lleva
// el gestor. En el grupo general manda la del cliente; si no tiene, la de la persona y, si tampoco,
// la general de Ajustes.
const TARIFA_PROPIA_DEFECTO = 1;

async function tarifaPersona(usuario) {
  if (!usuario) return null;
  const [f] = await consulta('SELECT tarifa FROM ha_tarifa_persona WHERE usuario = ?', [usuario]);
  return f && Number(f.tarifa) > 0 ? Number(f.tarifa) : null;
}

async function tarifaPara(autor, cliente, cfg) {
  const propia = await tarifaPersona(autor);
  if ((await vista(autor)).independiente) return propia || TARIFA_PROPIA_DEFECTO;
  if (Number(cliente.tarifa_hora) > 0) return Number(cliente.tarifa_hora);
  return propia || Number(cfg.TARIFA_HORA || 0);
}

async function tarifaVer(usuario) {
  const v = await vista(usuario);
  const propia = await tarifaPersona(usuario);
  const cfg = await config();
  return {
    tarifa: propia,
    independiente: v.independiente,
    seAplica: propia || (v.independiente ? TARIFA_PROPIA_DEFECTO : Number(cfg.TARIFA_HORA || 0)),
    porDefecto: v.independiente ? TARIFA_PROPIA_DEFECTO : Number(cfg.TARIFA_HORA || 0)
  };
}

async function tarifaGuardar(usuario, valor) {
  if (valor === null || valor === '' || valor === undefined) {
    await consulta('DELETE FROM ha_tarifa_persona WHERE usuario = ?', [usuario]);
    return tarifaVer(usuario);
  }
  const t = Number(String(valor).replace(',', '.'));
  if (!(t > 0) || t > 100000) throw new ErrorUsuario('Indica una tarifa mayor que cero.');
  await consulta(
    'INSERT INTO ha_tarifa_persona (usuario, tarifa, actualizada) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE tarifa = VALUES(tarifa), actualizada = UTC_TIMESTAMP()',
    [usuario, redondear(t)]
  );
  return tarifaVer(usuario);
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
async function trabajoDeTiempo({ incidenciaId, notaId, concepto, detalle, minutos, fecha, autor }) {
  const cfg = await config();
  const cliente = await clientePorDefecto(autor || '');
  const horas = horasFacturables(minutos, cfg);
  const tarifa = await tarifaPara(autor, cliente, cfg);
  const momento = fecha || new Date();

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, incidencia_id, nota_id, concepto, detalle, dia,
                             minutos, horas, tarifa, importe, tipo, estado, autor, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TIEMPO', 'CERRADA', ?, UTC_TIMESTAMP())`,
    [await codigoLibre('SES', momento), cliente.id, incidenciaId, notaId || null, texto(concepto, 255),
      texto(detalle, 20000), diaLocal(momento), minutos, horas, tarifa, redondear(horas * tarifa), autor || null]
  );
}

async function gastoCrear(datos, autor) {
  const concepto = texto(datos.concepto, 255);
  const importe = Number(String(datos.importe || '').replace(',', '.'));
  if (!concepto) throw new ErrorUsuario('Indica el concepto.');
  if (!importe || importe <= 0) throw new ErrorUsuario('Indica un importe mayor que cero.');

  const cliente = await clientePorId(datos.clienteId, autor || '');
  const dia = esDia(datos.dia) ? datos.dia : diaLocal();

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, concepto, detalle, dia, importe, tipo, estado, autor, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, 'UNICO', 'CERRADA', ?, UTC_TIMESTAMP())`,
    [await codigoLibre('COB'), cliente.id, concepto, texto(datos.detalle, 20000), dia, redondear(importe), autor || null]
  );
}

// Quién ve qué horas y cobros. Quien tiene su propia empresa de Sindri (ha_sindri_persona) es
// independiente: lo suyo es solo suyo. Lo de los demás es del grupo general (''). Cada uno ve lo de
// su grupo y lo de quien le haya dejado verlo (ha_compartir); nadie más ve lo que cobra otro.
// Un trabajo que ya está en un pedido de Sindri es de la empresa que lo tiene.
function grupoDe(t, independientes) {
  const pedido = t.sindri_pedido !== undefined ? t.sindri_pedido : t.sindriPedido;
  if (pedido) return t.sindri_empresa || '';
  return t.autor && independientes.has(t.autor) ? t.autor : '';
}

// Qué comparte cada uno con quién (ha_compartir): 'horas' (verlas con su importe), 'clientes'
// (usarlos en sus trabajos) e 'incidencias' (verlas y trabajar en ellas; las horas que apunte
// cada uno van a su empresa). dueno '' = el grupo general.
const COMPARTIBLE = ['horas', 'clientes', 'incidencias'];

async function vista(usuario) {
  const independientes = new Set((await consulta('SELECT usuario FROM ha_sindri_persona')).map(f => f.usuario));
  const mio = usuario && independientes.has(usuario) ? usuario : '';
  const filas = await consulta('SELECT dueno, que FROM ha_compartir WHERE usuario = ?', [usuario || '']);
  const de = {};
  COMPARTIBLE.forEach(q => { de[q] = new Set([mio, ...filas.filter(f => f.que === q).map(f => f.dueno)]); });
  return {
    mio,
    independiente: Boolean(mio),
    grupo: t => grupoDe(t, independientes),
    ve: t => de.horas.has(grupoDe(t, independientes)),
    esMio: t => grupoDe(t, independientes) === mio,
    veDe: (que, dueno) => de[que].has(dueno || '')
  };
}

// Qué comparte uno y con quién, y qué le comparten a él.
async function permisos(usuario) {
  const v = await vista(usuario);
  const dejo = await consulta('SELECT usuario, que FROM ha_compartir WHERE dueno = ? ORDER BY usuario, que', [v.mio]);
  const meDejan = await consulta('SELECT dueno, que FROM ha_compartir WHERE usuario = ? ORDER BY dueno, que', [usuario]);
  return {
    independiente: v.independiente,
    dejo: dejo.map(f => ({ usuario: f.usuario, que: f.que })),
    meDejan: meDejan.map(f => ({ de: f.dueno || 'general', que: f.que }))
  };
}

async function permisoGuardar(usuario, otro, que, ver) {
  const v = await vista(usuario);
  const o = texto(otro, 100);
  if (!COMPARTIBLE.includes(que)) throw new ErrorUsuario('Elige qué compartir.');
  if (!o) throw new ErrorUsuario('Indica el usuario.');
  if (o === usuario) throw new ErrorUsuario('Lo tuyo ya lo ves tú.');
  if (ver) {
    await consulta('INSERT IGNORE INTO ha_compartir (dueno, usuario, que, creado_en) VALUES (?, ?, ?, UTC_TIMESTAMP())', [v.mio, o, que]);
  } else {
    await consulta('DELETE FROM ha_compartir WHERE dueno = ? AND usuario = ? AND que = ?', [v.mio, o, que]);
  }
  return permisos(usuario);
}

// usuario: solo lo que ve esa persona. Sin usuario, todo (uso interno).
async function trabajos(filtros, usuario) {
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
            t.horas, t.tarifa, t.importe, t.tipo, t.estado, t.pago_id AS pagoId, t.sindri_pedido AS sindriPedido,
            t.sindri_empresa, t.autor, c.nombre AS cliente
       FROM ha_trabajo t JOIN ha_cliente c ON c.id = t.cliente_id
      ${donde.length ? 'WHERE ' + donde.join(' AND ') : ''}
      ORDER BY t.dia DESC, t.id DESC`,
    params
  );

  const ocupados = await trabajosOcupados();
  const v = usuario !== undefined ? await vista(usuario) : null;
  return filas
    .filter(f => !v || v.ve(f))
    .map(({ sindri_empresa, ...f }) => ({ ...f, deOtro: Boolean(v && !v.esMio({ ...f, sindri_empresa })), situacion: situacionDe(f, ocupados.get(Number(f.id))) }));
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

async function trabajoEstado(id, estado, usuario) {
  if (['CERRADA', 'NO_COBRAR'].indexOf(estado) === -1) throw new ErrorUsuario('Estado no válido.');

  const [trabajo] = await consulta('SELECT id, pago_id, sindri_pedido, sindri_empresa, autor FROM ha_trabajo WHERE id = ?', [Number(id) || 0]);
  if (!trabajo) throw new ErrorUsuario('Trabajo no encontrado.', 404);
  // Lo de otro, aunque te deje verlo, solo lo cambia él.
  if (usuario !== undefined && !(await vista(usuario)).esMio(trabajo)) throw new ErrorUsuario('Ese trabajo no es tuyo.', 403);
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
  clientes, clienteGuardar, COMPARTIBLE,
  trabajoDeTiempo, gastoCrear, trabajos, trabajoEstado, trabajosOcupados,
  grupoDe, vista, permisos, permisoGuardar, tarifaVer, tarifaGuardar
};
