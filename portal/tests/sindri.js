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
const personasLlave = new Map();
const permisos = [];
async function consulta(sql, p = []) {
  if (/SELECT dueno FROM ha_horas_permiso WHERE usuario/.test(sql)) return permisos.filter(x => x.usuario === p[0]).map(x => ({ dueno: x.dueno }));
  if (/SELECT usuario FROM ha_horas_permiso WHERE dueno/.test(sql)) return permisos.filter(x => x.dueno === p[0]).map(x => ({ usuario: x.usuario }));
  if (/INSERT IGNORE INTO ha_horas_permiso/.test(sql)) { if (!permisos.some(x => x.dueno === p[0] && x.usuario === p[1])) permisos.push({ dueno: p[0], usuario: p[1] }); return []; }
  if (/DELETE FROM ha_horas_permiso/.test(sql)) { permisos.splice(0, permisos.length, ...permisos.filter(x => !(x.dueno === p[0] && x.usuario === p[1]))); return []; }
  if (/SELECT usuario FROM ha_sindri_persona/.test(sql)) return [...personasLlave.keys()].map(usuario => ({ usuario }));
  if (/FROM ha_trabajo WHERE id = \?/.test(sql)) return trabajos.filter(t => t.id === p[0]);
  if (/FROM ha_sindri_persona/.test(sql)) return [...personasLlave].map(([usuario, llave]) => ({ usuario, llave }));
  if (/INSERT INTO ha_sindri_persona/.test(sql)) { personasLlave.set(p[0], p.length > 1 ? p[1] : ''); return []; }
  if (/DELETE FROM ha_config/.test(sql)) { config.delete('SINDRI_LLAVE'); return []; }
  if (/FROM ha_config WHERE clave IN/.test(sql)) return [...config].filter(([k]) => k.startsWith('SINDRI_')).map(([clave, valor]) => ({ clave, valor }));
  if (/FROM ha_config/.test(sql)) return [...config].map(([clave, valor]) => ({ clave, valor }));
  if (/INSERT INTO ha_config/.test(sql)) { config.set(p[0], p[1]); return []; }
  if (/FROM ha_cliente/.test(sql)) return clientes;
  if (/FROM ha_documento/.test(sql)) return [];
  if (/FROM ha_trabajo/.test(sql)) return trabajos.filter(t => t.estado === 'CERRADA' && !t.pago_id);
  if (/UPDATE ha_trabajo SET sindri_pedido = \?, sindri_empresa = \? WHERE codigo/.test(sql)) { trabajos.filter(t => t.codigo === p[2]).forEach(t => { t.sindri_pedido = p[0]; t.sindri_empresa = p[1]; }); return []; }
  if (/UPDATE ha_trabajo SET sindri_pedido = NULL/.test(sql)) { trabajos.filter(t => t.sindri_pedido && (t.sindri_empresa || '') === p[0] && !(p[1] || []).includes(t.codigo)).forEach(t => { t.sindri_pedido = null; }); return []; }
  throw new Error('Consulta no prevista: ' + sql);
}
require.cache[path.join(__dirname, '../src/db.js')] = { id: 'db', loaded: true, exports: { consulta } };

const sindri = require('../src/sindri');
const { CATALOGO } = require('../src/servicios');
const fact = require('../src/facturacion');

