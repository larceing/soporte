// Llaves de agente (oda_…): un programa, por ejemplo un hilo de Claude, usa la API de Odin como la
// persona que creó la llave, sin contraseña ni Keycloak.
//  - Cada persona crea las suyas en Ajustes → Llaves de agente. Se enseñan una vez; aquí solo queda
//    su sha256.
//  - Nivel «consultar» (solo GET) o «cambiar» (lo que puede esa persona).
//  - Nunca: la cuenta (correo, contraseña), las llaves (de agente, de Sindri, de Tareas).
//  - /api/agente/: yo, rutas, traspaso (instrucciones en Markdown) y mcp (MCP sin estado).
const crypto = require('crypto');
const express = require('express');
const { consulta } = require('./db');
const { ErrorUsuario, ruta } = require('./util');

const PREFIJO = 'oda_';
const NIVELES = ['consultar', 'cambiar'];
const hash = t => crypto.createHash('sha256').update(t).digest('hex');

function tokenDe(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ' + PREFIJO) ? h.slice(7).trim() : null;
}

// Lo que una llave de agente no hace nunca (camino debajo de /api).
const PROHIBIDO = [
  [/.*/, /^\/cuenta(\/|$)/],
  [/.*/, /^\/llaves-agente(\/|$)/],
  [/^(PUT|POST|PATCH|DELETE)$/, /^\/sindri(\/mia)?$/],
  [/^(PUT|POST|PATCH|DELETE)$/, /^\/tareas$/],
  [/.*/, /^\/(login|logout|recuperar|restablecer)$/]
];
const prohibido = (metodo, camino) => PROHIBIDO.some(([m, c]) => m.test(metodo) && c.test(camino));

// La persona (como en usuarioDeSesion) y la llave, o null si la llave no vale.
async function deLlave(req) {
  const token = tokenDe(req);
  if (!token) return null;
  const filas = await consulta(
    `SELECT u.id, u.usuario, u.rol, k.id AS llave_id, k.nombre, k.nivel
       FROM ha_llave_agente k JOIN ha_usuario u ON u.id = k.usuario_id
      WHERE k.token_hash = ? AND k.revocada_en IS NULL AND (k.caduca_en IS NULL OR k.caduca_en > UTC_TIMESTAMP())`,
    [hash(token)]
  );
  const f = filas[0];
  if (!f) return { invalida: true };
  await consulta('UPDATE ha_llave_agente SET usada_en = UTC_TIMESTAMP() WHERE id = ?', [f.llave_id]);
  return { usuario: { id: f.id, usuario: f.usuario, rol: f.rol }, agente: { id: f.llave_id, nombre: f.nombre, nivel: f.nivel } };
}

// Para requiereSesion: 'nada' si no viene llave de agente, o el error que toca, o ok.
async function comprobar(req) {
  if (!tokenDe(req)) return { nada: true };
  const r = await deLlave(req);
  if (r.invalida) return { status: 401, error: 'Llave de agente no válida, revocada o caducada.' };
  // Debajo de /api, monte donde se monte (/api o /api/agente).
  const camino = (req.baseUrl + req.path).replace(/^\/api(?=\/)/, '');
  if (!camino.startsWith('/agente/')) {
    if (prohibido(req.method, camino)) return { status: 403, error: 'Una llave de agente no puede hacer esto (cuenta o llaves).' };
    if (r.agente.nivel === 'consultar' && req.method !== 'GET') return { status: 403, error: 'Esta llave de agente solo permite consultar.' };
  }
  return r;
}

// Administración: cada persona, las suyas (nunca con una llave de agente).
async function listar(usuarioId) {
  return consulta(
    `SELECT id, nombre, nivel, final, creada_en AS creada, caduca_en AS caduca, usada_en AS usada, revocada_en AS revocada
       FROM ha_llave_agente WHERE usuario_id = ? ORDER BY revocada_en IS NOT NULL, id DESC`,
    [usuarioId]
  );
}

