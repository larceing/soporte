// Recorre los grafos de estados del portal y comprueba cada transición,
// permitida o prohibida, contra una instancia en marcha.
//
// CREA DATOS (incidencias y sesiones): se ejecuta solo en
// desarrollo, con copia previa de la base de datos para restaurarla después.
//
//   BASE=http://localhost:8090 USUARIO=admin CLAVE=... node tests/casuistica.js

const BASE = process.env.BASE || 'http://localhost:8090';

let cookie = '';
let pasan = 0;
const fallos = [];

async function api(metodo, ruta, cuerpo, opciones) {
  const o = opciones || {};
  const cabeceras = { ...(o.cabeceras || {}) };
  if (!o.sinCookie && cookie) cabeceras.Cookie = cookie;
  if (cuerpo !== undefined && !o.crudo) cabeceras['Content-Type'] = 'application/json';

  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cabeceras,
    body: cuerpo === undefined ? undefined : (o.crudo ? cuerpo : JSON.stringify(cuerpo)),
    redirect: 'manual'
  });
  const texto = await r.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch (e) { datos = texto; }
  return { status: r.status, datos: datos, cabeceras: r.headers };
}

function comprobar(nombre, condicion, detalle) {
  if (condicion) { pasan++; return; }
  fallos.push(nombre + (detalle !== undefined ? ' -> ' + JSON.stringify(detalle).slice(0, 220) : ''));
}

// Espera un código HTTP y, si es un error, que traiga un mensaje legible.
function espera(nombre, r, status) {
  const ok = r.status === status && (status < 400 || (r.datos && typeof r.datos.error === 'string' && r.datos.error.length > 3));
  comprobar(nombre + ' [' + status + ']', ok, { status: r.status, datos: r.datos });
  return r.datos;
}

const HOY = new Date().toISOString().slice(0, 10);
const nueva = async (extra) => (await api('POST', '/api/incidencias', { tipo: 'Incidencia', titulo: 'Prueba ' + Date.now() + Math.random(), descripcion: 'x', ...extra })).datos;

