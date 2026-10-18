// Pruebas del prefijo de ruta (src/ruta.js). Sin base de datos:
//   node portal/tests/ruta.js
const assert = require('assert');
const { prefijoDe, conPrefijo } = require('../src/ruta');

const peticion = (cabeceras) => ({ headers: cabeceras || {} });

// Sin cabecera (dominio propio, entorno local): sin prefijo.
assert.strictEqual(prefijoDe(peticion()), '');
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': '' })), '');
// Bajo una ruta del servidor DEV/PRO.
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': '/soporte' })), '/soporte');
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': '/soporte/' })), '/soporte');
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': '/spsil/soporte' })), '/spsil/soporte');
// Nada raro pasa como prefijo.
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': 'soporte' })), '');
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': '//otro.sitio' })), '');
assert.strictEqual(prefijoDe(peticion({ 'x-forwarded-prefix': '/a b' })), '');

assert.strictEqual(conPrefijo('', '/login'), '/login');
assert.strictEqual(conPrefijo('/soporte', '/login'), '/soporte/login');
assert.strictEqual(conPrefijo('/soporte', '/'), '/soporte/');
assert.strictEqual(conPrefijo('/soporte', '/api/documentos/3/pdf'), '/soporte/api/documentos/3/pdf');
// Lo que ya lleva el prefijo, una dirección completa o relativa, no se toca.
assert.strictEqual(conPrefijo('/soporte', '/soporte/login'), '/soporte/login');
assert.strictEqual(conPrefijo('/soporte', '/soporte'), '/soporte');
assert.strictEqual(conPrefijo('/soporte', 'https://otro.sitio/x'), 'https://otro.sitio/x');
assert.strictEqual(conPrefijo('/soporte', '//otro.sitio/x'), '//otro.sitio/x');
assert.strictEqual(conPrefijo('/soporte', 'login'), 'login');

console.log('ruta.js: todas las comprobaciones pasan');
