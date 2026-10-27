const express = require('express');
const { consulta } = require('./db');
const incidencias = require('./incidencias');
const fact = require('./facturacion');
const auth = require('./auth');
const resumen = require('./resumen');
const correo = require('./correo');
const sindri = require('./sindri');
const tareas = require('./tareas');
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

// Cualquier cambio en el portal puede cambiar lo pendiente de facturar o las incidencias: Sindri y
// Tareas se ponen al día unos segundos después (src/sindri.js, src/tareas.js).
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) { sindri.programar(); tareas.programar(); } });
  next();
});

const elegibles = lista => lista.filter(x => x.elegible).map(x => x.nombre);

// La ficha lleva también sus sesiones de trabajo con su situación (pendiente, en un pedido de Sindri...).
// Las sesiones de la incidencia que ve quien pregunta: las suyas y las de quien le deje verlas.
async function conSesiones(incidencia, usuario) {
  return { ...incidencia, sesiones: await fact.trabajos({ incidenciaId: incidencia.id }, usuario || '') };
}

// Lo que es de todos (la conexión general con Sindri, la configuración): no lo cambia quien
// trabaja para su propia empresa.
async function soloGeneral(req) {
  if ((await fact.vista(req.usuario.usuario)).independiente) {
    throw new ErrorUsuario('Esto lo cambia quien lleva el gestor: tú trabajas con tu propia empresa.', 403);
  }
}