async function acceso() {
  espera('sin sesión: API', await api('GET', '/api/incidencias', undefined, { sinCookie: true }), 401);
  comprobar('sin sesión: página lleva a login', (await api('GET', '/', undefined, { sinCookie: true })).status === 302);
  comprobar('sin sesión: código de la app protegido', (await api('GET', '/js/app.js', undefined, { sinCookie: true })).status === 302);
  espera('login con clave mala', await api('POST', '/api/login', { usuario: process.env.USUARIO, clave: 'mala' }, { cabeceras: { 'X-Forwarded-For': '10.9.9.1' } }), 401);
  espera('login con usuario inexistente', await api('POST', '/api/login', { usuario: 'nadie', clave: 'x' }, { cabeceras: { 'X-Forwarded-For': '10.9.9.1' } }), 401);
  espera('login sin cuerpo', await api('POST', '/api/login', {}, { cabeceras: { 'X-Forwarded-For': '10.9.9.1' } }), 401);

  // Bloqueo por intentos desde una misma dirección.
  for (let i = 0; i < 5; i++) await api('POST', '/api/login', { usuario: 'x', clave: 'x' }, { cabeceras: { 'X-Forwarded-For': '10.9.9.2' } });
  espera('bloqueo tras 5 intentos', await api('POST', '/api/login', { usuario: process.env.USUARIO, clave: process.env.CLAVE }, { cabeceras: { 'X-Forwarded-For': '10.9.9.2' } }), 429);

  const r = await api('POST', '/api/login', { usuario: process.env.USUARIO, clave: process.env.CLAVE });
  espera('login correcto', r, 200);
  cookie = (r.cabeceras.get('set-cookie') || '').split(';')[0];
  comprobar('cookie HttpOnly y SameSite', /HttpOnly/i.test(r.cabeceras.get('set-cookie')) && /SameSite=Lax/i.test(r.cabeceras.get('set-cookie')));

  espera('cambio sin JSON (CSRF)', await api('POST', '/api/incidencias', 'titulo=x', { crudo: true, cabeceras: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 415);
  espera('JSON mal formado', await api('POST', '/api/incidencias', '{mal', { crudo: true, cabeceras: { 'Content-Type': 'application/json' } }), 400);
  espera('ruta inexistente', await api('GET', '/api/no-existe'), 404);
  espera('clave: actual incorrecta', await api('POST', '/api/cuenta/clave', { actual: 'mala', nueva: 'unaclavelarga123' }), 400);
  espera('clave: nueva corta', await api('POST', '/api/cuenta/clave', { actual: process.env.CLAVE, nueva: 'corta' }), 400);

  // Una sesión cerrada deja de valer.
  const otra = await api('POST', '/api/login', { usuario: process.env.USUARIO, clave: process.env.CLAVE });
  const cookieOtra = (otra.cabeceras.get('set-cookie') || '').split(';')[0];
  await api('POST', '/api/logout', {}, { sinCookie: true, cabeceras: { Cookie: cookieOtra } });
  espera('cookie tras cerrar sesión', await api('GET', '/api/yo', undefined, { sinCookie: true, cabeceras: { Cookie: cookieOtra } }), 401);
  espera('cookie inventada', await api('GET', '/api/yo', undefined, { sinCookie: true, cabeceras: { Cookie: 'ha_sesion=' + 'a'.repeat(64) } }), 401);
}

async function incidencias() {
  espera('alta sin título', await api('POST', '/api/incidencias', { titulo: '   ' }), 400);
  espera('alta con prioridad inventada', await api('POST', '/api/incidencias', { titulo: 'x', prioridad: 'maxima' }), 400);
  espera('alta con fecha límite mala', await api('POST', '/api/incidencias', { titulo: 'x', limite: '31/12/2026' }), 400);

  const largo = await api('POST', '/api/incidencias', { titulo: 'T'.repeat(500), descripcion: '<script>alert(1)</script> ñ € 😀', tipo: 'Otro', prioridad: 'urgent', limite: '2026-12-31' });
  espera('alta con título largo, HTML y tipo desconocido', largo, 201);
  comprobar('título recortado a 120', largo.datos.titulo.length === 120);
  comprobar('tipo desconocido cae en Incidencia', largo.datos.tipo === 'Incidencia');
  comprobar('HTML, acentos, símbolos y emojis intactos', largo.datos.descripcion === '<script>alert(1)</script> ñ € 😀', largo.datos.descripcion);

  // Emojis en títulos, notas, nombres de fichero e historial.
  const emo = await api('POST', '/api/incidencias', { titulo: 'Servidor caído 🔥🚒', descripcion: 'Urge 👨‍👩‍👧 &#x41; &amp; fin' });
  comprobar('emojis en el título y texto parecido a un código intacto',
    emo.datos.titulo === 'Servidor caído 🔥🚒' && emo.datos.descripcion === 'Urge 👨‍👩‍👧 &#x41; &amp; fin', [emo.datos.titulo, emo.datos.descripcion]);
  const emoNota = await api('POST', '/api/incidencias/' + emo.datos.id + '/notas', { texto: 'Hecho ✅ 🎉', minutos: 5 });
  comprobar('emojis en una nota y en el concepto de su sesión',
    emoNota.datos.notas[0].texto === 'Hecho ✅ 🎉' && emoNota.datos.sesiones[0].concepto === 'Servidor caído 🔥🚒', emoNota.datos.sesiones);
  const emoCambio = await api('PATCH', '/api/incidencias/' + emo.datos.id, { titulo: 'Resuelto 🟢' });
  comprobar('emojis en el historial de cambios',
    emoCambio.datos.titulo === 'Resuelto 🟢' && emoCambio.datos.cambios.some(c => c.antes === 'Servidor caído 🔥🚒' && c.despues === 'Resuelto 🟢'), emoCambio.datos.cambios);
  const emoLista = (await api('GET', '/api/incidencias')).datos.find(i => i.id === emo.datos.id);
  comprobar('emojis en el listado', emoLista && emoLista.titulo === 'Resuelto 🟢', emoLista && emoLista.titulo);
  const emoLargo = await api('POST', '/api/incidencias', { titulo: '🔥'.repeat(60), descripcion: 'x' });
  comprobar('título solo de emojis: se recorta por caracteres enteros',
    emoLargo.status === 201 && /^(🔥)+$/u.test(emoLargo.datos.titulo) && emoLargo.datos.titulo.length > 0, emoLargo.datos.titulo);
  const emoFichero = await api('POST', '/api/incidencias/' + emo.datos.id + '/adjuntos', { nombre: 'captura 📎.txt', contenido: Buffer.from('x').toString('base64') });
  comprobar('emojis en el nombre de un fichero', emoFichero.status === 201 && emoFichero.datos.adjuntos[0].nombre === 'captura 📎.txt', emoFichero.datos.adjuntos);
  comprobar('prioridad y límite guardados', largo.datos.prioridad === 'urgent' && largo.datos.limite === '2026-12-31', largo.datos);

  for (const id of ['999999', 'abc', '0', '-1', '1.5', '1e3']) {
    espera('ficha de id ' + id, await api('GET', '/api/incidencias/' + id), 404);
  }
  espera('cambio en incidencia inexistente', await api('PATCH', '/api/incidencias/999999', { estado: 'resolved' }), 404);

  // Grafo de estados: toda transición entre los cinco estados elegibles.
  const estados = ['new', 'assigned', 'feedback', 'resolved', 'closed'];
  const abiertos = { new: true, assigned: true, feedback: true, resolved: false, closed: false };
  for (const desde of estados) {
    for (const hasta of estados) {
      const inc = await nueva();
      if (desde !== 'new') await api('PATCH', '/api/incidencias/' + inc.id, { estado: desde });
      const r = await api('PATCH', '/api/incidencias/' + inc.id, { estado: hasta });
      comprobar('estado ' + desde + ' -> ' + hasta,
        r.status === 200 && r.datos.estado === hasta && r.datos.abierta === abiertos[hasta], { status: r.status, estado: r.datos.estado, abierta: r.datos.abierta, error: r.datos.error });
    }
  }

  const inc = await nueva();
  espera('estado inventado', await api('PATCH', '/api/incidencias/' + inc.id, { estado: 'borrada' }), 400);
  espera('estado no elegible', await api('PATCH', '/api/incidencias/' + inc.id, { estado: 'confirmed' }), 400);
  espera('título vacío', await api('PATCH', '/api/incidencias/' + inc.id, { titulo: '' }), 400);
  espera('descripción vacía', await api('PATCH', '/api/incidencias/' + inc.id, { descripcion: ' ' }), 400);
  espera('tipo inventado', await api('PATCH', '/api/incidencias/' + inc.id, { tipo: 'Otro' }), 400);
  espera('límite malo', await api('PATCH', '/api/incidencias/' + inc.id, { limite: 'mañana' }), 400);

  const sinCambios = await api('PATCH', '/api/incidencias/' + inc.id, {});
  comprobar('guardar sin cambios no falla', sinCambios.status === 200);
  const todo = await api('PATCH', '/api/incidencias/' + inc.id, { titulo: 'Nuevo', descripcion: 'Otra', tipo: 'Petición', prioridad: 'high', limite: '2026-11-30', estado: 'feedback' });
  comprobar('cambio de todos los campos a la vez', todo.status === 200 && todo.datos.titulo === 'Nuevo' && todo.datos.tipo === 'Petición' &&
    todo.datos.prioridad === 'high' && todo.datos.limite === '2026-11-30' && todo.datos.estado === 'feedback', todo.datos);
  comprobar('el código pasa a PET al cambiar el tipo', todo.datos.codigo.indexOf('PET_') === 0, todo.datos.codigo);
  const quitar = await api('PATCH', '/api/incidencias/' + inc.id, { limite: '' });
  comprobar('quitar la fecha límite', quitar.status === 200 && quitar.datos.limite === '', quitar.datos.limite);
  comprobar('el historial recoge los cambios', quitar.datos.cambios.length >= 6, quitar.datos.cambios.length);

  // Notas
  espera('nota vacía', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: '  ' }), 400);
  espera('nota con minutos negativos y sin texto', await api('POST', '/api/incidencias/' + inc.id + '/notas', { minutos: -5 }), 400);
  espera('nota con más de 24 h', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'x', minutos: 1441 }), 400);
  espera('nota en incidencia inexistente', await api('POST', '/api/incidencias/999999/notas', { texto: 'x' }), 404);
  const conTiempo = espera('nota con tiempo', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'trabajo', minutos: 61 }), 201);
  comprobar('la nota con tiempo crea sesión de 2 h', conTiempo.sesiones.length === 1 && Number(conTiempo.sesiones[0].horas) >= 2 && conTiempo.minutos === 61, conTiempo.sesiones);
  espera('nota con minutos en texto', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'x', minutos: 'abc' }), 201);

  await api('PATCH', '/api/incidencias/' + inc.id, { estado: 'resolved' });
  espera('tiempo en incidencia resuelta', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'x', minutos: 10 }), 409);
  espera('nota sin tiempo en incidencia resuelta', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'aclaración' }), 201);

  // Adjuntos
  espera('adjunto sin contenido', await api('POST', '/api/incidencias/' + inc.id + '/adjuntos', { nombre: 'a.txt' }), 400);
  espera('adjunto que no es base64', await api('POST', '/api/incidencias/' + inc.id + '/adjuntos', { nombre: 'a.txt', contenido: '<<<>>>' }), 400);
  const adj = espera('adjunto correcto con nombre raro', await api('POST', '/api/incidencias/' + inc.id + '/adjuntos', { nombre: '../..\\etc/pass:wd?.txt', contenido: Buffer.from('hola').toString('base64') }), 201);
  comprobar('nombre de adjunto saneado', adj.adjuntos.length === 1 && !/[\\/:?]/.test(adj.adjuntos[0].nombre), adj.adjuntos);
  const descarga = await api('GET', '/api/incidencias/' + inc.id + '/adjuntos/' + adj.adjuntos[0].id);
  comprobar('descarga de adjunto', descarga.status === 200 && descarga.datos === 'hola', descarga.status);
  espera('adjunto inexistente', await api('GET', '/api/incidencias/' + inc.id + '/adjuntos/999999'), 404);
  espera('adjunto demasiado grande', await api('POST', '/api/incidencias/' + inc.id + '/adjuntos', { nombre: 'g.bin', contenido: 'A'.repeat(16 * 1024 * 1024) }), 413);
}

