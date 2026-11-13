// Pruebas de las llaves de agente (src/agente.js y requiereSesion de src/auth.js).
// Sin base de datos: una en memoria. Arranca un Express pequeño con la misma forma que server.js.
//   node portal/tests/agente.js
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');

const usuarios = [{ id: 1, usuario: 'luis', rol: 'admin' }];
const llaves = [];
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
async function consulta(sql, p = []) {
  if (/^INSERT INTO ha_llave_agente/.test(sql)) {
    llaves.push({ id: llaves.length + 1, usuario_id: p[0], nombre: p[1], nivel: p[2], token_hash: p[3], final: p[4], caduca: p[5], revocada: null });
    return { insertId: llaves.length };
  }
  if (/FROM ha_llave_agente k JOIN ha_usuario/.test(sql)) {
    const k = llaves.find(x => x.token_hash === p[0] && !x.revocada);
    if (!k) return [];
    const u = usuarios.find(x => x.id === k.usuario_id);
    return [{ ...u, llave_id: k.id, nombre: k.nombre, nivel: k.nivel }];
  }
  if (/^UPDATE ha_llave_agente SET usada_en/.test(sql)) return [];
  if (/^UPDATE ha_llave_agente SET revocada_en/.test(sql)) {
    const k = llaves.find(x => x.id === p[0] && x.usuario_id === p[1] && !x.revocada);
    if (k) k.revocada = new Date();
    return { affectedRows: k ? 1 : 0 };
  }
  if (/FROM ha_llave_agente WHERE usuario_id/.test(sql)) return llaves.filter(x => x.usuario_id === p[0]).map(x => ({ id: x.id, nombre: x.nombre, nivel: x.nivel, final: x.final }));
  if (/FROM ha_sesion s JOIN ha_usuario/.test(sql)) return p[0] === sha('cookie-buena') ? [usuarios[0]] : [];
  throw new Error('Consulta no prevista: ' + sql);
}
require.cache[path.join(__dirname, '../src/db.js')] = { id: 'db', loaded: true, exports: { consulta, pool: {} } };

const express = require('express');
const auth = require('../src/auth');
const agente = require('../src/agente');

// La API de mentira: lo justo para ver que pasa como la persona y con las mismas comprobaciones.
const api = express.Router();
const notas = [];
api.get('/yo', (req, res) => res.json({ usuario: req.usuario.usuario }));
api.get('/incidencias', (req, res) => res.json([{ id: 12, titulo: 'Impresora' }]));
api.post('/incidencias/:id/notas', (req, res) => { notas.push({ autor: req.usuario.usuario, ...req.body }); res.json({ ok: true }); });
api.get('/cuenta', (req, res) => res.json({ email: 'x' }));
api.put('/sindri', (req, res) => res.json({ ok: true }));
api.get('/llaves-agente', (req, res, next) => agente.listar(req.usuario.id).then(x => res.json(x), next));
api.post('/llaves-agente', (req, res, next) => agente.crear(req.usuario.id, req.body).then(x => res.status(201).json(x), next));
api.post('/llaves-agente/:id/revocar', (req, res, next) => agente.revocar(req.usuario.id, req.params.id).then(x => res.json(x), next));

const app = express();
app.use(express.json());
const sesion = (req, res, next) => auth.requiereSesion(req, res, next).catch(next);
app.use('/api/agente', sesion, agente.router(api));
app.use('/api', sesion, api);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