// Guarda una nota en la incidencia y, si lleva tiempo, la sesión facturable. El
// tiempo solo se registra en incidencias abiertas: si ya está resuelta hay que
// reabrirla, y así el seguimiento refleja que se volvió a trabajar en ella.
// tramo: { inicio, fin } (Date) si se sabe cuándo fue la sesión; si no, acabó ahora.
async function registrarNota(incidenciaId, nota, minutos, autor, tramo) {
  if (minutos > 0) {
    const previa = await incidencias.obtener(incidenciaId);
    if (!previa.abierta) {
      throw new ErrorUsuario('La incidencia está ' + previa.estadoTexto.toLowerCase() +
        '. Reábrela para registrar más tiempo.', 409);
    }
    if (minutos > fact.MAX_SESION_MIN) throw new ErrorUsuario('Una sesión no puede superar las 24 horas.');
  }

  const fin = tramo ? tramo.fin : null;
  const { notaId, incidencia } = await incidencias.anadirNota(incidenciaId, { texto: nota, minutos: minutos, autor: autor, fecha: fin });

  if (minutos > 0) {
    await fact.trabajoDeTiempo({
      incidenciaId: incidencia.id,
      notaId: notaId,
      concepto: incidencia.titulo,
      detalle: nota,
      minutos: minutos,
      inicio: tramo ? tramo.inicio : null,
      fin: fin,
      autor: autor
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

  const resultado = await resumen.enviar(datos.email, req.usuario.usuario);
  if (!resultado.enviado) throw new ErrorUsuario(resultado.motivo, 502);
  res.json({ ok: true, para: datos.email });
}));

router.post('/cuenta/clave', ruta(async (req, res) => {
  await auth.cambiarClave(req, String(req.body.actual || ''), String(req.body.nueva || ''));
  res.json({ ok: true });
}));

/* Incidencias */

router.get('/catalogo', ruta(async (req, res) => {
  res.json({ tipos: TIPOS, estados: incidencias.ESTADOS, prioridades: incidencias.PRIORIDADES });
}));

// Cada uno ve las incidencias de su grupo y las que le compartan (src/facturacion.js, vista).
router.get('/incidencias', ruta(async (req, res) => {
  const v = await fact.vista(req.usuario.usuario);
  res.json((await incidencias.listar()).filter(i => v.veDe('incidencias', i.dueno)));
}));

// Antes de tocar o enseñar una incidencia: que sea suya o se la hayan compartido.
async function accesoIncidencia(req, id) {
  const [fila] = await consulta('SELECT dueno FROM ha_incidencia WHERE id = ?', [Number(id) || 0]);
  if (fila && !(await fact.vista(req.usuario.usuario)).veDe('incidencias', fila.dueno)) {
    throw new ErrorUsuario('Incidencia no encontrada.', 404);
  }
}
router.all(['/incidencias/:id', '/incidencias/:id/*'], (req, res, next) => {
  accesoIncidencia(req, req.params.id).then(() => next(), next);
});

router.post('/incidencias', ruta(async (req, res) => {
  const tipo = TIPOS.includes(req.body.tipo) ? req.body.tipo : TIPOS[0];
  const titulo = texto(req.body.titulo, 120);
  if (!titulo) throw new ErrorUsuario('Escribe un título.');

  const prioridad = req.body.prioridad || 'normal';
  if (!elegibles(incidencias.PRIORIDADES).includes(prioridad)) throw new ErrorUsuario('Prioridad no válida.');
  if (req.body.limite && !esDia(req.body.limite)) throw new ErrorUsuario('Fecha límite no válida.');

  res.status(201).json(await conSesiones(await incidencias.crear({
    tipo: tipo,
    titulo: titulo,
    descripcion: texto(req.body.descripcion, 20000),
    prioridad: prioridad,
    limite: req.body.limite || '',
    autor: req.usuario.usuario,
    dueno: (await fact.vista(req.usuario.usuario)).mio,
    clienteId: req.body.clienteId ? (await fact.clientePorId(req.body.clienteId, req.usuario.usuario)).id : null
  }), req.usuario.usuario));
}));

router.get('/incidencias/:id', ruta(async (req, res) => {
  res.json(await conSesiones(await incidencias.obtener(req.params.id), req.usuario.usuario));
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
    if (!elegibles(incidencias.ESTADOS).includes(b.estado)) throw new ErrorUsuario('Estado no válido.');
    cambios.estado = b.estado;
  }
  if (b.prioridad !== undefined) {
    if (!elegibles(incidencias.PRIORIDADES).includes(b.prioridad)) throw new ErrorUsuario('Prioridad no válida.');
    cambios.prioridad = b.prioridad;
  }
  if (b.limite !== undefined) {
    if (b.limite && !esDia(b.limite)) throw new ErrorUsuario('Fecha límite no válida.');
    cambios.limite = b.limite || '';
  }
  // El artículo de Sindri con que se factura; vacío, el que se deduce del título.
  if (b.servicio !== undefined) {
    const sku = String(b.servicio || '').trim();
    if (sku && !/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new ErrorUsuario('Servicio no válido.');
    cambios.servicio = sku;
  }

  // A qué cliente se cobra: uno que vea quien lo elige; vacío, el de quien trabaja.
  if (b.clienteId !== undefined) {
    const antes = (await incidencias.obtener(req.params.id)).clienteId;
    const [viejo] = antes ? await consulta('SELECT nombre FROM ha_cliente WHERE id = ?', [antes]) : [];
    const nuevo = b.clienteId ? await fact.clientePorId(b.clienteId, req.usuario.usuario) : null;
    cambios.clienteId = nuevo ? nuevo.id : null;
    cambios.clienteNombre = nuevo ? nuevo.nombre : '';
    cambios.clienteAntes = viejo ? viejo.nombre : '';
  }

  // No se resuelve ni se cierra con el cronómetro en marcha sobre ella.
  if (cambios.estado === 'resolved' || cambios.estado === 'closed') {
    const activo = await cronometroDe(req.usuario.id);
    if (activo && Number(activo.incidenciaId) === Number(req.params.id)) {
      throw new ErrorUsuario('Para el cronómetro antes de dar la incidencia por terminada.', 409);
    }
  }

  res.json(await conSesiones(await incidencias.actualizar(req.params.id, cambios), req.usuario.usuario));
}));

// Con inicio y fin es una sesión apuntada a mano (la que se olvidó con el cronómetro, por
// ejemplo): el tiempo sale de las dos horas.
router.post('/incidencias/:id/notas', ruta(async (req, res) => {
  const nota = texto(req.body.texto, 20000);
  const tramo = req.body.inicio || req.body.fin ? fact.tramoValido(req.body.inicio, req.body.fin) : null;
  const minutos = tramo ? tramo.minutos : Math.max(0, Math.round(Number(req.body.minutos) || 0));
  if (!nota && !minutos) throw new ErrorUsuario('Escribe una nota o indica el tiempo.');

  res.status(201).json(await conSesiones(await registrarNota(req.params.id, nota, minutos, req.usuario.usuario, tramo), req.usuario.usuario));
}));

router.post('/incidencias/:id/adjuntos', ruta(async (req, res) => {
  const nombre = texto(req.body.nombre, 200).replace(/[\\/:*?"<>|]/g, '_');
  const contenido = String(req.body.contenido || '');
  if (!nombre || !contenido) throw new ErrorUsuario('Elige un fichero.');
  if (contenido.length * 0.75 > MAX_ADJUNTO) throw new ErrorUsuario('El fichero supera los 10 MB.');

  if (!/^[A-Za-z0-9+/]+=*$/.test(contenido)) throw new ErrorUsuario('El fichero no ha llegado bien. Vuelve a intentarlo.');

  res.status(201).json(await conSesiones(await incidencias.adjuntar(req.params.id, nombre, contenido, req.usuario.usuario), req.usuario.usuario));
}));

router.get('/incidencias/:id/adjuntos/:adjuntoId', ruta(async (req, res) => {
  const fichero = await incidencias.adjunto(req.params.id, req.params.adjuntoId);
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

  await accesoIncidencia(req, req.body.incidenciaId);
  let incidencia = await incidencias.obtener(req.body.incidenciaId);
  if (!incidencia.abierta) {
    throw new ErrorUsuario('La incidencia está ' + incidencia.estadoTexto.toLowerCase() +
      '. Reábrela para seguir trabajando en ella.', 409);
  }
  // Empezar a trabajar en una incidencia nueva la pone en curso.
  if (incidencia.estado === 'new') {
    incidencia = await incidencias.actualizar(incidencia.id, { estado: 'assigned' });
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
  const minutos = Math.min(reales, fact.MAX_SESION_MIN);
  const inicio = new Date(activo.inicio);
  const tramo = { inicio: inicio, fin: new Date(inicio.getTime() + minutos * 60000) };

  let incidencia;
  try {
    incidencia = await registrarNota(activo.incidenciaId, texto(req.body.texto, 20000), minutos, req.usuario.usuario, tramo);
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
  res.json({ minutos: minutos, recortado: reales > minutos, incidencia: await conSesiones(incidencia, req.usuario.usuario) });
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
  res.json({ html: await correo.htmlPersonal({ asunto: c.asunto || 'Asunto', mensaje: c.mensaje || 'Escribe aquí tu mensaje.', boton: c.boton }) });
}));

router.post('/correo/enviar', ruta(async (req, res) => {
  const c = correoDe(req.body || {}, true);

  // Si va ligado a una incidencia, tiene que existir antes de enviar nada.
  if (req.body.incidenciaId) await accesoIncidencia(req, req.body.incidenciaId);
  const incidenciaId = req.body.incidenciaId ? (await incidencias.obtener(req.body.incidenciaId)).id : null;

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
      await incidencias.anadirNota(incidenciaId, {
        texto: 'Correo enviado a ' + c.para.join(', ') + '\nAsunto: ' + c.asunto + '\n\n' + c.mensaje,
        minutos: 0,
        autor: req.usuario.usuario
      });
    } catch (e) {
      anotado = false;
    }
  }

  res.status(201).json({ ok: true, para: c.para, anotado: anotado });
}));

router.get('/correo/enviados', ruta(async (req, res) => {
  res.json(await consulta(
    `SELECT id, incidencia_id AS incidenciaId, adjunto, para, asunto, mensaje, enviado_en AS enviadoEn
       FROM ha_correo WHERE usuario_id = ? ORDER BY id DESC LIMIT 100`,
    [req.usuario.id]
  ));
}));

/* Ajustes */

router.get('/config', ruta(async (req, res) => {
  res.json(await fact.config());
}));

router.put('/config', ruta(async (req, res) => {
  await soloGeneral(req);
  res.json(await fact.configGuardar(req.body || {}));
}));

router.get('/clientes', ruta(async (req, res) => {
  res.json(await fact.clientes(req.usuario.usuario));
}));

router.post('/clientes', ruta(async (req, res) => {
  res.json(await fact.clienteGuardar(req.body || {}, req.usuario.usuario));
}));

// Emisor, clientes y tarifa en el formato que importa Sindri (Empresa → Llevar y traer datos).
router.get('/exportar-sindri', ruta(async (req, res) => {
  const { datosParaSindri } = require('./exportar-sindri');
  const clientes = await consulta('SELECT * FROM ha_cliente ORDER BY nombre');
  const v = await fact.vista(req.usuario.usuario);
  const trabajos = (await sindri.trabajosPendientes()).filter(v.esMio);
  const fecha = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="gestor-para-sindri-${fecha}.json"`);
  res.json(datosParaSindri(await fact.config(), clientes, trabajos));
}));

// Envío automático a Sindri: dónde está, su llave (nunca se devuelve) y cómo fue el último envío.
router.get('/sindri', ruta(async (req, res) => {
  res.json(await sindri.estado(req.usuario.usuario));
}));

// La llave propia: las horas de quien la pone van a su empresa de Sindri.
router.put('/sindri/mia', ruta(async (req, res) => {
  const b = req.body || {};
  res.json(await sindri.guardarMia(req.usuario.usuario, { llave: b.llave, quitar: b.quitar === true }));
}));

router.put('/sindri', ruta(async (req, res) => {
  await soloGeneral(req);
  const b = req.body || {};
  res.json(await sindri.guardarConexion({ url: b.url, llave: b.llave, quitar: b.quitar === true }));
}));

// Los servicios que se pueden elegir en una incidencia: los artículos de Sindri si está
// conectado; si no, el catálogo del gestor.
router.get('/sindri/servicios', ruta(async (req, res) => {
  res.json(await sindri.servicios());
}));

router.post('/sindri/enviar', ruta(async (req, res) => {
  await sindri.sincronizar();
  res.json(await sindri.estado(req.usuario.usuario));
}));

// Tareas: dónde está, su llave (nunca se devuelve), el proyecto y cómo fue el último envío.
router.get('/tareas', ruta(async (req, res) => {
  res.json(await tareas.estado());
}));

router.put('/tareas', ruta(async (req, res) => {
  await soloGeneral(req);
  const b = req.body || {};
  res.json(await tareas.guardarConexion({ url: b.url, llave: b.llave, proyecto: b.proyecto, quitar: b.quitar === true }));
}));

router.post('/tareas/enviar', ruta(async (req, res) => {
  await tareas.sincronizar();
  res.json(await tareas.estado());
}));

/* Horas: sesiones de trabajo y gastos */

router.get('/trabajos', ruta(async (req, res) => {
  res.json(await fact.trabajos(req.query, req.usuario.usuario));
}));

// Tu tarifa por hora: la de tus sesiones nuevas.
router.get('/horas/tarifa', ruta(async (req, res) => {
  res.json(await fact.tarifaVer(req.usuario.usuario));
}));

router.put('/horas/tarifa', ruta(async (req, res) => {
  res.json(await fact.tarifaGuardar(req.usuario.usuario, (req.body || {}).tarifa));
}));

// Qué compartes (horas, clientes, incidencias) y con quién, y qué te comparten a ti.
router.get('/compartir', ruta(async (req, res) => {
  res.json(await fact.permisos(req.usuario.usuario));
}));

router.put('/compartir', ruta(async (req, res) => {
  const b = req.body || {};
  res.json(await fact.permisoGuardar(req.usuario.usuario, b.usuario, b.que, b.ver === true));
}));

router.post('/trabajos/gasto', ruta(async (req, res) => {
  await fact.gastoCrear(req.body || {}, req.usuario.usuario);
  res.status(201).json({ ok: true });
}));

// Corregir una sesión: hora de inicio, de fin y lo que se hizo. Devuelve la incidencia al día.
router.put('/trabajos/:id', ruta(async (req, res) => {
  const hecho = await fact.trabajoEditar(req.params.id, req.body || {}, req.usuario.usuario);
  res.json(hecho.incidenciaId
    ? { ...hecho, incidencia: await conSesiones(await incidencias.obtener(hecho.incidenciaId), req.usuario.usuario) }
    : hecho);
}));

// Apuntar como cobradas unas sesiones que se cobraron fuera de Sindri, y deshacerlo.
router.post('/cobros', ruta(async (req, res) => {
  res.status(201).json(await fact.cobroMarcar(req.body || {}, req.usuario.usuario));
}));

router.post('/cobros/:id/deshacer', ruta(async (req, res) => {
  res.json(await fact.cobroDeshacer(req.params.id, req.usuario.usuario));
}));

router.post('/trabajos/:id/estado', ruta(async (req, res) => {
  await fact.trabajoEstado(req.params.id, req.body.estado, req.usuario.usuario);
  res.json({ ok: true });
}));

module.exports = router;