async function cronometro() {
  await api('POST', '/api/cronometro/descartar', {});
  espera('parar sin cronómetro', await api('POST', '/api/cronometro/parar', { texto: 'x' }), 409);
  espera('iniciar en incidencia inexistente', await api('POST', '/api/cronometro/iniciar', { incidenciaId: 999999 }), 404);
  espera('iniciar sin indicar incidencia', await api('POST', '/api/cronometro/iniciar', {}), 404);

  const a = await nueva();
  const b = await nueva();
  const cerrada = await nueva();
  await api('PATCH', '/api/incidencias/' + cerrada.id, { estado: 'resolved' });
  espera('iniciar en incidencia resuelta', await api('POST', '/api/cronometro/iniciar', { incidenciaId: cerrada.id }), 409);

  espera('iniciar', await api('POST', '/api/cronometro/iniciar', { incidenciaId: a.id }), 201);
  comprobar('iniciar pone la incidencia en curso', (await api('GET', '/api/incidencias/' + a.id)).datos.estado === 'assigned');
  espera('iniciar con otro en marcha', await api('POST', '/api/cronometro/iniciar', { incidenciaId: b.id }), 409);
  espera('resolver con su cronómetro en marcha', await api('PATCH', '/api/incidencias/' + a.id, { estado: 'resolved' }), 409);
  espera('cerrar con su cronómetro en marcha', await api('PATCH', '/api/incidencias/' + a.id, { estado: 'closed' }), 409);
  comprobar('resolver otra incidencia con cronómetro ajeno', (await api('PATCH', '/api/incidencias/' + b.id, { estado: 'resolved' })).status === 200);

  const parar = espera('parar', await api('POST', '/api/cronometro/parar', { texto: 'hecho' }), 200);
  comprobar('parar crea una sesión pendiente', parar.incidencia.sesiones.length === 1 && parar.incidencia.sesiones[0].situacion.clave === 'PENDIENTE', parar.incidencia.sesiones);
  comprobar('tras parar no hay cronómetro', (await api('GET', '/api/cronometro')).datos === null);
  espera('parar dos veces', await api('POST', '/api/cronometro/parar', { texto: 'x' }), 409);

  // Descartar no deja rastro.
  await api('POST', '/api/cronometro/iniciar', { incidenciaId: a.id });
  await api('POST', '/api/cronometro/descartar', {});
  comprobar('descartar no crea sesión', (await api('GET', '/api/incidencias/' + a.id)).datos.sesiones.length === 1);
  comprobar('descartar sin cronómetro no falla', (await api('POST', '/api/cronometro/descartar', {})).status === 200);

  // Dos arranques a la vez: solo uno entra y el otro recibe un 409 limpio.
  const c = await nueva();
  const d = await nueva();
  const carrera = await Promise.all([
    api('POST', '/api/cronometro/iniciar', { incidenciaId: c.id }),
    api('POST', '/api/cronometro/iniciar', { incidenciaId: d.id })
  ]);
  comprobar('dos arranques simultáneos: uno 201 y otro 409', carrera.map(r => r.status).sort().join() === '201,409', carrera.map(r => [r.status, r.datos.error]));
  await api('POST', '/api/cronometro/descartar', {});

  // No se puede resolver una incidencia con su cronómetro en marcha.
  const e = await nueva();
  await api('POST', '/api/cronometro/iniciar', { incidenciaId: e.id });
  espera('resolver con su cronómetro en marcha', await api('PATCH', '/api/incidencias/' + e.id, { estado: 'resolved' }), 409);
  await api('POST', '/api/cronometro/descartar', {});
}

