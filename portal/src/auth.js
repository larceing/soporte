const crypto = require('crypto');
const { consulta } = require('./db');
const correo = require('./correo');
const sso = require('./sso');

const COOKIE = 'ha_sesion';
const DIAS_SESION = 30;
const MAX_FALLOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const MINUTOS_RECUPERACION = 30;
const MAX_RECUPERACIONES = 3;
const CLAVE_MINIMA = 10;

const fallos = new Map();
const recuperaciones = new Map();

function errorUsuario(mensaje, status) {
  return Object.assign(new Error(mensaje), { status: status || 400 });
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(clave, sal, 64);
  return 'scrypt$' + sal.toString('hex') + '$' + hash.toString('hex');
}

function claveCorrecta(clave, guardado) {
  const partes = String(guardado).split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;

  const esperado = Buffer.from(partes[2], 'hex');
  const calculado = crypto.scryptSync(clave, Buffer.from(partes[1], 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function leerCookie(req) {
  const cabecera = req.headers.cookie || '';
  for (const trozo of cabecera.split(';')) {
    const i = trozo.indexOf('=');
    if (i > -1 && trozo.slice(0, i).trim() === COOKIE) {
      return trozo.slice(i + 1).trim();
    }
  }
  return '';
}

// La cookie vale solo para la ruta del portal (/soporte/ en el servidor DEV/PRO).
function rutaCookie(req) {
  return (req.prefijo || '') + '/';
}

function opcionesCookie(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.PORTAL_COOKIE_SECURE === '1',
    path: rutaCookie(req),
    maxAge: DIAS_SESION * 24 * 60 * 60 * 1000
  };
}

// Crea el primer usuario a partir del entorno si la tabla está vacía.
async function asegurarAdmin() {
  // Con Keycloak no hay usuario local: cada uno se crea al entrar por primera vez.
  if (sso.activo()) return;
  const [{ total }] = await consulta('SELECT COUNT(*) AS total FROM ha_usuario');
  if (total > 0) return;

  const usuario = process.env.PORTAL_ADMIN_USER;
  const clave = process.env.PORTAL_ADMIN_PASSWORD;
  if (!usuario || !clave) {
    console.warn('Sin usuarios y sin PORTAL_ADMIN_USER / PORTAL_ADMIN_PASSWORD: nadie podrá entrar.');
    return;
  }

  await consulta(
    'INSERT INTO ha_usuario (usuario, clave_hash, rol, email, creado_en) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
    [usuario, hashClave(clave), 'admin', process.env.PORTAL_ADMIN_EMAIL || '']
  );
  console.log('Usuario inicial creado: ' + usuario);
}

// Si el usuario inicial aún no tiene correo, toma el del entorno. Así una
// instalación anterior al correo queda lista sin tocar la base de datos.
async function asegurarEmailAdmin() {
  const email = process.env.PORTAL_ADMIN_EMAIL || '';
  const usuario = process.env.PORTAL_ADMIN_USER || '';
  if (!email || !usuario || !emailValido(email)) return;

  await consulta("UPDATE ha_usuario SET email = ? WHERE usuario = ? AND email = ''", [email, usuario]);
}

// Abre la sesión del portal (cookie) para un usuario ya comprobado.
async function abrirSesion(req, res, fila) {
  const token = crypto.randomBytes(32).toString('hex');
  await consulta(
    'INSERT INTO ha_sesion (token_hash, usuario_id, caduca_en, creado_en) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? DAY, UTC_TIMESTAMP())',
    [hashToken(token), fila.id, DIAS_SESION]
  );
  await consulta('DELETE FROM ha_sesion WHERE caduca_en < UTC_TIMESTAMP()');
  res.cookie(COOKIE, token, opcionesCookie(req));

  // El aviso no retrasa la entrada ni la impide si el correo falla.
  if (fila.email) {
    correo.avisoAcceso(fila.email, fila.usuario, {
      ip: req.ip,
      navegador: String(req.headers['user-agent'] || 'desconocido').slice(0, 160)
    }).catch(() => {});
  }
}

// Con Keycloak no hay contraseñas del portal.
function soloLocal() {
  if (sso.activo()) throw errorUsuario('La entrada es con Keycloak.', 404);
}

async function iniciarSesion(req, res) {
  soloLocal();
  const ip = req.ip;
  const registro = fallos.get(ip);
  if (registro && registro.n >= MAX_FALLOS && Date.now() < registro.hasta) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  }

  const usuario = String((req.body && req.body.usuario) || '').trim();
  const clave = String((req.body && req.body.clave) || '');
  const filas = await consulta('SELECT id, usuario, clave_hash, email FROM ha_usuario WHERE usuario = ?', [usuario]);

  if (!filas.length || !claveCorrecta(clave, filas[0].clave_hash)) {
    const n = registro && Date.now() < registro.hasta ? registro.n + 1 : 1;
    fallos.set(ip, { n: n, hasta: Date.now() + BLOQUEO_MS });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  fallos.delete(ip);

  await abrirSesion(req, res, filas[0]);
  res.json({ usuario: filas[0].usuario });
}

// ── Keycloak ──────────────────────────────────────────────────────────────
const COOKIE_SSO = 'ha_sso';

function pagina(res, status, titulo, texto, enlace) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.status(status).type('html').send('<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(titulo) + '</title>' +
    '<link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="css/portal.css"></head>' +
    '<body><main class="login"><div class="login-brand"><div><strong>' + esc(titulo) + '</strong>' +
    '<span>' + esc(texto) + '</span></div></div>' +
    '<a class="login-link" href="' + esc(enlace.url) + '">' + esc(enlace.texto) + '</a></main></body></html>');
}

// /login: a la pantalla de Keycloak, con un valor de un solo uso para la vuelta.
function irAKeycloak(req, res) {
  const estado = crypto.randomBytes(24).toString('hex');
  res.cookie(COOKIE_SSO, estado, { ...opcionesCookie(req), maxAge: 10 * 60 * 1000 });
  res.redirect(sso.urlLogin(req, estado));
}

// La fila del portal de quien entra por Keycloak; se crea la primera vez. Si
// PORTAL_ADMIN_SSO es su usuario, hereda el usuario local de antes
// (PORTAL_ADMIN_USER) con todo lo suyo: sesiones de trabajo, cronómetro, correos.
async function filaDeKeycloak(p) {
  const buscar = () => consulta('SELECT id, usuario, email FROM ha_usuario WHERE usuario = ?', [p.usuario]);
  let [fila] = await buscar();
  const hereda = process.env.PORTAL_ADMIN_SSO || '';
  const local = process.env.PORTAL_ADMIN_USER || '';
  if (!fila && hereda && local && hereda === p.usuario && local !== p.usuario) {
    await consulta('UPDATE ha_usuario SET usuario = ? WHERE usuario = ?', [p.usuario, local]);
    [fila] = await buscar();
    if (fila) console.log('Keycloak: ' + p.usuario + ' hereda el usuario local ' + local);
  }
  if (!fila) {
    await consulta(
      "INSERT IGNORE INTO ha_usuario (usuario, clave_hash, rol, email, creado_en) VALUES (?, '!keycloak', 'admin', ?, UTC_TIMESTAMP())",
      [p.usuario, emailValido(p.email) ? p.email : '']
    );
    [fila] = await buscar();
  }
  return fila;
}

// /sso: vuelta de Keycloak.
async function vueltaDeKeycloak(req, res) {
  const estado = String(req.query.state || '');
  const guardado = (String(req.headers.cookie || '').match(/(?:^|;\s*)ha_sso=([a-f0-9]{48})/) || [])[1];
  res.clearCookie(COOKIE_SSO, { path: rutaCookie(req) });
  const reintentar = { url: 'login', texto: 'Volver a entrar' };

  if (!guardado || !req.query.code || estado.length !== guardado.length ||
      !crypto.timingSafeEqual(Buffer.from(estado), Buffer.from(guardado))) {
    return pagina(res, 400, 'No se ha podido entrar', 'La vuelta de Keycloak no es válida o ha caducado.', reintentar);
  }

  const p = await sso.completar(req, String(req.query.code)).catch((e) => {
    console.error('Keycloak: ' + e.message);
    return null;
  });
  if (!p) return pagina(res, 502, 'No se ha podido entrar', 'Keycloak no ha confirmado la entrada.', reintentar);

  // Hoy el portal es solo de administración: entra quien administra la app (IT o …/Admin).
  if (!p.entra || !p.admin) {
    return pagina(res, 403, 'Sin acceso', p.usuario + ' no tiene acceso a este portal.',
      { url: sso.urlLogout(req), texto: 'Entrar con otro usuario' });
  }

  const fila = await filaDeKeycloak(p);
  await abrirSesion(req, res, fila);
  res.redirect('/');
}

// Pide un enlace para restablecer la contraseña. Responde siempre lo mismo,
// exista o no el usuario, para no revelar qué cuentas hay.
async function pedirRecuperacion(req, res) {
  soloLocal();
  const ip = req.ip;
  const registro = recuperaciones.get(ip);
  if (registro && registro.n >= MAX_RECUPERACIONES && Date.now() < registro.hasta) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera unos minutos.' });
  }
  recuperaciones.set(ip, {
    n: registro && Date.now() < registro.hasta ? registro.n + 1 : 1,
    hasta: Date.now() + BLOQUEO_MS
  });

  const dato = String((req.body && req.body.usuario) || '').trim();
  const [fila] = dato
    ? await consulta("SELECT id, usuario, email FROM ha_usuario WHERE (usuario = ? OR email = ?) AND email <> ''", [dato, dato])
    : [];

  if (fila && correo.activo()) {
    const token = crypto.randomBytes(32).toString('hex');
    await consulta('DELETE FROM ha_recuperacion WHERE usuario_id = ? OR caduca_en < UTC_TIMESTAMP()', [fila.id]);
    await consulta(
      'INSERT INTO ha_recuperacion (token_hash, usuario_id, caduca_en) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)',
      [hashToken(token), fila.id, MINUTOS_RECUPERACION]
    );
    correo.recuperacion(fila.email, fila.usuario, token, MINUTOS_RECUPERACION).catch(() => {});
  }

  res.json({ ok: true, mensaje: 'Si la cuenta existe y tiene un correo, te hemos enviado un enlace. Caduca en ' + MINUTOS_RECUPERACION + ' minutos.' });
}