// Sindri de mentira: lo pendiente por referencia, como su API de integración.
const LLAVE = 'sdi_prueba';
const LLAVE_IVAN = 'sdi_ivan';
const enSindriLuis = new Map();
const enSindri = enSindriLuis;
const enSindriIvan = new Map();
let conAltas = false;
const clientesSindri = [{ id: '0f0e0d0c-0000-4000-8000-000000000001', name: 'Cliente SL', tax_id: 'B11111111' }];
const productosSindri = [{ sku: 'MIO', name: 'Mi servicio', kind: 'service', uom: 'h' }, { sku: 'CAJA', name: 'Caja', kind: 'stockable', uom: 'ud' }];
const servidor = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    const responder = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const ivan = req.headers.authorization === 'Bearer ' + LLAVE_IVAN;
    if (!ivan && req.headers.authorization !== 'Bearer ' + LLAVE) return responder(401, { error: 'Llave no válida' });
    const enSindri = ivan ? enSindriIvan : enSindriLuis;
    const u = req.url.replace('/api/integracion/v1', '');
    if (u === '/yo') return responder(200, { app: 'incidencias', empresa: ivan ? { code: '002', name: 'Empresa de Ivan' } : { code: '001', name: 'Mi empresa' } });
    if (u === '/clientes' && req.method === 'POST') {
      if (!conAltas) return responder(404, {});
      const b = JSON.parse(cuerpo);
      if (b.tax_id === 'X1') return responder(422, { error: 'NIF no válido: X1' });
      const ya = clientesSindri.find(x => x.name.toLowerCase() === b.name.toLowerCase());
      if (ya) return responder(200, { id: ya.id, creado: false });
      const id = '0f0e0d0c-0000-4000-8000-00000000000' + (clientesSindri.length + 1);
      clientesSindri.push({ id, ...b });
      return responder(201, { id, creado: true });
    }
    if (u === '/clientes') return responder(200, clientesSindri);
    if (u === '/productos' && req.method === 'POST') {
      if (!conAltas) return responder(404, {});
      const b = JSON.parse(cuerpo);
      productosSindri.push({ ...b, kind: 'service' });
      return responder(201, { id: b.sku, creado: true });
    }
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
    if (u === '/productos') return responder(200, productosSindri);
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

  // Con un Sindri que da de alta: el cliente que falta (con sus datos) y los servicios que se usan.
  conAltas = true;
  clientes.push({ id: 3, nombre: 'Taller Norte', nif: 'B22222222', email: 'a@example.test', activo: 1 });
  trabajos.push({ ...base, id: 5, cliente_id: 3, codigo: 'SES-5', horas: 1, concepto: 'Otra cosa' });
  r = await sindri.sincronizar();
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.altas.clientes, 1);
  assert.ok(r.altas.servicios >= 1);
  assert.ok(clientesSindri.some(x => x.name === 'Taller Norte' && x.tax_id === 'B22222222' && x.email === 'a@example.test'));
  assert.ok(productosSindri.some(x => x.sku === 'SOP-CARGO' && x.uom === 'ud'));
  assert.strictEqual(enSindri.get('SES-5').cliente, clientesSindri.find(x => x.name === 'Taller Norte').id);
  // El NIF mal escrito no entra: queda como error, con el motivo, y no para lo demás.
  assert.ok(r.errores.some(e => e.ref === 'Nuevo' && /NIF/.test(e.error)));
  assert.ok(r.errores.some(e => e.ref === 'SES-4'));
  r = await sindri.sincronizar();
  assert.deepStrictEqual(r.altas, { clientes: 0, servicios: 0 });

  // Para elegir: el catálogo entero (con el nombre de Sindri si allí lo tienen) y lo que solo está en Sindri, en «Otros».
  productosSindri.splice(2);
  productosSindri.push({ sku: 'SOP-INC', name: 'Incidencias (Sindri)', kind: 'service', uom: 'h' });
  const elegir = await sindri.servicios();
  assert.strictEqual(elegir.desde, 'sindri');
  assert.strictEqual(elegir.servicios.length, CATALOGO.length + 1);
  assert.strictEqual(elegir.servicios.find(s => s.sku === 'DOCKER-INC').alias, 'contenedores');
  assert.deepStrictEqual(elegir.servicios.at(-1), { sku: 'MIO', name: 'Mi servicio', area: 'Otros' });
  assert.strictEqual(elegir.servicios.find(s => s.sku === 'SOP-INC').name, 'Incidencias (Sindri)');
  assert.ok(elegir.servicios.find(s => s.sku === 'INF-DOCKER'));

  // Dos técnicos, cada uno con su empresa: las horas de Ivan van a la suya y salen de la general.
  await assert.rejects(sindri.guardarMia('ivan', { llave: LLAVE }), /misma empresa/);
  await assert.rejects(sindri.guardarMia('ivan', { llave: 'falsa' }), /no acepta/);
  trabajos.push({ ...base, id: 6, codigo: 'SES-6', horas: 2, concepto: 'De Ivan', autor: 'ivan' });
  await sindri.sincronizar();
  assert.ok(enSindri.has('SES-6'));
  let e = await sindri.guardarMia('ivan', { llave: LLAVE_IVAN });
  assert.strictEqual(e.mia.configurada, true);
  assert.ok(!JSON.stringify(e).includes(LLAVE_IVAN));
  r = await sindri.sincronizar();
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(!enSindri.has('SES-6'));
  assert.ok(enSindriIvan.has('SES-6'));
  assert.ok(!enSindriIvan.has('SES-1'));
  e = await sindri.estado('ivan');
  assert.strictEqual(e.mia.ultima.empresa, 'Empresa de Ivan');
  assert.deepStrictEqual(e.personas, ['ivan']);
  assert.strictEqual((await sindri.estado('luis')).mia.configurada, false);
  // Un pedido de Ivan queda marcado con su empresa y la general no se lo quita.
  enSindriIvan.get('SES-6').estado = 'en_pedido';
  enSindriIvan.get('SES-6').pedido = 'PV-I1';
  await sindri.sincronizar();
  assert.strictEqual(trabajos.find(t => t.id === 6).sindri_pedido, 'PV-I1');
  assert.strictEqual(trabajos.find(t => t.id === 6).sindri_empresa, 'ivan');
  // Si Ivan quita su llave, lo suyo espera: no pasa a la empresa general.
  trabajos.push({ ...base, id: 7, codigo: 'SES-7', horas: 1, concepto: 'Más de Ivan', autor: 'ivan' });
  e = await sindri.guardarMia('ivan', { quitar: true });
  assert.strictEqual(e.mia.enEspera, true);
  await sindri.sincronizar();
  assert.ok(!enSindri.has('SES-7'));
  assert.ok(!enSindriIvan.has('SES-7'));
  assert.strictEqual(trabajos.find(t => t.id === 6).sindri_pedido, 'PV-I1');

  // Ninguno ve lo que cobra el otro, salvo que se lo deje ver.
  const codigos = l => l.map(t => t.codigo).sort();
  assert.deepStrictEqual(codigos(await fact.trabajos({}, 'ivan')), ['SES-6', 'SES-7']);
  assert.ok(!codigos(await fact.trabajos({}, 'luis')).some(c => c === 'SES-6' || c === 'SES-7'));
  assert.ok(codigos(await fact.trabajos({}, 'luis')).includes('SES-1'));
  assert.strictEqual((await sindri.estado('ivan')).ultima, null);
  assert.ok((await sindri.estado('luis')).ultima);
  let p = await fact.permisoGuardar('ivan', 'luis', true);
  assert.deepStrictEqual(p.dejo, ['luis']);
  const visto = (await fact.trabajos({}, 'luis')).find(t => t.codigo === 'SES-7');
  assert.ok(visto && visto.deOtro);
  await assert.rejects(fact.trabajoEstado(7, 'NO_COBRAR', 'luis'), /no es tuyo/);
  assert.ok(!(await fact.trabajos({}, 'ivan')).some(t => t.codigo === 'SES-1'));
  p = await fact.permisoGuardar('ivan', 'luis', false);
  assert.deepStrictEqual(p.dejo, []);
  assert.ok(!(await fact.trabajos({}, 'luis')).some(t => t.codigo === 'SES-7'));

  // Quitar la llave apaga el envío.
  await sindri.guardarConexion({ quitar: true });
  assert.strictEqual((await sindri.estado()).configurado, false);
  assert.strictEqual((await sindri.servicios()).desde, 'gestor');

  // Cambiar solo la dirección borra la llave guardada: no viaja a otro sitio.
  await sindri.guardarConexion({ url: url + '/', llave: 'otra' });
  await sindri.guardarConexion({ url });
  assert.strictEqual((await sindri.estado()).configurado, true);
  await sindri.guardarConexion({ url: 'https://otra.example.test' });
  assert.strictEqual((await sindri.estado()).configurado, false);
  assert.strictEqual((await sindri.estado()).url, 'https://otra.example.test');

  servidor.close();
  console.log('sindri: bien');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
