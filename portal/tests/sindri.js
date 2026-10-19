// Pruebas del envío automático a Sindri (src/sindri.js) contra un Sindri de mentira. Sin base de
// datos: la base se sustituye por una en memoria.
//   node portal/tests/sindri.js
const assert = require('assert');
const http = require('http');
const path = require('path');

// Base de datos en memoria con lo justo para src/sindri.js y src/facturacion.js.
const config = new Map([['TARIFA_HORA', '15'], ['IVA', '10']]);
let trabajos = [];
const clientes = [{ id: 1, nombre: 'Cliente', razon_social: 'Cliente SL', nif: 'B-11111111', activo: 1 }];
async function consulta(sql, p = []) {
  if (/DELETE FROM ha_config/.test(sql)) { config.delete('SINDRI_LLAVE'); return []; }
  if (/FROM ha_config WHERE clave IN/.test(sql)) return [...config].filter(([k]) => k.startsWith('SINDRI_')).map(([clave, valor]) => ({ clave, valor }));
  if (/FROM ha_config/.test(sql)) return [...config].map(([clave, valor]) => ({ clave, valor }));
  if (/INSERT INTO ha_config/.test(sql)) { config.set(p[0], p[1]); return []; }
  if (/FROM ha_cliente/.test(sql)) return clientes;
  if (/FROM ha_documento/.test(sql)) return [];
  if (/FROM ha_trabajo/.test(sql)) return trabajos.filter(t => t.estado === 'CERRADA' && !t.pago_id);
  if (/UPDATE ha_trabajo SET sindri_pedido = \? WHERE codigo/.test(sql)) { trabajos.filter(t => t.codigo === p[1]).forEach(t => { t.sindri_pedido = p[0]; }); return []; }
  if (/UPDATE ha_trabajo SET sindri_pedido = NULL/.test(sql)) { trabajos.filter(t => !(p[0] || []).includes(t.codigo)).forEach(t => { t.sindri_pedido = null; }); return []; }
  throw new Error('Consulta no prevista: ' + sql);
}
require.cache[path.join(__dirname, '../src/db.js')] = { id: 'db', loaded: true, exports: { consulta } };

const sindri = require('../src/sindri');
const fact = require('../src/facturacion');

// Sindri de mentira: lo pendiente por referencia, como su API de integración.
const LLAVE = 'sdi_prueba';
const enSindri = new Map();
const servidor = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    const responder = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.headers.authorization !== 'Bearer ' + LLAVE) return responder(401, { error: 'Llave no válida' });
    const u = req.url.replace('/api/integracion/v1', '');
    if (u === '/yo') return responder(200, { app: 'incidencias', empresa: { name: 'Mi empresa' } });
    if (u === '/clientes') return responder(200, [{ id: '0f0e0d0c-0000-4000-8000-000000000001', name: 'Cliente SL', tax_id: 'B11111111' }]);
    if (u === '/por-facturar' && req.method === 'POST') {
      const out = JSON.parse(cuerpo).elementos.map(e => {
        if (e.producto === 'NO-EXISTE') return { ref: e.ref, estado: 'error', error: 'No hay producto' };
        const antes = enSindri.get(e.ref);
        if (antes && antes.estado !== 'pendiente') return { ref: e.ref, estado: 'en_pedido', pedido: antes.pedido };
        enSindri.set(e.ref, { ...e, estado: 'pendiente' });
        return { ref: e.ref, estado: antes ? 'actualizado' : 'creado' };
      });
      return responder(200, { elementos: out });
    }
    if (u === '/por-facturar') return responder(200, [...enSindri.values()].map(e => ({ ref: e.ref, estado: e.estado, pedido: e.pedido || null })));
    if (u === '/productos') return responder(200, [{ sku: 'MIO', name: 'Mi servicio', kind: 'service', uom: 'h' }, { sku: 'CAJA', name: 'Caja', kind: 'stockable', uom: 'ud' }]);
    if (req.method === 'DELETE') { enSindri.delete(decodeURIComponent(u.split('/').pop())); return responder(200, { ok: true }); }
    responder(404, {});
  });
});

const base = { cliente_id: 1, estado: 'CERRADA', pago_id: null, tipo: 'TIEMPO', tarifa: 15, dia: '2026-10-01', incidencia_tipo: 'Petición' };