// Cambia la contraseña con un enlace de recuperación: vale una sola vez y
// cierra todas las sesiones abiertas.
async function restablecer(req, res) {
  soloLocal();
  const token = String((req.body && req.body.token) || '');
  const nueva = String((req.body && req.body.nueva) || '');

  const [fila] = /^[a-f0-9]{64}$/.test(token)
    ? await consulta(
        `SELECT r.usuario_id, u.usuario, u.email FROM ha_recuperacion r JOIN ha_usuario u ON u.id = r.usuario_id
          WHERE r.token_hash = ? AND r.caduca_en > UTC_TIMESTAMP()`, [hashToken(token)])
    : [];

  if (!fila) throw errorUsuario('El enlace no es válido o ha caducado. Pide uno nuevo.');
  if (nueva.length < CLAVE_MINIMA) throw errorUsuario('La contraseña debe tener al menos ' + CLAVE_MINIMA + ' caracteres.');

  // Se borra primero el enlace: si dos peticiones llegan a la vez, solo una lo encuentra.
  const borrado = await consulta('DELETE FROM ha_recuperacion WHERE token_hash = ?', [hashToken(token)]);
  if (!borrado.affectedRows) throw errorUsuario('El enlace ya se ha usado. Pide uno nuevo.');

  await consulta('UPDATE ha_usuario SET clave_hash = ? WHERE id = ?', [hashClave(nueva), fila.usuario_id]);
  await consulta('DELETE FROM ha_sesion WHERE usuario_id = ?', [fila.usuario_id]);
  // Cualquier otro enlace pendiente del mismo usuario deja de valer.
  await consulta('DELETE FROM ha_recuperacion WHERE usuario_id = ?', [fila.usuario_id]);
  fallos.clear();

  res.json({ ok: true });
  correo.claveCambiada(fila.email, fila.usuario).catch(() => {});
}