async function crear(usuarioId, b) {
  const nombre = String(b.nombre || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(nombre)) throw new ErrorUsuario('Nombre en minúsculas, sin espacios (p. ej. claude).');
  if (!NIVELES.includes(b.nivel)) throw new ErrorUsuario('Nivel: consultar o cambiar.');
  const dias = b.dias == null || b.dias === '' ? null : Number(b.dias);
  if (dias !== null && !(Number.isInteger(dias) && dias >= 1 && dias <= 3650)) throw new ErrorUsuario('Caducidad no válida.');
  const llave = PREFIJO + crypto.randomBytes(32).toString('base64url');
  const r = await consulta(
    `INSERT INTO ha_llave_agente (usuario_id, nombre, nivel, token_hash, final, creada_en, caduca_en)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), IF(? IS NULL, NULL, UTC_TIMESTAMP() + INTERVAL ? DAY))`,
    [usuarioId, nombre, b.nivel, hash(llave), llave.slice(-4), dias, dias]
  );
  return { id: r.insertId, nombre, nivel: b.nivel, llave };
}

async function revocar(usuarioId, id) {
  const r = await consulta('UPDATE ha_llave_agente SET revocada_en = UTC_TIMESTAMP() WHERE id = ? AND usuario_id = ? AND revocada_en IS NULL',
    [Number(id), usuarioId]);
  if (!r.affectedRows) throw new ErrorUsuario('Llave no encontrada.', 404);
  return { ok: true };
}

// Las rutas del router de la API (para /rutas y el traspaso).
function rutasDe(router) {
  const out = [];
  for (const capa of router.stack) {
    if (!capa.route) continue;
    for (const m of Object.keys(capa.route.methods)) out.push({ metodo: m.toUpperCase(), ruta: capa.route.path });
  }
  return out;
}

