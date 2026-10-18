// Pruebas de los grupos de Keycloak y de las direcciones de entrada (src/sso.js).
//   node portal/tests/sso.js
const assert = require('assert');
process.env.KEYCLOAK_ISSUER = 'https://users.ejemplo.com/realms/general';
process.env.KEYCLOAK_CLIENT_ID = 'soporte-pro';
process.env.KEYCLOAK_GRUPO_APP = 'PRO/Soporte';
process.env.KEYCLOAK_GRUPO_ADMIN_GLOBAL = 'IT';
const sso = require('../src/sso');

// IT entra y administra; …/Admin administra; el grupo de la app entra, pero no administra.
assert.deepStrictEqual(sso.acceso(['/IT']), { entra: true, admin: true });
assert.deepStrictEqual(sso.acceso(['/PRO/Soporte/Admin']), { entra: true, admin: true });
assert.deepStrictEqual(sso.acceso(['/PRO/Soporte']), { entra: true, admin: false });
assert.deepStrictEqual(sso.acceso(['/PRO/Soporte/Clientes']), { entra: true, admin: false });
// Otros grupos, el de DEV en PRO o nada: no entra.
assert.deepStrictEqual(sso.acceso(['/DEV/Soporte/Admin']), { entra: false, admin: false });
assert.deepStrictEqual(sso.acceso(['/PRO/SoporteX']), { entra: false, admin: false });
assert.deepStrictEqual(sso.acceso(undefined), { entra: false, admin: false });

process.env.AUTH_MODO = 'sso';
assert.strictEqual(sso.activo(), true);
const req = { protocol: 'https', prefijo: '/soporte', get: () => 'pro.ejemplo.com' };
const login = new URL(sso.urlLogin(req, 'abc'));
assert.strictEqual(login.origin + login.pathname, 'https://users.ejemplo.com/realms/general/protocol/openid-connect/auth');
assert.strictEqual(login.searchParams.get('redirect_uri'), 'https://pro.ejemplo.com/soporte/sso');
assert.strictEqual(login.searchParams.get('client_id'), 'soporte-pro');
assert.strictEqual(login.searchParams.get('state'), 'abc');
const salir = new URL(sso.urlLogout({ ...req, prefijo: '' }));
assert.strictEqual(salir.searchParams.get('post_logout_redirect_uri'), 'https://pro.ejemplo.com/');
process.env.AUTH_MODO = '';
assert.strictEqual(sso.activo(), false);

console.log('sso.js: todas las comprobaciones pasan');