async function cuenta(req) {
  const [fila] = await consulta('SELECT usuario, rol, email FROM ha_usuario WHERE id = ?', [req.usuario.id]);
  return { ...fila, correoActivo: correo.activo(), keycloak: sso.activo() };
}

async function guardarEmail(req, email) {
  email = String(email || '').trim();
  if (email && !emailValido(email)) throw errorUsuario('El correo no tiene un formato válido.');

  await consulta('UPDATE ha_usuario SET email = ? WHERE id = ?', [email, req.usuario.id]);
  return cuenta(req);
}

async function correoDePrueba(req) {
  const datos = await cuenta(req);
  if (!datos.email) throw errorUsuario('Guarda antes un correo en tu cuenta.');

  const resultado = await correo.prueba(datos.email);
  if (!resultado.enviado) throw errorUsuario(resultado.motivo, 502);
  return { ok: true, para: datos.email };
}

async function cerrarSesion(req, res) {
  const token = leerCookie(req);
  if (token) {
    await consulta('DELETE FROM ha_sesion WHERE token_hash = ?', [hashToken(token)]);
  }
  res.clearCookie(COOKIE, { path: rutaCookie(req) });
  // Con Keycloak se cierra también su sesión; si no, la siguiente visita entraría sola.
  res.json(sso.activo() ? { ok: true, salir: sso.urlLogout(req) } : { ok: true });
}

