const express = require('express');
const { consulta } = require('./db');
const mantis = require('./mantis');
const fact = require('./facturacion');
const auth = require('./auth');
const { documentoHtml } = require('./documento-html');
const resumen = require('./resumen');
const correo = require('./correo');
const { ErrorUsuario, texto, ruta, esDia } = require('./util');

const router = express.Router();
const TIPOS = ['Incidencia', 'Petición'];
const MAX_ADJUNTO = 10 * 1024 * 1024;

async function cronometroDe(usuarioId) {
  const filas = await consulta(
    'SELECT incidencia_id AS incidenciaId, titulo, inicio FROM ha_cronometro WHERE usuario_id = ?',
    [usuarioId]
  );
  return filas[0] || null;
}

const elegibles = lista => lista.filter(x => x.elegible).map(x => x.nombre);

// La ficha lleva también sus sesiones de trabajo con la situación de cobro.
async function conSesiones(incidencia) {
  return { ...incidencia, sesiones: await fact.trabajos({ incidenciaId: incidencia.id }) };
}

// Guarda una nota en MantisBT y, si lleva tiempo, la sesión facturable. El
// tiempo solo se registra en incidencias abiertas: si ya está resuelta hay que
// reabrirla, y así el seguimiento refleja que se volvió a trabajar en ella.
async function registrarNota(incidenciaId, nota, minutos) {
  if (minutos > 0) {
    const previa = await mantis.obtener(incidenciaId);
    if (!previa.abierta) {
      throw new ErrorUsuario('La incidencia está ' + previa.estadoTexto.toLowerCase() +
        '. Reábrela para registrar más tiempo.', 409);
    }
    if (minutos > 24 * 60) throw new ErrorUsuario('Una sesión no puede superar las 24 horas.');
  }

  const { notaId, incidencia } = await mantis.anadirNota(incidenciaId, { texto: nota, minutos: minutos });

  if (minutos > 0) {
    await fact.trabajoDeTiempo({
      incidenciaId: incidencia.id,
      notaId: notaId,
      concepto: incidencia.titulo,
      detalle: nota,
      minutos: minutos
    });
  }
  return incidencia;
}

/* Cuenta */

router.get('/yo', ruta(async (req, res) => {
  res.json({ usuario: req.usuario.usuario, rol: req.usuario.rol });
}));

router.get('/cuenta', ruta(async (req, res) => {
  res.json(await auth.cuenta(req));
}));

router.put('/cuenta/email', ruta(async (req, res) => {
  res.json(await auth.guardarEmail(req, req.body.email));
}));

router.post('/cuenta/correo-prueba', ruta(async (req, res) => {
  res.json(await auth.correoDePrueba(req));
}));

// Envía ahora el resumen mensual al correo de la cuenta.
router.post('/cuenta/resumen', ruta(async (req, res) => {
  const datos = await auth.cuenta(req);
  if (!datos.email) throw new ErrorUsuario('Guarda antes un correo en tu cuenta.');

  const resultado = await resumen.enviar(datos.email);
  if (!resultado.enviado) throw new ErrorUsuario(resultado.motivo, 502);
  res.json({ ok: true, para: datos.email });
}));

router.post('/cuenta/clave', ruta(async (req, res) => {
  await auth.cambiarClave(req, String(req.body.actual || ''), String(req.body.nueva || ''));
  res.json({ ok: true });
}));

/* Incidencias */

router.get('/catalogo', ruta(async (req, res) => {
  res.json({ tipos: TIPOS, estados: mantis.ESTADOS, prioridades: mantis.PRIORIDADES });
}));

router.get('/incidencias', ruta(async (req, res) => {
  res.json(await mantis.listar());
}));

router.post('/incidencias', ruta(async (req, res) => {
  const tipo = TIPOS.includes(req.body.tipo) ? req.body.tipo : TIPOS[0];
  const titulo = texto(req.body.titulo, 120);
  if (!titulo) throw new ErrorUsuario('Escribe un título.');

  const prioridad = req.body.prioridad || 'normal';
  if (!elegibles(mantis.PRIORIDADES).includes(prioridad)) throw new ErrorUsuario('Prioridad no válida.');
  if (req.body.limite && !esDia(req.body.limite)) throw new ErrorUsuario('Fecha límite no válida.');

  res.status(201).json(await conSesiones(await mantis.crear({
    tipo: tipo,
    titulo: titulo,
    descripcion: texto(req.body.descripcion, 20000),
    prioridad: prioridad,
    limite: req.body.limite || ''
  })));
}));

