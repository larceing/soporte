// Única puerta de entrada a MantisBT. El resto del portal no sabe que existe:
// trabaja con "incidencias" ya traducidas al formato propio.

const BASE = (process.env.MANTIS_URL || 'http://web').replace(/\/+$/, '') + '/api/rest';
const TOKEN = process.env.MANTIS_API_TOKEN || '';
const PROYECTO = process.env.MANTIS_PROJECT || 'SPSIL';

// En MantisBT, de "resuelta" (80) en adelante la incidencia ya no está abierta.
const ESTADO_RESUELTA = 80;

// Estados y prioridades de MantisBT con el nombre que se usa en el portal.
// "elegible" marca los que se ofrecen al cambiar el seguimiento; el resto
// existen en MantisBT y se muestran si una incidencia los tiene.
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

const CAMPOS = {
  status: 'Estado', priority: 'Prioridad', summary: 'Título', description: 'Descripción',
  category: 'Tipo', due_date: 'Fecha límite', resolution: 'Resolución', handler: 'Asignada a'
};

class ErrorMantis extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.status = status;
  }
}

async function llamar(metodo, ruta, cuerpo) {
  let respuesta;
  try {
    respuesta = await fetch(BASE + ruta, {
      method: metodo,
      headers: { Authorization: TOKEN, 'Content-Type': 'application/json' },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
  } catch (e) {
    throw new ErrorMantis('No se puede conectar con el motor de incidencias. Inténtalo de nuevo en unos segundos.', 503);
  }

  const texto = await respuesta.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch (e) {
    datos = null;
  }

  if (!respuesta.ok) {
    if (respuesta.status === 404) throw new ErrorMantis('Incidencia no encontrada.', 404);
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw new ErrorMantis('El motor de incidencias rechaza la credencial del portal.', 502);
    }
    throw new ErrorMantis('El motor de incidencias no ha aceptado la operación: ' +
      ((datos && datos.message) || respuesta.statusText), 502);
  }
  return datos;
}

// MantisBT guarda el texto en utf8 de 3 bytes y sustituye por "�" todo lo que
// ocupe 4 (emojis y algunos símbolos; su incidencia #20431). Para no perderlos,
// esos caracteres viajan escritos como &#x1F600; y se reconstruyen al leer.
function codificar(texto) {
  return String(texto == null ? '' : texto).replace(/[\u{10000}-\u{10FFFF}]/gu,
    c => '&#x' + c.codePointAt(0).toString(16).toUpperCase() + ';');
}

function decodificar(texto) {
  return String(texto == null ? '' : texto).replace(/&#x(1[0-9A-F]{4}|10[0-9A-F]{4});/g,
    (todo, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

// El título de MantisBT admite 128 caracteres: si al codificar se pasa, se
// recorta por caracteres enteros para no dejar un código a medias.
function codificarTitulo(titulo) {
  const letras = Array.from(String(titulo || ''));
  while (letras.length && codificar(letras.join('')).length > 128) letras.pop();
  return codificar(letras.join(''));
}

function idValido(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new ErrorMantis('Incidencia no encontrada.', 404);
  return n;
}

function minutosDeDuracion(duracion) {
  const partes = String(duracion || '').split(':');
  if (partes.length !== 2) return 0;
  return Number(partes[0]) * 60 + Number(partes[1]);
}

function duracionDeMinutos(minutos) {
  const m = Math.max(1, Math.round(Number(minutos) || 0));
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function textoDe(lista, nombre, porDefecto) {
  const encontrado = lista.find(x => x.nombre === nombre);
  return encontrado ? encontrado.texto : porDefecto;
}

// INC_SPSIL_AAAAMMDD o PET_SPSIL_AAAAMMDD, la convención que ya se usaba a mano.
function codigo(issue) {
  const tipo = /^pet/i.test((issue.category && issue.category.name) || '') ? 'PET' : 'INC';
  const fecha = String(issue.created_at || '').slice(0, 10).replace(/-/g, '');
  return tipo + '_' + ((issue.project && issue.project.name) || PROYECTO) + '_' + fecha;
}

function aNota(nota) {
  return {
    id: nota.id,
    texto: decodificar(nota.text),
    minutos: nota.time_tracking ? minutosDeDuracion(nota.time_tracking.duration) : 0,
    fecha: nota.created_at,
    autor: (nota.reporter && (nota.reporter.real_name || nota.reporter.name)) || ''
  };
}

function aAdjunto(adjunto) {
  return {
    id: adjunto.id,
    nombre: decodificar(adjunto.filename),
    bytes: Number(adjunto.size) || 0,
    fecha: adjunto.created_at
  };
}

function valorHistorial(campo, valor) {
  if (valor == null) return '';
  if (typeof valor !== 'object') return decodificar(valor);
  if (campo === 'status') return textoDe(ESTADOS, valor.name, valor.label || '');
  if (campo === 'priority') return textoDe(PRIORIDADES, valor.name, valor.label || '');
  return valor.label || valor.real_name || valor.name || '';
}

// Solo los cambios que cuentan como seguimiento: alta y campos modificados.
// Las notas y los ficheros ya se muestran aparte.
function aCambio(h) {
  const tipo = h.type && h.type.name;

  if (tipo === 'issue-new') {
    return { fecha: h.created_at, campo: 'Alta', antes: '', despues: 'Incidencia creada' };
  }
  if (tipo !== 'field-updated' || !h.field) return null;

  const campo = h.field.name;
  // La descripción cambia entera: basta con decir que cambió. La fecha límite
  // llega ya formateada en "change".
  if (campo === 'description') return { fecha: h.created_at, campo: CAMPOS[campo], antes: '', despues: 'Modificada' };
  if (campo === 'due_date') {
    const partes = String(h.change || '').split(' => ');
    return { fecha: h.created_at, campo: CAMPOS[campo], antes: partes[0] || '', despues: partes[1] || 'Sin fecha' };
  }

  return {
    fecha: h.created_at,
    campo: CAMPOS[campo] || h.field.label || campo,
    antes: valorHistorial(campo, h.old_value),
    despues: valorHistorial(campo, h.new_value)
  };
}

function aIncidencia(issue) {
  const notas = (issue.notes || []).map(aNota);
  const estado = (issue.status && issue.status.name) || 'new';
  const prioridad = (issue.priority && issue.priority.name) || 'normal';

  return {
    id: issue.id,
    codigo: codigo(issue),
    tipo: (issue.category && issue.category.name) || '',
    titulo: decodificar(issue.summary),
    descripcion: decodificar(issue.description),
    estado: estado,
    estadoTexto: textoDe(ESTADOS, estado, (issue.status && issue.status.label) || estado),
    abierta: !issue.status || issue.status.id < ESTADO_RESUELTA,
    prioridad: prioridad,
    prioridadTexto: textoDe(PRIORIDADES, prioridad, (issue.priority && issue.priority.label) || prioridad),
    // Día de la fecha límite, sin hora.
    limite: issue.due_date ? String(issue.due_date).slice(0, 10) : '',
    creada: issue.created_at,
    actualizada: issue.updated_at,
    minutos: notas.reduce((suma, n) => suma + n.minutos, 0),
    notas: notas,
    adjuntos: (issue.attachments || []).map(aAdjunto),
    cambios: (issue.history || []).map(aCambio).filter(c => c)
  };
}

let proyectoId = null;

async function idProyecto() {
  if (proyectoId) return proyectoId;

  const datos = await llamar('GET', '/projects');
  const proyecto = (datos.projects || []).find(p => p.name === PROYECTO);
  if (!proyecto) throw new ErrorMantis('No existe el proyecto ' + PROYECTO + ' en el motor de incidencias.', 502);

  proyectoId = proyecto.id;
  return proyectoId;
}

async function listar() {
  const id = await idProyecto();
  const incidencias = [];

  for (let pagina = 1; pagina <= 50; pagina++) {
    const datos = await llamar('GET', '/issues?project_id=' + id + '&page_size=100&page=' + pagina);
    const lote = datos.issues || [];
    incidencias.push(...lote.map(aIncidencia));
    if (lote.length < 100) break;
  }

  // El listado no necesita textos largos ni historial, solo los totales.
  return incidencias.map(i => ({
    ...i, notas: undefined, adjuntos: undefined, cambios: undefined, descripcion: undefined,
    numNotas: i.notas.length, numAdjuntos: i.adjuntos.length
  }));
}

async function obtener(id) {
  const datos = await llamar('GET', '/issues/' + idValido(id));
  const issue = datos.issues && datos.issues[0];
  if (!issue) throw new ErrorMantis('Incidencia no encontrada.', 404);
  if (issue.project && issue.project.name !== PROYECTO) throw new ErrorMantis('Incidencia no encontrada.', 404);
  return aIncidencia(issue);
}

// MantisBT quita la fecha límite con una cadena vacía; con null la conserva.
function fechaLimite(dia) {
  return dia ? dia + 'T12:00:00+00:00' : '';
}

async function crear({ tipo, titulo, descripcion, prioridad, limite }) {
  const cuerpo = {
    summary: codificarTitulo(titulo),
    description: codificar(descripcion || titulo),
    category: { name: tipo },
    project: { name: PROYECTO },
    priority: { name: prioridad || 'normal' }
  };
  if (limite) cuerpo.due_date = fechaLimite(limite);

  const datos = await llamar('POST', '/issues', cuerpo);
  return obtener(datos.issue.id);
}

// Cambia solo lo que venga informado. El estado arrastra la resolución, que es
// como MantisBT distingue una incidencia resuelta de una reabierta.
async function actualizar(id, cambios) {
  const actual = await obtener(id);
  const cuerpo = {};

  if (cambios.titulo !== undefined && cambios.titulo !== actual.titulo) cuerpo.summary = codificarTitulo(cambios.titulo);
  if (cambios.descripcion !== undefined && cambios.descripcion !== actual.descripcion) cuerpo.description = codificar(cambios.descripcion);
  if (cambios.tipo !== undefined && cambios.tipo !== actual.tipo) cuerpo.category = { name: cambios.tipo };
  if (cambios.prioridad !== undefined && cambios.prioridad !== actual.prioridad) cuerpo.priority = { name: cambios.prioridad };
  if (cambios.limite !== undefined && cambios.limite !== actual.limite) cuerpo.due_date = fechaLimite(cambios.limite);

  if (cambios.estado !== undefined && cambios.estado !== actual.estado) {
    const cerrando = cambios.estado === 'resolved' || cambios.estado === 'closed';
    cuerpo.status = { name: cambios.estado };
    if (cerrando && actual.abierta) cuerpo.resolution = { name: 'fixed' };
    if (!cerrando && !actual.abierta) cuerpo.resolution = { name: 'reopened' };
  }

  if (!Object.keys(cuerpo).length) return actual;

  await llamar('PATCH', '/issues/' + actual.id, cuerpo);
  return obtener(actual.id);
}

async function anadirNota(id, { texto, minutos }) {
  const cuerpo = { text: codificar(texto), view_state: { name: 'public' } };
  if (minutos > 0) {
    cuerpo.time_tracking = { duration: duracionDeMinutos(minutos) };
  }
  const datos = await llamar('POST', '/issues/' + idValido(id) + '/notes', cuerpo);
  return { notaId: datos.note.id, incidencia: await obtener(id) };
}

// El contenido viaja en base64, que es como lo pide y lo devuelve MantisBT.
async function adjuntar(id, nombre, contenidoBase64) {
  await llamar('POST', '/issues/' + idValido(id) + '/files', {
    files: [{ name: codificar(nombre), content: contenidoBase64 }]
  });
  return obtener(id);
}

async function adjunto(id, adjuntoId) {
  const datos = await llamar('GET', '/issues/' + idValido(id) + '/files/' + idValido(adjuntoId));
  const fichero = datos.files && datos.files[0];
  if (!fichero) throw new ErrorMantis('Adjunto no encontrado.', 404);

  return {
    nombre: decodificar(fichero.filename) || 'adjunto',
    tipo: fichero.content_type || 'application/octet-stream',
    contenido: Buffer.from(fichero.content || '', 'base64')
  };
}

module.exports = {
  ErrorMantis, ESTADOS, PRIORIDADES,
  listar, obtener, crear, actualizar, anadirNota, adjuntar, adjunto
};