// Cambia la contraseña y cierra el resto de sesiones abiertas del usuario.
async function cambiarClave(req, actual, nueva) {
  soloLocal();
  const [fila] = await consulta('SELECT usuario, clave_hash, email FROM ha_usuario WHERE id = ?', [req.usuario.id]);

  if (!fila || !claveCorrecta(actual, fila.clave_hash)) throw errorUsuario('La contraseña actual no es correcta.');
  if (nueva.length < CLAVE_MINIMA) throw errorUsuario('La contraseña nueva debe tener al menos ' + CLAVE_MINIMA + ' caracteres.');

  await consulta('UPDATE ha_usuario SET clave_hash = ? WHERE id = ?', [hashClave(nueva), req.usuario.id]);
  await consulta('DELETE FROM ha_sesion WHERE usuario_id = ? AND token_hash <> ?',
    [req.usuario.id, hashToken(leerCookie(req))]);
  await consulta('DELETE FROM ha_recuperacion WHERE usuario_id = ?', [req.usuario.id]);
  if (fila.email) correo.claveCambiada(fila.email, fila.usuario).catch(() => {});
}

async function usuarioDeSesion(req) {
  const token = leerCookie(req);
  if (!token) return null;

  const filas = await consulta(
    `SELECT u.id, u.usuario, u.rol
       FROM ha_sesion s JOIN ha_usuario u ON u.id = s.usuario_id
      WHERE s.token_hash = ? AND s.caduca_en > UTC_TIMESTAMP()`,
    [hashToken(token)]
  );
  return filas[0] || null;
}

// Para la API: sin sesión responde 401.
async function requiereSesion(req, res, next) {
  req.usuario = await usuarioDeSesion(req);
  if (!req.usuario) return res.status(401).json({ error: 'Sesión no iniciada.' });
  next();
}

// Para las páginas: sin sesión lleva a la pantalla de entrada.
async function requiereSesionPagina(req, res, next) {
  req.usuario = await usuarioDeSesion(req);
  if (!req.usuario) return res.redirect('/login');
  next();
}

module.exports = {
  asegurarAdmin,
  asegurarEmailAdmin,
  iniciarSesion,
  irAKeycloak,
  vueltaDeKeycloak,
  pedirRecuperacion,
  restablecer,
  cuenta,
  guardarEmail,
  correoDePrueba,
  cerrarSesion,
  cambiarClave,
  usuarioDeSesion,
  requiereSesion,
  requiereSesionPagina
};
