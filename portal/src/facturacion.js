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

// Hora de inicio y fin de una sesión, tal como llegan de la pantalla (instantes ISO). Una sesión
// dura de 1 minuto a 24 horas y no acaba en el futuro.
const MAX_SESION_MIN = 24 * 60;

function tramoValido(inicio, fin) {
  const a = new Date(inicio || '');
  const b = new Date(fin || '');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) throw new ErrorUsuario('Indica la hora de inicio y la de fin.');
  a.setSeconds(0, 0);
  b.setSeconds(0, 0);
  const minutos = Math.round((b - a) / 60000);
  if (minutos < 1) throw new ErrorUsuario('La hora de fin tiene que ser posterior a la de inicio.');
  if (minutos > MAX_SESION_MIN) throw new ErrorUsuario('Una sesión no puede superar las 24 horas. Si trabajaste dos días, apunta dos sesiones.');
  if (b.getTime() > Date.now() + 5 * 60000) throw new ErrorUsuario('La sesión no puede acabar en el futuro.');
  return { inicio: a, fin: b, minutos };
}

// '26/10/2026 09:45 – 27/10/2026 02:00 (16 h 15 min)', en hora de España, para el historial.
function tramoTexto(inicio, fin, minutos) {
  const f = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const h = Math.floor(minutos / 60);
  const duracion = (h ? h + ' h ' : '') + (minutos % 60) + ' min';
  return (inicio ? f.format(new Date(inicio)) + ' – ' : '') + (fin ? f.format(new Date(fin)) : '') + ' (' + duracion + ')';
}

// Sesión de trabajo: cada una se redondea a horas enteras con el mínimo
// configurado, como hacía el gestor antiguo. inicio y fin: cuándo fue; si no
// vienen, acabó ahora y duró sus minutos. Cuenta en el día en que empezó.
async function trabajoDeTiempo({ incidenciaId, notaId, concepto, detalle, minutos, inicio, fin, autor }) {
  const cfg = await config();
  // El cliente de la incidencia; si no tiene, el de quien trabaja. Compartir la incidencia
  // comparte también a quién se cobra.
  const [inc] = incidenciaId ? await consulta('SELECT cliente_id FROM ha_incidencia WHERE id = ?', [incidenciaId]) : [];
  const [delaIncidencia] = inc && inc.cliente_id ? await consulta('SELECT * FROM ha_cliente WHERE id = ?', [inc.cliente_id]) : [];
  const cliente = delaIncidencia || await clientePorDefecto(autor || '');
  const horas = horasFacturables(minutos, cfg);
  const tarifa = await tarifaPara(autor, cliente, cfg);
  const hasta = fin ? new Date(fin) : new Date();
  const desde = inicio ? new Date(inicio) : new Date(hasta.getTime() - Number(minutos || 0) * 60000);

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, incidencia_id, nota_id, concepto, detalle, dia,
                             minutos, horas, tarifa, importe, tipo, estado, autor, inicio, fin, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TIEMPO', 'CERRADA', ?, ?, ?, UTC_TIMESTAMP())`,
    [await codigoLibre('SES', desde), cliente.id, incidenciaId, notaId || null, texto(concepto, 255),
      texto(detalle, 20000), diaLocal(desde), minutos, horas, tarifa, redondear(horas * tarifa), autor || null,
      desde, hasta]
  );
}