(async () => {
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  process.env.PORT = String(srv.address().port);
  const B = 'http://127.0.0.1:' + process.env.PORT;
  const call = async (metodo, ruta, cuerpo, h) => {
    const r = await fetch(B + ruta, { method: metodo, headers: { ...(cuerpo ? { 'content-type': 'application/json' } : {}), ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const t = await r.text();
    let b = t; try { b = JSON.parse(t); } catch (e) { /* texto */ }
    return { status: r.status, body: b };
  };
  const conCookie = { cookie: 'ha_sesion=cookie-buena' };
  const con = k => ({ authorization: 'Bearer ' + k });

  try {
    // La persona crea sus llaves; la entera se ve solo al crearla.
    assert.strictEqual((await call('POST', '/api/llaves-agente', { nombre: 'Con Espacios', nivel: 'cambiar' }, conCookie)).status, 400);
    assert.strictEqual((await call('POST', '/api/llaves-agente', { nombre: 'claude', nivel: 'todo' }, conCookie)).status, 400);
    const lee = (await call('POST', '/api/llaves-agente', { nombre: 'claude-lee', nivel: 'consultar' }, conCookie)).body;
    const cambia = (await call('POST', '/api/llaves-agente', { nombre: 'claude', nivel: 'cambiar', dias: 30 }, conCookie)).body;
    assert.match(lee.llave, /^oda_/);
    assert.ok(!('llave' in (await call('GET', '/api/llaves-agente', null, conCookie)).body[0]));

    // Sin llave buena no entra.
    assert.strictEqual((await call('GET', '/api/incidencias', null, con('oda_mala'))).status, 401);

    // Consultar: lee como la persona, no cambia nada.
    assert.deepStrictEqual((await call('GET', '/api/yo', null, con(lee.llave))).body, { usuario: 'luis' });
    assert.strictEqual((await call('POST', '/api/incidencias/12/notas', { texto: 'x' }, con(lee.llave))).status, 403);

    // Cambiar: cambia, pero nunca la cuenta ni las llaves.
    assert.strictEqual((await call('POST', '/api/incidencias/12/notas', { texto: 'Revisado' }, con(cambia.llave))).status, 200);
    assert.strictEqual(notas[0].autor, 'luis');
    assert.strictEqual((await call('GET', '/api/cuenta', null, con(cambia.llave))).status, 403);
    assert.strictEqual((await call('PUT', '/api/sindri', { llave: 'x' }, con(cambia.llave))).status, 403);
    assert.strictEqual((await call('POST', '/api/llaves-agente', { nombre: 'otra', nivel: 'cambiar' }, con(cambia.llave))).status, 403);
    assert.strictEqual((await call('GET', '/api/llaves-agente', null, con(cambia.llave))).status, 403);

    // Lo propio del agente.
    assert.deepStrictEqual((await call('GET', '/api/agente/yo', null, con(lee.llave))).body, { agente: 'claude-lee', nivel: 'consultar', usuario: 'luis', rol: 'admin' });
    assert.strictEqual((await call('GET', '/api/agente/yo', null, conCookie)).status, 401);
    const t = (await call('GET', '/api/agente/traspaso', null, con(lee.llave))).body;
    assert.ok(t.includes('`/incidencias`') && !t.includes('/cuenta') && !t.includes('llaves-agente'));
    const rutas = (await call('GET', '/api/agente/rutas', null, con(lee.llave))).body;
    assert.ok(rutas.some(x => x.metodo === 'POST' && x.ruta === '/incidencias/:id/notas' && !x.permitida));

    // MCP.
    const rpc = (method, params, k) => call('POST', '/api/agente/mcp', { jsonrpc: '2.0', id: 1, method, params }, con(k));
    assert.strictEqual((await rpc('initialize', {}, lee.llave)).body.result.serverInfo.name, 'odin');
    assert.strictEqual((await call('POST', '/api/agente/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, con(lee.llave))).status, 202);
    assert.ok(!(await rpc('tools/list', {}, lee.llave)).body.result.tools.some(x => x.name === 'odin_cambiar'));
    const r1 = (await rpc('tools/call', { name: 'odin_consultar', arguments: { ruta: '/incidencias' } }, lee.llave)).body.result;
    assert.strictEqual(JSON.parse(r1.content[0].text).body[0].id, 12);
    assert.strictEqual((await rpc('tools/call', { name: 'odin_cambiar', arguments: { metodo: 'POST', ruta: '/incidencias/12/notas', cuerpo: { texto: 'x' } } }, lee.llave)).body.result.isError, true);
    const r2 = (await rpc('tools/call', { name: 'odin_cambiar', arguments: { metodo: 'POST', ruta: '/incidencias/12/notas', cuerpo: { texto: 'Desde MCP' } } }, cambia.llave)).body.result;
    assert.strictEqual(JSON.parse(r2.content[0].text).status, 200);
    const r3 = (await rpc('tools/call', { name: 'odin_consultar', arguments: { ruta: '/cuenta' } }, cambia.llave)).body.result;
    assert.strictEqual(JSON.parse(r3.content[0].text).status, 403);

    // Revocada: deja de valer al momento.
    assert.strictEqual((await call('POST', `/api/llaves-agente/${lee.id}/revocar`, {}, conCookie)).status, 200);
    assert.strictEqual((await call('GET', '/api/incidencias', null, con(lee.llave))).status, 401);
    console.log('Llaves de agente: OK');
  } finally {
    srv.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
