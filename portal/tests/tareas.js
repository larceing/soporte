// Pruebas de las tareas automáticas (src/tareas.js) contra un gestor de tareas de mentira con su
// API normal. Sin base de datos: la base se sustituye por una en memoria.
//   node portal/tests/tareas.js
const assert = require('assert');
const http = require('http');
const path = require('path');

const config = new Map();
const incs = [
  { id: 1, codigo: 'INC_X_1', tipo: 'Incidencia', titulo: 'Impresora', descripcion: 'No imprime', estado: 'new', prioridad: 'urgent', limite: '2026-10-30' },
  { id: 2, codigo: 'PET_X_2', tipo: 'Petición', titulo: 'Informe', descripcion: '', estado: 'closed', prioridad: 'normal', limite: null }
];
async function consulta(sql, p = []) {
  if (/DELETE FROM ha_config/.test(sql)) { config.delete('TAREAS_LLAVE'); return []; }
  if (/FROM ha_config WHERE clave IN/.test(sql)) return [...config].filter(([k]) => k.startsWith('TAREAS_')).map(([clave, valor]) => ({ clave, valor }));
  if (/FROM ha_config$/.test(sql)) return [...config].map(([clave, valor]) => ({ clave, valor }));
  if (/INSERT INTO ha_config/.test(sql)) { config.set(p[0], p[1]); return []; }
  if (/FROM ha_incidencia WHERE tarea_id IS NOT NULL OR estado NOT IN/.test(sql)) return incs.filter(i => i.tarea_id || !p[0].includes(i.estado)).map(i => ({ ...i }));
  if (/UPDATE ha_incidencia SET tarea_id = \?, tarea_estado = \?, tarea_huella = \?/.test(sql)) { Object.assign(incs.find(i => i.id === p[3]), { tarea_id: p[0], tarea_estado: p[1], tarea_huella: p[2] }); return []; }
  if (/UPDATE ha_incidencia SET tarea_huella = \?/.test(sql)) { incs.find(i => i.id === p[1]).tarea_huella = p[0]; return []; }
  if (/UPDATE ha_incidencia SET tarea_estado = \?/.test(sql)) { incs.find(i => i.id === p[1]).tarea_estado = p[0]; return []; }
  throw new Error('Consulta no prevista: ' + sql);
}
require.cache[path.join(__dirname, '../src/db.js')] = { id: 'db', loaded: true, exports: { consulta, pool: {} } };
process.env.PORTAL_URL = 'https://soporte.example.test';

const tareas = require('../src/tareas');
const fact = require('../src/facturacion');

// Gestor de tareas de mentira: /api con X-API-Key, como el de verdad.
const LLAVE = 'clave-tareas';
const enTareas = new Map();
let siguiente = 100;
const servidor = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    const responder = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.headers['x-api-key'] !== LLAVE) return responder(401, { ok: false, error: 'clave no válida' });
    const b = cuerpo ? JSON.parse(cuerpo) : {};
    if (req.url === '/api/dimensiones/') return responder(200, { proyectos: [{ id: 'soporte', nombre: 'Soporte', columnas: ['Pendiente', 'En curso', 'Hecha'] }] });
    if (req.url === '/api/tareas/' && req.method === 'POST') {
      const id = String(siguiente++);
      enTareas.set(id, { ...b, estado: 'Pendiente' });
      return responder(201, { ok: true, id });
    }
    let m = /^\/api\/tareas\/(\w+)\/mover\/$/.exec(req.url);
    if (m) {
      if (!enTareas.has(m[1])) return responder(404, { ok: false, error: 'no existe' });
      enTareas.get(m[1]).estado = b.status;
      return responder(200, { ok: true });
    }
    m = /^\/api\/tareas\/(\w+)\/$/.exec(req.url);
    if (m) {
      if (!enTareas.has(m[1])) return responder(404, { ok: false, error: 'no existe' });
      Object.assign(enTareas.get(m[1]), b);
      return responder(200, { ok: true });
    }
    responder(404, {});
  });
});

(async () => {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + servidor.address().port;

  // Sin conexión no se hace nada.
  assert.strictEqual(await tareas.sincronizar(), null);

  // La llave no sale en la configuración ni en el estado; falta el proyecto → se dice.
  await tareas.guardarConexion({ url: url + '/api/', llave: LLAVE });
  assert.ok(!('TAREAS_LLAVE' in await fact.config()));
  assert.ok(!JSON.stringify(await tareas.estado()).includes(LLAVE));
  assert.strictEqual((await tareas.estado()).url, url);
  let r = await tareas.sincronizar();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /proyecto/);
  await tareas.guardarConexion({ proyecto: 'nada' });
  assert.match((await tareas.sincronizar()).error, /Hay: soporte/);

  // Solo la abierta tiene tarea, con su prioridad, su fecha y el enlace.
  await tareas.guardarConexion({ proyecto: 'soporte' });
  r = await tareas.sincronizar();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.creadas, 1);
  const t = enTareas.get(incs[0].tarea_id);
  assert.strictEqual(t.titulo, 'INC_X_1 · Impresora');
  assert.strictEqual(t.prioridad, 'Alta');
  assert.strictEqual(t.fecha_fin, '2026-10-30');
  assert.match(t.descripcion, /No imprime\n\nIncidencia: https:\/\/soporte\.example\.test\/#incidencia-1$/);
  assert.ok(!incs[1].tarea_id);

  // Otra vez sin cambios: no se toca nada.
  r = await tareas.sincronizar();
  assert.deepStrictEqual([r.creadas, r.cambiadas, r.cerradas], [0, 0, 0]);

  // Cambia el título → se cambia; se resuelve → a hechas; se reabre → a la primera.
  incs[0].titulo = 'Impresora del almacén';
  r = await tareas.sincronizar();
  assert.strictEqual(r.cambiadas, 1);
  assert.strictEqual(t.titulo, 'INC_X_1 · Impresora del almacén');
  incs[0].estado = 'resolved';
  r = await tareas.sincronizar();
  assert.strictEqual(r.cerradas, 1);
  assert.strictEqual(t.estado, 'Hecha');
  incs[0].estado = 'assigned';
  r = await tareas.sincronizar();
  assert.strictEqual(r.reabiertas, 1);
  assert.strictEqual(t.estado, 'Pendiente');

  // Borrada en Tareas: no se vuelve a crear ni se toca.
  enTareas.clear();
  incs[0].titulo = 'Otra cosa';
  r = await tareas.sincronizar();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(incs[0].tarea_estado, 'borrada');
  r = await tareas.sincronizar();
  assert.strictEqual(r.creadas, 0);
  assert.strictEqual(enTareas.size, 0);

  // Llave mala: se dice; quitarla apaga el envío.
  await tareas.guardarConexion({ llave: 'mala' });
  assert.match((await tareas.sincronizar()).error, /llave/);
  await tareas.guardarConexion({ quitar: true });
  assert.strictEqual((await tareas.estado()).configurado, false);

  // Cambiar solo la dirección borra la llave guardada: no viaja a otro sitio.
  await tareas.guardarConexion({ url: url + '/', llave: 'otra' });
  await tareas.guardarConexion({ url });
  assert.strictEqual((await tareas.estado()).configurado, true);
  await tareas.guardarConexion({ url: 'https://otra.example.test' });
  assert.strictEqual((await tareas.estado()).configurado, false);
  assert.strictEqual((await tareas.estado()).url, 'https://otra.example.test');

  servidor.close();
  console.log('tareas: bien');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