router.get('/incidencias/:id', ruta(async (req, res) => {
  res.json(await conSesiones(await mantis.obtener(req.params.id)));
}));

// Seguimiento: título, descripción, tipo, estado, prioridad y fecha límite.
// Solo cambia lo que venga en la petición.
router.patch('/incidencias/:id', ruta(async (req, res) => {
  const b = req.body || {};
  const cambios = {};

  if (b.titulo !== undefined) {
    cambios.titulo = texto(b.titulo, 120);
    if (!cambios.titulo) throw new ErrorUsuario('El título no puede quedar vacío.');
  }
  if (b.descripcion !== undefined) {
    cambios.descripcion = texto(b.descripcion, 20000);
    if (!cambios.descripcion) throw new ErrorUsuario('La descripción no puede quedar vacía.');
  }
  if (b.tipo !== undefined) {
    if (!TIPOS.includes(b.tipo)) throw new ErrorUsuario('Tipo no válido.');
    cambios.tipo = b.tipo;
  }
  if (b.estado !== undefined) {
    if (!elegibles(mantis.ESTADOS).includes(b.estado)) throw new ErrorUsuario('Estado no válido.');
    cambios.estado = b.estado;
  }
  if (b.prioridad !== undefined) {
    if (!elegibles(mantis.PRIORIDADES).includes(b.prioridad)) throw new ErrorUsuario('Prioridad no válida.');
    cambios.prioridad = b.prioridad;
  }
  if (b.limite !== undefined) {
    if (b.limite && !esDia(b.limite)) throw new ErrorUsuario('Fecha límite no válida.');
    cambios.limite = b.limite || '';
  }

  // No se resuelve ni se cierra con el cronómetro en marcha sobre ella.
  if (cambios.estado === 'resolved' || cambios.estado === 'closed') {
    const activo = await cronometroDe(req.usuario.id);
    if (activo && Number(activo.incidenciaId) === Number(req.params.id)) {
      throw new ErrorUsuario('Para el cronómetro antes de dar la incidencia por terminada.', 409);
    }
  }

  res.json(await conSesiones(await mantis.actualizar(req.params.id, cambios)));
}));

router.post('/incidencias/:id/notas', ruta(async (req, res) => {
  const nota = texto(req.body.texto, 20000);
  const minutos = Math.max(0, Math.round(Number(req.body.minutos) || 0));
  if (!nota && !minutos) throw new ErrorUsuario('Escribe una nota o indica el tiempo.');

  res.status(201).json(await conSesiones(await registrarNota(req.params.id, nota, minutos)));
}));

router.post('/incidencias/:id/adjuntos', ruta(async (req, res) => {
  const nombre = texto(req.body.nombre, 200).replace(/[\\/:*?"<>|]/g, '_');
  const contenido = String(req.body.contenido || '');
  if (!nombre || !contenido) throw new ErrorUsuario('Elige un fichero.');
  if (contenido.length * 0.75 > MAX_ADJUNTO) throw new ErrorUsuario('El fichero supera los 10 MB.');

  if (!/^[A-Za-z0-9+/]+=*$/.test(contenido)) throw new ErrorUsuario('El fichero no ha llegado bien. Vuelve a intentarlo.');

  res.status(201).json(await conSesiones(await mantis.adjuntar(req.params.id, nombre, contenido)));
}));

router.get('/incidencias/:id/adjuntos/:adjuntoId', ruta(async (req, res) => {
  const fichero = await mantis.adjunto(req.params.id, req.params.adjuntoId);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fichero.nombre)
  });
  res.send(fichero.contenido);
}));

/* Cronómetro */

router.get('/cronometro', ruta(async (req, res) => {
  res.json(await cronometroDe(req.usuario.id));
}));

