const path = require('path');
const express = require('express');
const db = require('./src/db');
const auth = require('./src/auth');
const api = require('./src/api');
const resumen = require('./src/resumen');

const PUBLICO = path.join(__dirname, 'public');
const app = express();

app.disable('x-powered-by');
// En producción va detrás de Nginx Proxy Manager.
app.set('trust proxy', 1);

const SOLO_HTTPS = process.env.PORTAL_COOKIE_SECURE === '1';

app.use((req, res, next) => {
  // En producción nada viaja sin cifrar, lo fuerce o no el proxy.
  if (SOLO_HTTPS) {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(308, 'https://' + req.headers.host + req.originalUrl);
    }
    res.set('Strict-Transport-Security', 'max-age=31536000');
  }

  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store'
  });
  next();
});

// Los adjuntos viajan en base64 dentro del JSON: solo esa ruta admite cuerpos grandes.
app.use(/^\/api\/incidencias\/\d+\/adjuntos$/, express.json({ limit: '15mb' }));
app.use(express.json({ limit: '200kb' }));

// Los cambios solo se aceptan como JSON: un formulario de otra web no puede
// enviarlo, y junto con la cookie SameSite cierra el paso al CSRF.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Formato no admitido.' });
  }
  next();
});

// Lo único visible sin sesión: la pantalla de entrada y sus estilos.
app.use('/css', express.static(path.join(PUBLICO, 'css')));
app.use('/img', express.static(path.join(PUBLICO, 'img')));

app.get('/login', async (req, res) => {
  if (await auth.usuarioDeSesion(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLICO, 'login.html'));
});

app.get('/restablecer', (req, res) => res.sendFile(path.join(PUBLICO, 'restablecer.html')));

app.post('/api/login', (req, res, next) => auth.iniciarSesion(req, res).catch(next));
app.post('/api/recuperar', (req, res, next) => auth.pedirRecuperacion(req, res).catch(next));
app.post('/api/restablecer', (req, res, next) => auth.restablecer(req, res).catch(next));
app.post('/api/logout', (req, res, next) => auth.cerrarSesion(req, res).catch(next));

app.use('/api', (req, res, next) => auth.requiereSesion(req, res, next).catch(next), api);

app.use('/js', (req, res, next) => auth.requiereSesionPagina(req, res, next).catch(next),
  express.static(path.join(PUBLICO, 'js')));

app.get('/', (req, res, next) => auth.requiereSesionPagina(req, res, next).catch(next), (req, res) => {
  res.sendFile(path.join(PUBLICO, 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'No encontrado.' }));

app.use((err, req, res, next) => {
  // Errores conocidos que no son fallos del servidor.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'La petición no se entiende.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El contenido es demasiado grande.' });
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe un registro igual. Recarga y vuelve a intentarlo.' });

  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Error interno. Vuelve a intentarlo.' : err.message });
});

async function arrancar() {
  // La base de datos puede tardar unos segundos en aceptar conexiones.
  for (let intento = 1; ; intento++) {
    try {
      await db.migrar();
      break;
    } catch (e) {
      if (intento >= 30) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await auth.asegurarAdmin();
  await auth.asegurarEmailAdmin();

  const puerto = Number(process.env.PORT) || 3000;
  app.listen(puerto, () => console.log('Portal escuchando en el puerto ' + puerto));
  resumen.programar();
}

arrancar().catch(e => {
  console.error(e);
  process.exit(1);
});