// Corrige una sesión de trabajo: su hora de inicio y de fin y lo que se hizo. Se recalculan el
// tiempo, las horas facturables, el importe (con la tarifa que ya tenía) y el día, y la nota de la
// incidencia cambia con ella. Lo que ya está cobrado, facturado o en un pedido de Sindri no se toca.
async function trabajoEditar(id, datos, usuario) {
  const [t] = await consulta(
    `SELECT id, tipo, incidencia_id, nota_id, detalle, minutos, tarifa, inicio, fin, pago_id,
            sindri_pedido, sindri_empresa, autor FROM ha_trabajo WHERE id = ?`, [Number(id) || 0]);
  if (!t) throw new ErrorUsuario('Sesión no encontrada.', 404);
  if (t.tipo !== 'TIEMPO') throw new ErrorUsuario('Solo se cambian las horas de las sesiones de trabajo.', 409);
  if (usuario !== undefined && !(await vista(usuario)).esMio(t)) throw new ErrorUsuario('Esa sesión no es tuya: la cambia quien la apuntó.', 403);
  if (t.pago_id) throw new ErrorUsuario('No se puede cambiar una sesión ya cobrada.', 409);
  if (t.sindri_pedido) throw new ErrorUsuario('No se puede cambiar: la sesión está en el pedido ' + t.sindri_pedido + ' de Sindri.', 409);
  const doc = (await trabajosOcupados()).get(t.id);
  if (doc) throw new ErrorUsuario('No se puede cambiar: la sesión está en ' + doc.codigo + '.', 409);

  const { inicio, fin, minutos } = tramoValido(datos.inicio, datos.fin);
  const detalle = datos.texto === undefined ? t.detalle : texto(datos.texto, 20000);
  const horas = horasFacturables(minutos, await config());
  const importe = redondear(horas * Number(t.tarifa));

  // Se carga aquí para no crear una dependencia circular al arrancar.
  const incidencias = require('./incidencias');
  await incidencias.enTransaccion(async con => {
    await con.query(
      'UPDATE ha_trabajo SET inicio = ?, fin = ?, minutos = ?, horas = ?, importe = ?, dia = ?, detalle = ? WHERE id = ?',
      [inicio, fin, minutos, horas, importe, diaLocal(inicio), detalle, t.id]);
    if (t.nota_id) {
      await con.query('UPDATE ha_nota SET minutos = ?, fecha = ?, texto = ? WHERE id = ?', [minutos, fin, detalle, t.nota_id]);
    }
    if (t.incidencia_id) {
      const antes = tramoTexto(t.inicio, t.fin, Number(t.minutos));
      const despues = tramoTexto(inicio, fin, minutos);
      if (antes !== despues) await incidencias.anotar(con, t.incidencia_id, 'Sesión', antes, despues);
      await incidencias.tocar(con, t.incidencia_id);
    }
  });
  return { id: t.id, incidenciaId: t.incidencia_id, minutos, horas, importe };
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
            t.horas, t.tarifa, t.importe, t.tipo, t.estado, t.inicio, t.fin, t.pago_id AS pagoId, t.sindri_pedido AS sindriPedido,
            t.sindri_empresa, t.autor, c.nombre AS cliente, p.codigo AS pagoCodigo,
            (p.observaciones LIKE '${MARCA_COBRO}%') AS cobroDeshacible
       FROM ha_trabajo t JOIN ha_cliente c ON c.id = t.cliente_id
       LEFT JOIN ha_pago p ON p.id = t.pago_id
      ${donde.length ? 'WHERE ' + donde.join(' AND ') : ''}
      ORDER BY t.dia DESC, t.id DESC`,
    params
  );

  const ocupados = await trabajosOcupados();
  const v = usuario !== undefined ? await vista(usuario) : null;
  return filas
    .filter(f => !v || v.ve(f))
    .map(({ sindri_empresa, ...f }) => ({ ...f, cobroDeshacible: Boolean(Number(f.cobroDeshacible)), deOtro: Boolean(v && !v.esMio({ ...f, sindri_empresa })), situacion: situacionDe(f, ocupados.get(Number(f.id))) }));
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

// Cobros apuntados a mano en Horas: lo que se cobró fuera de Sindri (p. ej. con el gestor antiguo
// y no llegó al traspaso). Llevan esta marca para poder deshacerlos; los cobros de antes, no.
const MARCA_COBRO = 'Marcado como cobrado en Horas';

async function cobroMarcar(datos, usuario) {
  const ids = [...new Set((Array.isArray(datos.ids) ? datos.ids : []).map(Number).filter(n => n > 0))];
  if (!ids.length) throw new ErrorUsuario('Elige qué sesiones se cobraron.');
  if (ids.length > 500) throw new ErrorUsuario('Como máximo 500 de una vez.');
  if (!esDia(datos.fecha)) throw new ErrorUsuario('Indica la fecha del cobro.');

  const filas = await consulta(
    `SELECT id, cliente_id, dia, importe, estado, pago_id, sindri_pedido, sindri_empresa, autor
       FROM ha_trabajo WHERE id IN (?)`, [ids]);
  if (filas.length !== ids.length) throw new ErrorUsuario('Alguna sesión ya no existe. Recarga la lista.', 404);
  const v = usuario !== undefined ? await vista(usuario) : null;
  if (v && filas.some(t => !v.esMio(t))) throw new ErrorUsuario('Hay sesiones que no son tuyas: las marca quien las apuntó.', 403);
  if (filas.some(t => t.pago_id)) throw new ErrorUsuario('Alguna sesión ya está cobrada.', 409);
  if (filas.some(t => t.estado === 'NO_COBRAR')) throw new ErrorUsuario('Alguna sesión está como «No se factura».', 409);
  if (new Set(filas.map(t => t.cliente_id)).size > 1) throw new ErrorUsuario('Marca juntas solo sesiones del mismo cliente.');

  const importe = redondear(filas.reduce((s, t) => s + Number(t.importe), 0));
  const dias = filas.map(t => t.dia).sort();
  const concepto = texto(datos.concepto, 255) || 'Cobro del ' + dias[0] + ' al ' + dias[dias.length - 1];
  const observaciones = MARCA_COBRO + (usuario ? ' por ' + usuario : '') + '.' + (datos.nota ? ' ' + texto(datos.nota, 2000) : '');
  const codigo = await codigoLibre('PAG');

  const incidencias = require('./incidencias');
  const pagoId = await incidencias.enTransaccion(async con => {
    const [r] = await con.query(
      `INSERT INTO ha_pago (codigo, cliente_id, fecha_pago, periodo_desde, periodo_hasta, importe, metodo, concepto, observaciones, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, UTC_TIMESTAMP())`,
      [codigo, filas[0].cliente_id, datos.fecha, dias[0], dias[dias.length - 1], importe, concepto, observaciones]);
    await con.query('UPDATE ha_trabajo SET pago_id = ? WHERE id IN (?) AND pago_id IS NULL', [r.insertId, ids]);
    return r.insertId;
  });
  return { pagoId, codigo, sesiones: ids.length, importe, enSindri: filas.filter(t => t.sindri_pedido).length };
}

// Deshace un cobro apuntado en Horas: sus sesiones vuelven a donde estaban.
async function cobroDeshacer(pagoId, usuario) {
  const [p] = await consulta('SELECT id, codigo, observaciones FROM ha_pago WHERE id = ?', [Number(pagoId) || 0]);
  if (!p) throw new ErrorUsuario('Cobro no encontrado.', 404);
  if (!String(p.observaciones || '').startsWith(MARCA_COBRO)) throw new ErrorUsuario('Ese cobro viene del gestor antiguo y no se deshace desde aquí.', 409);
  const filas = await consulta('SELECT id, sindri_pedido, sindri_empresa, autor FROM ha_trabajo WHERE pago_id = ?', [p.id]);
  const v = usuario !== undefined ? await vista(usuario) : null;
  if (v && filas.some(t => !v.esMio(t))) throw new ErrorUsuario('Ese cobro tiene sesiones que no son tuyas.', 403);

  const incidencias = require('./incidencias');
  await incidencias.enTransaccion(async con => {
    await con.query('UPDATE ha_trabajo SET pago_id = NULL WHERE pago_id = ?', [p.id]);
    await con.query('DELETE FROM ha_pago WHERE id = ?', [p.id]);
  });
  return { codigo: p.codigo, sesiones: filas.length };
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
  clientes, clienteGuardar, clientePorId, COMPARTIBLE,
  cobroMarcar, cobroDeshacer,
  trabajoDeTiempo, trabajoEditar, tramoValido, MAX_SESION_MIN, gastoCrear, trabajos, trabajoEstado, trabajosOcupados,
  grupoDe, vista, permisos, permisoGuardar, tarifaVer, tarifaGuardar
};