router.post('/cronometro/iniciar', ruta(async (req, res) => {
  if (await cronometroDe(req.usuario.id)) {
    throw new ErrorUsuario('Ya hay un cronómetro en marcha. Páralo antes de empezar otro.', 409);
  }

  let incidencia = await mantis.obtener(req.body.incidenciaId);
  if (!incidencia.abierta) {
    throw new ErrorUsuario('La incidencia está ' + incidencia.estadoTexto.toLowerCase() +
      '. Reábrela para seguir trabajando en ella.', 409);
  }
  // Empezar a trabajar en una incidencia nueva la pone en curso.
  if (incidencia.estado === 'new') {
    incidencia = await mantis.actualizar(incidencia.id, { estado: 'assigned' });
  }

  await consulta(
    'INSERT INTO ha_cronometro (usuario_id, incidencia_id, titulo, inicio) VALUES (?, ?, ?, UTC_TIMESTAMP())',
    [req.usuario.id, incidencia.id, incidencia.titulo.slice(0, 255)]
  );
  res.status(201).json(await cronometroDe(req.usuario.id));
}));

// Parar guarda el tiempo como nota de la incidencia: es la sesión de trabajo.
router.post('/cronometro/parar', ruta(async (req, res) => {
  const activo = await cronometroDe(req.usuario.id);
  if (!activo) throw new ErrorUsuario('No hay ningún cronómetro en marcha.', 409);

  // Un cronómetro olvidado no puede generar una sesión de días: se limita a
  // 24 horas y se avisa para que se corrija a mano si hace falta.
  const reales = Math.max(1, Math.ceil((Date.now() - new Date(activo.inicio).getTime()) / 60000));
  const minutos = Math.min(reales, 24 * 60);

  let incidencia;
  try {
    incidencia = await registrarNota(activo.incidenciaId, texto(req.body.texto, 20000), minutos);
  } catch (err) {
    // Si la incidencia ya no existe o se cerró por otro lado, el cronómetro
    // no debe quedarse bloqueado para siempre.
    if (err.status === 404 || err.status === 409) {
      await consulta('DELETE FROM ha_cronometro WHERE usuario_id = ?', [req.usuario.id]);
      throw new ErrorUsuario('No se ha podido guardar el tiempo (' + minutos + ' min): ' + err.message +
        ' El cronómetro se ha detenido.', 409);
    }
    throw err;
  }

  await consulta('DELETE FROM ha_cronometro WHERE usuario_id = ?', [req.usuario.id]);
  res.json({ minutos: minutos, recortado: reales > minutos, incidencia: await conSesiones(incidencia) });
}));

router.post('/cronometro/descartar', ruta(async (req, res) => {
  await consulta('DELETE FROM ha_cronometro WHERE usuario_id = ?', [req.usuario.id]);
  res.json({ ok: true });
}));

/* Correo escrito a mano */

