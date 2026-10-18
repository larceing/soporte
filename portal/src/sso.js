// Entrada con Keycloak (AUTH_MODO=sso), como en las demás apps del servidor DEV/PRO.
// Flujo Authorization Code: /login manda a Keycloak, Keycloak vuelve a /sso
// con un code, y el portal lo cambia por un token y pide /userinfo. Las dos
// peticiones van directas del portal al issuer, así que no hace falta validar la
// firma del token. El servidor pone en app.env KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID,
// KEYCLOAK_CLIENT_SECRET, KEYCLOAK_GRUPO_APP (PRO/Soporte) y
// KEYCLOAK_GRUPO_ADMIN_GLOBAL (IT). Sin AUTH_MODO=sso todo sigue con usuario y
// contraseña propios (entorno local).

function activo() {
  return process.env.AUTH_MODO === 'sso' && !!process.env.KEYCLOAK_ISSUER && !!process.env.KEYCLOAK_CLIENT_ID;
}

const issuer = () => String(process.env.KEYCLOAK_ISSUER || '').replace(/\/+$/, '');
// Las llamadas del portal a Keycloak pueden ir por dentro (opcional).
const interno = () => String(process.env.KEYCLOAK_INTERNO || process.env.KEYCLOAK_ISSUER || '').replace(/\/+$/, '');
const sinBarras = (g) => String(g || '').trim().replace(/^\/+|\/+$/g, '');

// Dirección del portal tal como la ve el navegador (pro.<dominio>/soporte o su dominio).
function base(req) {
  return req.protocol + '://' + req.get('host') + (req.prefijo || '');
}

const vuelta = (req) => base(req) + '/sso';

function urlLogin(req, estado) {
  const p = new URLSearchParams({
    client_id: process.env.KEYCLOAK_CLIENT_ID, response_type: 'code', scope: 'openid',
    redirect_uri: vuelta(req), state: estado
  });
  return issuer() + '/protocol/openid-connect/auth?' + p;
}

// Cierra también la sesión de Keycloak; si no, la siguiente visita entraría sola.
function urlLogout(req) {
  const p = new URLSearchParams({ client_id: process.env.KEYCLOAK_CLIENT_ID, post_logout_redirect_uri: base(req) + '/' });
  return issuer() + '/protocol/openid-connect/logout?' + p;
}

// { entra, admin } según los grupos (claim "groups", con el camino entero):
// /<grupo de la app> y sus subgrupos entran; /<grupo de la app>/Admin y el grupo
// de IT administran. Hoy el portal solo tiene administradores, así que entra
// solo quien administra (los clientes, cuando tengan su vista).
function acceso(grupos) {
  const nombres = new Set((Array.isArray(grupos) ? grupos : []).map(sinBarras));
  const it = sinBarras(process.env.KEYCLOAK_GRUPO_ADMIN_GLOBAL || 'IT');
  const app = sinBarras(process.env.KEYCLOAK_GRUPO_APP);
  const esIt = !!it && nombres.has(it);
  const enApp = !!app && [...nombres].some(g => g === app || g.startsWith(app + '/'));
  const admin = esIt || (!!app && nombres.has(app + '/Admin'));
  return { entra: esIt || enApp, admin: admin };
}

// Cambia el code por la persona: { usuario, nombre, email, entra, admin } o null.
async function completar(req, code) {
  const r = await fetch(interno() + '/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code, redirect_uri: vuelta(req),
      client_id: process.env.KEYCLOAK_CLIENT_ID, client_secret: process.env.KEYCLOAK_CLIENT_SECRET || ''
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) return null;
  const token = (await r.json()).access_token;
  if (!token) return null;

  const u = await fetch(interno() + '/protocol/openid-connect/userinfo', {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000)
  });
  if (!u.ok) return null;
  const datos = await u.json();
  if (!datos.preferred_username) return null;
  return { usuario: String(datos.preferred_username).slice(0, 64), email: datos.email || '', ...acceso(datos.groups) };
}

module.exports = { activo, urlLogin, urlLogout, completar, acceso };
