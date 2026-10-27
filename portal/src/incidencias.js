// Las incidencias del portal: tablas ha_incidencia, ha_nota, ha_adjunto y
// ha_cambio de la base de datos del portal. Sustituye a MantisBT, que se usaba
// solo como almacén por su API (mantis.js queda para copiar lo que tenía; ver
// migrar-mantis.js). Lo que devuelve tiene la misma forma que antes, así que
// el resto del portal no cambia.

const { consulta, pool } = require('./db');
const { servicioDe } = require('./servicios');

const PROYECTO = process.env.PROYECTO || process.env.MANTIS_PROJECT || 'SPSIL';

// "elegible" marca los que se ofrecen al cambiar el seguimiento; el resto
// vienen de MantisBT y se muestran si una incidencia antigua los tiene.
const ESTADOS = [
  { nombre: 'new', texto: 'Nueva', elegible: true },
  { nombre: 'feedback', texto: 'Esperando al cliente', elegible: true },
  { nombre: 'acknowledged', texto: 'Aceptada', elegible: false },
  { nombre: 'confirmed', texto: 'Confirmada', elegible: false },
  { nombre: 'assigned', texto: 'En curso', elegible: true },
  { nombre: 'resolved', texto: 'Resuelta', elegible: true },
  { nombre: 'closed', texto: 'Cerrada', elegible: true }
];

const PRIORIDADES = [
  { nombre: 'none', texto: 'Ninguna', elegible: false },
  { nombre: 'low', texto: 'Baja', elegible: true },
  { nombre: 'normal', texto: 'Normal', elegible: true },
  { nombre: 'high', texto: 'Alta', elegible: true },
  { nombre: 'urgent', texto: 'Urgente', elegible: true },
  { nombre: 'immediate', texto: 'Inmediata', elegible: false }
];

const CERRADAS = ['resolved', 'closed'];

class ErrorIncidencia extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.status = status;
  }
}

// Mientras no se han copiado las incidencias de MantisBT, no se sirve nada:
// mejor un aviso que una lista vacía o números que chocan.
let bloqueo = null;
function bloquear(motivo) { bloqueo = motivo; }
function comprobarListo() {
  if (bloqueo) throw new ErrorIncidencia(bloqueo, 503);
}

function textoDe(lista, nombre) {
  const encontrado = lista.find(x => x.nombre === nombre);
  return encontrado ? encontrado.texto : nombre;
}

function idValido(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new ErrorIncidencia('Incidencia no encontrada.', 404);
  return n;
}

const iso = (fecha) => (fecha instanceof Date ? fecha : new Date(fecha)).toISOString();

// "2026-11-30" -> "30/11/2026", como se ve en el historial.
const diaLegible = (dia) => dia ? dia.split('-').reverse().join('/') : '';

// INC_SPSIL_AAAAMMDD o PET_SPSIL_AAAAMMDD, con el día de Madrid en que se abrió.
function codigo(tipo, fecha) {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(fecha).replace(/-/g, '');
  return (/^pet/i.test(tipo) ? 'PET' : 'INC') + '_' + PROYECTO + '_' + dia;
}

function base(fila) {
  return {
    id: fila.id,
    codigo: fila.codigo,
    tipo: fila.tipo,
    titulo: fila.titulo,
    estado: fila.estado,
    estadoTexto: textoDe(ESTADOS, fila.estado),
    abierta: !CERRADAS.includes(fila.estado),
    prioridad: fila.prioridad,
    prioridadTexto: textoDe(PRIORIDADES, fila.prioridad),
    limite: fila.limite || '',
    servicio: fila.servicio_sku || '',
    servicioAuto: servicioDe(fila.titulo, fila.tipo).sku,
    dueno: fila.dueno || '',
    clienteId: fila.cliente_id || null,
    creada: iso(fila.creada),
    actualizada: iso(fila.actualizada),
    minutos: Number(fila.minutos) || 0
  };
}