// Lo propio del agente, montado en /api/agente (ya con req.usuario y req.agente).
function router(apiRouter) {
  const r = express.Router();
  const agente = req => {
    if (!req.agente) throw new ErrorUsuario('Hace falta una llave de agente (Authorization: Bearer oda_…).', 401);
    return req.agente;
  };
  const lista = req => rutasDe(apiRouter)
    .filter(x => !prohibido(x.metodo, x.ruta))
    .map(x => ({ ...x, permitida: x.metodo === 'GET' || agente(req).nivel === 'cambiar' }));
  const yo = req => ({ agente: agente(req).nombre, nivel: agente(req).nivel, usuario: req.usuario.usuario, rol: req.usuario.rol });

  // La API de siempre, con la misma llave: pasan las mismas comprobaciones.
  async function llamar(req, metodo, camino, cuerpo) {
    let c = String(camino || '');
    if (!c.startsWith('/')) c = '/' + c;
    c = c.replace(/^\/api(?=\/)/, '');
    if (c.includes('..') || c.startsWith('//') || c.startsWith('/agente')) throw new ErrorUsuario('Ruta no válida.');
    const puerto = Number(process.env.PORT) || 3000;
    const res = await fetch('http://127.0.0.1:' + puerto + '/api' + c, {
      method: metodo,
      headers: Object.assign({ authorization: req.headers.authorization }, cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
    });
    const texto = await res.text();
    let body = texto;
    try { body = texto ? JSON.parse(texto) : null; } catch (e) { /* no es JSON */ }
    return { status: res.status, body };
  }

  r.get('/yo', ruta(async (req, res) => res.json(yo(req))));
  r.get('/rutas', ruta(async (req, res) => res.json(lista(req))));
  r.get('/traspaso', ruta(async (req, res) => {
    const y = yo(req);
    const filas = lista(req).filter(x => x.permitida).map(x => `| ${x.metodo} | \`${x.ruta}\` |`).join('\n');
    res.type('text/markdown; charset=utf-8').send(`# Odin para el agente «${y.agente}»

Trabaja como **${y.usuario}** (ve y hace lo mismo que esa persona). Nivel: **${y.nivel}** (${y.nivel === 'cambiar' ? 'consultar y cambiar' : 'solo consultar'}).
Nunca toca la cuenta (correo, contraseña) ni las llaves (de agente, de Sindri, de Tareas).

## Cómo se llama

Con \`Authorization: Bearer oda_…\` (en la nube la pone el proxy del entorno). Los cambios van en JSON.

\`\`\`bash
B="https://<dominio>/soporte"
curl -fsS "$B/api/agente/yo"
curl -fsS "$B/api/incidencias"
curl -fsS -H 'Content-Type: application/json' -d '{"texto":"Revisado"}' "$B/api/incidencias/12/notas"
\`\`\`

MCP (JSON-RPC por HTTP): \`POST $B/api/agente/mcp\` con \`odin_yo\`, \`odin_rutas\`, \`odin_consultar\` y \`odin_cambiar\`.

## Rutas que puede usar esta llave (debajo de /api)

| Método | Ruta |
|---|---|
${filas}
`);
  }));

  const HERRAMIENTAS = [
    { name: 'odin_yo', description: 'Quién es esta llave de agente de Odin y qué puede.', inputSchema: { type: 'object', properties: {} } },
    { name: 'odin_rutas', description: 'Rutas de la API de Odin (debajo de /api) y si esta llave puede usarlas.', inputSchema: { type: 'object', properties: {} } },
    { name: 'odin_consultar', description: 'GET a la API de Odin. ruta va debajo de /api (p. ej. /incidencias).', inputSchema: { type: 'object', properties: { ruta: { type: 'string' } }, required: ['ruta'] } },
    { name: 'odin_cambiar', description: 'POST, PUT, PATCH o DELETE a la API de Odin (solo con nivel «cambiar»). cuerpo es el JSON que se manda.',
      inputSchema: { type: 'object', properties: { metodo: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] }, ruta: { type: 'string' }, cuerpo: {} }, required: ['metodo', 'ruta'] } }
  ];
  const texto = (v, isError) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }], isError: !!isError });

  r.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Solo POST' }));
  r.post('/mcp', ruta(async (req, res) => {
    const a = agente(req);
    const m = req.body || {};
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Petición JSON-RPC no válida' } });
    if (m.id === undefined) return res.status(202).end();
    const ok = result => res.json({ jsonrpc: '2.0', id: m.id, result });
    const p = m.params || {};
    if (m.method === 'initialize') return ok({
      protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'odin', version: '1' },
      instructions: 'API de Odin (incidencias y horas). Empieza por odin_yo y odin_rutas.'
    });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: a.nivel === 'cambiar' ? HERRAMIENTAS : HERRAMIENTAS.filter(h => h.name !== 'odin_cambiar') });
    if (m.method === 'tools/call') {
      const args = p.arguments || {};
      if (p.name === 'odin_yo') return ok(texto(yo(req)));
      if (p.name === 'odin_rutas') return ok(texto(lista(req)));
      if (p.name === 'odin_consultar') {
        if (typeof args.ruta !== 'string') return ok(texto('Falta ruta', true));
        const x = await llamar(req, 'GET', args.ruta);
        return ok(texto(x, x.status >= 400));
      }
      if (p.name === 'odin_cambiar') {
        if (a.nivel !== 'cambiar') return ok(texto('Esta llave solo permite consultar', true));
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(args.metodo) || typeof args.ruta !== 'string') return ok(texto('Faltan metodo o ruta', true));
        const x = await llamar(req, args.metodo, args.ruta, args.cuerpo === undefined ? {} : args.cuerpo);
        return ok(texto(x, x.status >= 400));
      }
      return res.json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Herramienta desconocida: ' + p.name } });
    }
    return res.json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Método no soportado: ' + m.method } });
  }));
  return r;
}

module.exports = { PREFIJO, tokenDe, comprobar, prohibido, listar, crear, revocar, router, rutasDe };