async function horas() {
  const gasto = (importe, dia) => api('POST', '/api/trabajos/gasto', { concepto: 'Gasto prueba', importe: importe, dia: dia || '2030-06-15' });
  const pendientes = async () => (await api('GET', '/api/trabajos?cobro=PENDIENTE&desde=2030-01-01&hasta=2030-12-31')).datos;

  espera('gasto sin concepto', await api('POST', '/api/trabajos/gasto', { importe: 5 }), 400);
  espera('gasto con importe cero', await gasto(0), 400);
  espera('gasto con importe negativo', await gasto(-3), 400);
  espera('gasto con importe en texto', await gasto('abc'), 400);
  espera('gasto con coma decimal', await gasto('10,50'), 201);
  espera('segundo gasto', await gasto(20), 201);

  const pend = await pendientes();
  comprobar('los dos gastos quedan pendientes', pend.length === 2 && pend.reduce((s, t) => s + Number(t.importe), 0) === 30.5, pend);
  const [t1] = pend;

  // Grafo del trabajo: PENDIENTE <-> NO_COBRAR
  espera('trabajo: estado inventado', await api('POST', '/api/trabajos/' + t1.id + '/estado', { estado: 'BORRADO' }), 400);
  espera('trabajo inexistente', await api('POST', '/api/trabajos/999999/estado', { estado: 'NO_COBRAR' }), 404);
  espera('trabajo -> no se factura', await api('POST', '/api/trabajos/' + t1.id + '/estado', { estado: 'NO_COBRAR' }), 200);
  comprobar('lo que no se factura sale del pendiente', (await pendientes()).length === 1);
  espera('trabajo -> volver a facturar', await api('POST', '/api/trabajos/' + t1.id + '/estado', { estado: 'CERRADA' }), 200);

  // Los cobros y documentos ya no existen en el gestor.
  espera('sin cobros', await api('GET', '/api/cobros/pendiente?desde=2030-01-01&hasta=2030-12-31'), 404);
  espera('sin documentos', await api('GET', '/api/documentos'), 404);
}