// Valida lo que llega de la pantalla de redacción y lo deja listo para enviar.
function correoDe(cuerpo, exigirDestino) {
  const para = String(cuerpo.para || '').split(/[,;\s]+/).map(p => p.trim()).filter(p => p);
  const asunto = texto(cuerpo.asunto, 200);
  const mensaje = texto(cuerpo.mensaje, 20000);
  const botonUrl = texto(cuerpo.botonUrl, 500);

  if (exigirDestino) {
    if (!para.length) throw new ErrorUsuario('Indica al menos un destinatario.');
    if (para.length > 10) throw new ErrorUsuario('Como máximo 10 destinatarios por correo.');
    const malo = para.find(p => !correo.emailValido(p));
    if (malo) throw new ErrorUsuario('Esta dirección no es válida: ' + malo);
    if (!asunto) throw new ErrorUsuario('Escribe el asunto.');
    if (!mensaje) throw new ErrorUsuario('Escribe el mensaje.');
  }
  if (botonUrl && !/^https?:\/\//i.test(botonUrl)) throw new ErrorUsuario('El enlace del botón debe empezar por http:// o https://');

  return {
    para: para,
    asunto: asunto,
    mensaje: mensaje,
    boton: botonUrl ? { url: botonUrl, texto: texto(cuerpo.botonTexto, 60) || 'Abrir' } : null
  };
}

router.post('/correo/vista', ruta(async (req, res) => {
  const c = correoDe(req.body || {}, false);
  res.json({ html: correo.htmlPersonal({ asunto: c.asunto || 'Asunto', mensaje: c.mensaje || 'Escribe aquí tu mensaje.', boton: c.boton }) });
}));

router.post('/correo/enviar', ruta(async (req, res) => {
  const c = correoDe(req.body || {}, true);

  // Si va ligado a una incidencia, tiene que existir antes de enviar nada.
  const incidenciaId = req.body.incidenciaId ? (await mantis.obtener(req.body.incidenciaId)).id : null;

  const resultado = await correo.personal(c);
  if (!resultado.enviado) throw new ErrorUsuario(resultado.motivo, 502);

  await consulta(
    'INSERT INTO ha_correo (usuario_id, incidencia_id, para, asunto, mensaje, enviado_en) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [req.usuario.id, incidenciaId, c.para.join(', '), c.asunto, c.mensaje]
  );

  // El correo queda anotado en la incidencia como parte de su documentación.
  let anotado = true;
  if (incidenciaId) {
    try {
      await mantis.anadirNota(incidenciaId, {
        texto: 'Correo enviado a ' + c.para.join(', ') + '\nAsunto: ' + c.asunto + '\n\n' + c.mensaje,
        minutos: 0
      });
    } catch (e) {
      anotado = false;
    }
  }

  res.status(201).json({ ok: true, para: c.para, anotado: anotado });
}));

router.get('/correo/enviados', ruta(async (req, res) => {
  res.json(await consulta(
    'SELECT id, incidencia_id AS incidenciaId, para, asunto, mensaje, enviado_en AS enviadoEn FROM ha_correo ORDER BY id DESC LIMIT 100'
  ));
}));

/* Ajustes */

router.get('/config', ruta(async (req, res) => {
  res.json(await fact.config());
}));

router.put('/config', ruta(async (req, res) => {
  res.json(await fact.configGuardar(req.body || {}));
}));

router.get('/clientes', ruta(async (req, res) => {
  res.json(await fact.clientes());
}));

router.post('/clientes', ruta(async (req, res) => {
  res.json(await fact.clienteGuardar(req.body || {}));
}));

/* Trabajos y cobros */

router.get('/trabajos', ruta(async (req, res) => {
  res.json(await fact.trabajos(req.query));
}));

router.post('/trabajos/gasto', ruta(async (req, res) => {
  await fact.gastoCrear(req.body || {});
  res.status(201).json({ ok: true });
}));

router.post('/trabajos/:id/estado', ruta(async (req, res) => {
  await fact.trabajoEstado(req.params.id, req.body.estado);
  res.json({ ok: true });
}));

router.get('/cobros/pendiente', ruta(async (req, res) => {
  res.json(await fact.pendiente(req.query));
}));

router.post('/cobros/cobrar', ruta(async (req, res) => {
  await fact.cobrarPeriodo(req.body || {});
  res.json({ ok: true });
}));

router.get('/pagos', ruta(async (req, res) => {
  res.json(await fact.pagos());
}));

/* Proformas y facturas */

router.get('/documentos', ruta(async (req, res) => {
  res.json(await fact.documentos());
}));

router.post('/documentos/resumen', ruta(async (req, res) => {
  res.status(201).json(await fact.resumenCrear(req.body || {}));
}));

router.post('/documentos/proforma', ruta(async (req, res) => {
  res.status(201).json(await fact.proformaCrear(req.body || {}));
}));

router.post('/documentos/:id/anular', ruta(async (req, res) => {
  res.json(await fact.proformaAnular(req.params.id));
}));

router.post('/documentos/:id/facturar', ruta(async (req, res) => {
  res.status(201).json(await fact.facturaEmitir(req.params.id));
}));

router.post('/documentos/:id/rectificar', ruta(async (req, res) => {
  res.status(201).json(await fact.facturaRectificar(req.params.id, req.body.motivo));
}));

router.post('/documentos/:id/cobrar', ruta(async (req, res) => {
  res.json(await fact.facturaCobrar(req.params.id));
}));

router.get('/documentos/:id', ruta(async (req, res) => {
  res.json(await fact.documentoDetalle(req.params.id));
}));

router.get('/documentos/:id/pdf', ruta(async (req, res) => {
  const pdf = await fact.documentoPdf(req.params.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + pdf.nombre + '"' });
  res.send(pdf.contenido);
}));

// Los documentos históricos solo existen como PDF original.
router.get('/documentos/:id/imprimir', ruta(async (req, res) => {
  const doc = await fact.documento(req.params.id);
  if (doc.estado === 'HISTORICO') return res.redirect('/api/documentos/' + doc.id + '/pdf');
  res.type('html').send(documentoHtml(doc, req.prefijo));
}));

module.exports = router;