(async () => {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + servidor.address().port;

  // Sin llave no se envía nada.
  assert.strictEqual(await sindri.sincronizar(), null);
  assert.strictEqual((await sindri.estado()).configurado, false);

  // La llave se guarda pero nunca sale en la configuración ni en el estado.
  await sindri.guardarConexion({ url: url + '/', llave: 'mala' });
  assert.ok(!('SINDRI_LLAVE' in await fact.config()));
  const est = await sindri.estado();
  assert.strictEqual(est.url, url);
  assert.ok(!JSON.stringify(est).includes('mala'));
  let r = await sindri.sincronizar();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /llave/);

  await sindri.guardarConexion({ llave: LLAVE });
  trabajos = [
    { ...base, id: 1, codigo: 'SES-1', horas: 2, concepto: 'Gateway: credenciales', incidencia_codigo: 'PET_1', incidencia_titulo: 'Gateway: credenciales' },
    { ...base, id: 2, codigo: 'SES-2', horas: 1, concepto: 'Informe de ventas', incidencia_codigo: 'PET_2', incidencia_titulo: 'Informe de ventas' },
    { ...base, id: 3, codigo: 'COB-1', tipo: 'UNICO', horas: 0, importe: 9.5, concepto: 'Licencia', incidencia_tipo: null }
  ];
  r = await sindri.sincronizar();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.creado, 3);
  assert.strictEqual(r.empresa, 'Mi empresa');
  assert.strictEqual(r.aviso, '');
  assert.strictEqual(enSindri.get('SES-1').producto, 'SOP-BI-GW');
  assert.strictEqual(enSindri.get('SES-1').cliente, '0f0e0d0c-0000-4000-8000-000000000001');
  assert.strictEqual(enSindri.get('SES-1').cantidad, '2');
  assert.strictEqual(enSindri.get('SES-2').producto, 'SOP-BI-INF');
  assert.strictEqual(enSindri.get('COB-1').producto, 'SOP-CARGO');
  assert.strictEqual(enSindri.get('COB-1').precio, '9.5');

  // Cambian las horas de uno, otro se reabre y un tercero ya está en un pedido de Sindri.
  trabajos[0].horas = 3;
  trabajos[1].estado = 'ABIERTA';
  enSindri.get('COB-1').estado = 'en_pedido';
  r = await sindri.sincronizar();
  assert.strictEqual(r.actualizado, 1);
  assert.strictEqual(r.en_pedido, 1);
  assert.strictEqual(r.retirados, 1);
  assert.strictEqual(enSindri.get('SES-1').cantidad, '3');
  assert.ok(!enSindri.has('SES-2'));
  assert.ok(enSindri.has('COB-1'));

  // Un cliente que Sindri no tiene se cuenta como error y no para lo demás.
  clientes.push({ id: 2, nombre: 'Nuevo', nif: 'X1', activo: 1 });
  trabajos.push({ ...base, id: 4, cliente_id: 2, codigo: 'SES-4', horas: 1, concepto: 'Algo' });
  r = await sindri.sincronizar();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.errores.map(e => e.ref), ['SES-4']);

  // El servicio elegido en la incidencia manda sobre el deducido.
  trabajos[0].incidencia_servicio = 'MIO';
  await sindri.sincronizar();
  assert.strictEqual(enSindri.get('SES-1').producto, 'MIO');

  // Lo que está en un pedido de Sindri queda marcado aquí con su número, y se desmarca si vuelve.
  assert.ok(!trabajos[2].sindri_pedido);
  enSindri.get('COB-1').pedido = 'PV-0001';
  await sindri.sincronizar();
  assert.strictEqual(trabajos[2].sindri_pedido, 'PV-0001');
  enSindri.get('COB-1').estado = 'pendiente';
  await sindri.sincronizar();
  assert.strictEqual(trabajos[2].sindri_pedido, null);

  // Para elegir: los servicios por horas de Sindri.
  assert.deepStrictEqual(await sindri.servicios(), { desde: 'sindri', servicios: [{ sku: 'MIO', name: 'Mi servicio' }] });

  // Quitar la llave apaga el envío.
  await sindri.guardarConexion({ quitar: true });
  assert.strictEqual((await sindri.estado()).configurado, false);
  assert.strictEqual((await sindri.servicios()).desde, 'gestor');

  servidor.close();
  console.log('sindri: bien');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