async function listar() {
  comprobarListo();
  const filas = await consulta(
    `SELECT i.*,
       (SELECT COALESCE(SUM(minutos), 0) FROM ha_nota n WHERE n.incidencia_id = i.id) AS minutos,
       (SELECT COUNT(*) FROM ha_nota n WHERE n.incidencia_id = i.id) AS num_notas,
       (SELECT COUNT(*) FROM ha_adjunto a WHERE a.incidencia_id = i.id) AS num_adjuntos
     FROM ha_incidencia i ORDER BY i.actualizada DESC, i.id DESC`
  );
  return filas.map(f => ({ ...base(f), numNotas: Number(f.num_notas), numAdjuntos: Number(f.num_adjuntos) }));
}

async function obtener(id) {
  comprobarListo();
  const n = idValido(id);
  const [fila] = await consulta('SELECT * FROM ha_incidencia WHERE id = ?', [n]);
  if (!fila) throw new ErrorIncidencia('Incidencia no encontrada.', 404);

  const notas = await consulta('SELECT id, texto, minutos, fecha, autor FROM ha_nota WHERE incidencia_id = ? ORDER BY fecha, id', [n]);
  const adjuntos = await consulta('SELECT id, nombre, bytes, fecha FROM ha_adjunto WHERE incidencia_id = ? ORDER BY fecha, id', [n]);
  const cambios = await consulta('SELECT fecha, campo, antes, despues FROM ha_cambio WHERE incidencia_id = ? ORDER BY fecha, id', [n]);

  return {
    ...base({ ...fila, minutos: notas.reduce((s, x) => s + x.minutos, 0) }),
    descripcion: fila.descripcion,
    notas: notas.map(x => ({ id: x.id, texto: x.texto, minutos: x.minutos, fecha: iso(x.fecha), autor: x.autor })),
    adjuntos: adjuntos.map(x => ({ id: x.id, nombre: x.nombre, bytes: x.bytes, fecha: iso(x.fecha) })),
    cambios: cambios.map(x => ({ fecha: iso(x.fecha), campo: x.campo, antes: x.antes, despues: x.despues }))
  };
}

// Todo lo que cambia una incidencia va en una transacción: la fila, su
// historial y la fecha de última actividad, o nada.
async function enTransaccion(trabajo) {
  const con = await pool.getConnection();
  try {
    await con.beginTransaction();
    const resultado = await trabajo(con);
    await con.commit();
    return resultado;
  } catch (e) {
    await con.rollback().catch(() => {});
    throw e;
  } finally {
    con.release();
  }
}

const anotar = (con, id, campo, antes, despues) => con.query(
  'INSERT INTO ha_cambio (incidencia_id, fecha, campo, antes, despues) VALUES (?, UTC_TIMESTAMP(), ?, ?, ?)',
  [id, campo, antes, despues]);

const tocar = (con, id) => con.query('UPDATE ha_incidencia SET actualizada = UTC_TIMESTAMP() WHERE id = ?', [id]);