// Reabrir una incidencia: el tiempo nuevo es otra sesión pendiente.
async function reapertura() {
  const inc = await nueva();
  await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'primera sesión', minutos: 30 });
  await api('PATCH', '/api/incidencias/' + inc.id, { estado: 'resolved' });
  espera('reabrir', await api('PATCH', '/api/incidencias/' + inc.id, { estado: 'assigned' }), 200);
  const ficha = espera('nuevo tiempo tras reabrir', await api('POST', '/api/incidencias/' + inc.id + '/notas', { texto: 'segunda sesión', minutos: 20 }), 201);
  comprobar('dos sesiones pendientes', ficha.sesiones.length === 2 && ficha.sesiones.every(s => s.situacion.clave === 'PENDIENTE'), ficha.sesiones);
}

(async () => {
  const bloques = { acceso, incidencias, cronometro, horas, reapertura };
  for (const nombre of Object.keys(bloques)) {
    const antes = pasan + fallos.length;
    try {
      await bloques[nombre]();
    } catch (e) {
      fallos.push(nombre + ': EXCEPCIÓN ' + (e.stack || e.message).split('\n').slice(0, 2).join(' | '));
    }
    console.log(nombre.padEnd(14) + (pasan + fallos.length - antes) + ' comprobaciones');
  }

  console.log('\nPASAN ' + pasan + ' · FALLAN ' + fallos.length);
  fallos.forEach(f => console.log('  ✗ ' + f));
  process.exit(fallos.length ? 1 : 0);
})();