async function crear({ tipo, titulo, descripcion, prioridad, limite, autor, dueno, clienteId }) {
  const ahora = new Date();
  const id = await enTransaccion(async con => {
    const [r] = await con.query(
      `INSERT INTO ha_incidencia (codigo, tipo, titulo, descripcion, estado, prioridad, limite, autor, dueno, cliente_id, creada, actualizada)
       VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [codigo(tipo, ahora), tipo, titulo, descripcion || titulo, prioridad || 'normal', limite || null, autor || '', dueno || '', clienteId || null]
    );
    await anotar(con, r.insertId, 'Alta', '', 'Incidencia creada');
    return r.insertId;
  });
  return obtener(id);
}

// Cambia solo lo que venga informado y deja cada cambio en el historial.
async function actualizar(id, cambios) {
  const actual = await obtener(id);
  const campos = [];
  const historial = [];

  const cambia = (clave) => cambios[clave] !== undefined && cambios[clave] !== actual[clave];

  if (cambia('titulo')) {
    campos.push(['titulo', cambios.titulo]);
    historial.push(['Título', actual.titulo, cambios.titulo]);
  }
  if (cambia('descripcion')) {
    campos.push(['descripcion', cambios.descripcion]);
    historial.push(['Descripción', '', 'Modificada']);
  }
  if (cambia('tipo')) {
    campos.push(['tipo', cambios.tipo]);
    // El código empieza por INC o PET según el tipo.
    campos.push(['codigo', actual.codigo.replace(/^[A-Z]+_/, (/^pet/i.test(cambios.tipo) ? 'PET' : 'INC') + '_')]);
    historial.push(['Tipo', actual.tipo, cambios.tipo]);
  }
  if (cambia('prioridad')) {
    campos.push(['prioridad', cambios.prioridad]);
    historial.push(['Prioridad', actual.prioridadTexto, textoDe(PRIORIDADES, cambios.prioridad)]);
  }
  if (cambia('limite')) {
    campos.push(['limite', cambios.limite || null]);
    historial.push(['Fecha límite', diaLegible(actual.limite), diaLegible(cambios.limite) || 'Sin fecha']);
  }
  if (cambia('servicio')) {
    campos.push(['servicio_sku', cambios.servicio || null]);
    historial.push(['Servicio', actual.servicio || 'Automático', cambios.servicio || 'Automático']);
  }
  if (cambia('clienteId')) {
    campos.push(['cliente_id', cambios.clienteId || null]);
    historial.push(['Cliente', cambios.clienteAntes || 'Por defecto', cambios.clienteNombre || 'Por defecto']);
  }
  if (cambia('estado')) {
    campos.push(['estado', cambios.estado]);
    historial.push(['Estado', actual.estadoTexto, textoDe(ESTADOS, cambios.estado)]);
  }

  if (!campos.length) return actual;

  await enTransaccion(async con => {
    await con.query(
      'UPDATE ha_incidencia SET ' + campos.map(c => c[0] + ' = ?').join(', ') + ', actualizada = UTC_TIMESTAMP() WHERE id = ?',
      [...campos.map(c => c[1]), actual.id]
    );
    for (const h of historial) await anotar(con, actual.id, ...h);
  });
  return obtener(actual.id);
}

// fecha: cuándo acabó el trabajo, si no es ahora (una sesión apuntada con sus horas).
async function anadirNota(id, { texto, minutos, autor, fecha }) {
  const actual = await obtener(id);
  const notaId = await enTransaccion(async con => {
    const [r] = await con.query(
      'INSERT INTO ha_nota (incidencia_id, texto, minutos, autor, fecha) VALUES (?, ?, ?, ?, ' + (fecha ? '?' : 'UTC_TIMESTAMP()') + ')',
      [actual.id, texto || '', Math.max(0, Math.round(Number(minutos) || 0)), autor || ''].concat(fecha ? [fecha] : [])
    );
    await tocar(con, actual.id);
    return r.insertId;
  });
  return { notaId, incidencia: await obtener(actual.id) };
}

// El contenido llega en base64 desde la pantalla.
async function adjuntar(id, nombre, contenidoBase64, autor) {
  const actual = await obtener(id);
  const contenido = Buffer.from(contenidoBase64, 'base64');
  await enTransaccion(async con => {
    await con.query(
      'INSERT INTO ha_adjunto (incidencia_id, nombre, bytes, contenido, autor, fecha) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
      [actual.id, nombre, contenido.length, contenido, autor || '']
    );
    await tocar(con, actual.id);
  });
  return obtener(actual.id);
}

async function adjunto(id, adjuntoId) {
  comprobarListo();
  const [fila] = await consulta('SELECT nombre, contenido FROM ha_adjunto WHERE id = ? AND incidencia_id = ?',
    [idValido(adjuntoId), idValido(id)]);
  if (!fila) throw new ErrorIncidencia('Adjunto no encontrado.', 404);
  return { nombre: fila.nombre || 'adjunto', contenido: fila.contenido };
}

module.exports = {
  ErrorIncidencia, ESTADOS, PRIORIDADES, CERRADAS, bloquear,
  listar, obtener, crear, actualizar, anadirNota, adjuntar, adjunto, enTransaccion, anotar, tocar
};
