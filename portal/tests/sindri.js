// Pruebas de la conexión con Sindri (src/sindri.js) contra un Sindri falso y sin
// base de datos:   node portal/tests/sindri.js
const assert = require('assert');
const http = require('http');
const path = require('path');

// Base de datos en memoria: solo lo que usa src/sindri.js.
const trabajos = [
  { id: 1, codigo: 'SES-1', incidenciaId: 7, concepto: 'Impresora', dia: '2026-10-01', horas: 2, tarifa: 35, importe: 70, tipo: 'TIEMPO', sindriId: 'cli-1' },
  { id: 2, codigo: 'COB-1', incidenciaId: null, concepto: 'Cable', dia: '2026-10-02', horas: 0, tarifa: 0, importe: 12.5, tipo: 'UNICO', sindriId: 'cli-1' },
  { id: 3, codigo: 'SES-2', incidenciaId: 8, concepto: 'Sin ligar', dia: '2026-10-03', horas: 1, tarifa: 35, importe: 35, tipo: 'TIEMPO', sindriId: '' },
  { id: 4, codigo: 'SES-3', incidenciaId: 9, concepto: 'Sin producto', dia: '2026-10-04', horas: 1, tarifa: 35, importe: 35, tipo: 'TIEMPO', sindriId: 'cli-1' }
];
const marcados = {};
require.cache[path.join(__dirname, '../src/db.js')] = {
  exports: {
    consulta: async (sql, p) => {
      if (/FROM ha_trabajo t JOIN ha_cliente/.test(sql)) return trabajos.filter(t => !marcados[t.id]);
      if (/^UPDATE ha_trabajo SET sindri_en/.test(sql)) { marcados[p[2]] = { estado: p[0], pedido: p[1] }; return []; }
      if (/FROM ha_documento/.test(sql)) return [];
      throw new Error('Consulta no prevista: ' + sql);
    }
  }
};

const recibido = [];
const sindriFalso = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', d => { cuerpo += d; });
  req.on('end', () => {
    const responder = (status, datos) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(datos)); };
    if (req.headers.authorization !== 'Bearer sdi_buena') return responder(401, { error: 'Llave de integración no válida o revocada' });
    if (req.url === '/api/integracion/v1/yo') return responder(200, { app: 'incidencias', empresa: { code: '001', name: 'Mi empresa' } });
    if (req.url === '/api/integracion/v1/por-facturar' && req.method === 'POST') {
      const { elementos } = JSON.parse(cuerpo);
      recibido.push(...elementos);
      return responder(200, {
        elementos: elementos.map(e => e.ref === 'SES-3' ? { ref: e.ref, estado: 'error', error: 'No hay producto' } : { ref: e.ref, estado: 'creado' })
      });
    }
    responder(404, { error: 'No existe' });
  });
});

(async () => {
  await new Promise(r => sindriFalso.listen(0, r));
  process.env.SINDRI_URL = 'http://127.0.0.1:' + sindriFalso.address().port + '/';
  process.env.SINDRI_LLAVE = 'sdi_buena';
  process.env.SINDRI_PRODUCTO_GASTO = 'GASTO';
  const sindri = require('../src/sindri');

  // Lo que se manda por cada trabajo.
  assert.deepStrictEqual(sindri.elementoDe(trabajos[0], 'cli-1'),
    { ref: 'SES-1', cliente: 'cli-1', fecha: '2026-10-01', descripcion: 'Incidencia 7: Impresora', producto: 'HORA', cantidad: '2', precio: '35' });
  assert.deepStrictEqual(sindri.elementoDe(trabajos[1], 'cli-1'),
    { ref: 'COB-1', cliente: 'cli-1', fecha: '2026-10-02', descripcion: 'Cable', producto: 'GASTO', cantidad: '1', precio: '12.5' });

  const estado = await sindri.estado();
  assert.strictEqual(estado.empresa.code, '001');

  // Solo van los de clientes ligados; un error de Sindri no frena a los demás.
  const r = await sindri.enviar({ desde: '2026-10-01', hasta: '2026-10-31' });
  assert.deepStrictEqual(recibido.map(e => e.ref), ['SES-1', 'COB-1', 'SES-3']);
  assert.strictEqual(r.enviados, 2);
  assert.strictEqual(r.sinCliente, 1);
  assert.deepStrictEqual(r.errores, [{ codigo: 'SES-3', error: 'No hay producto' }]);
  assert.deepStrictEqual(Object.keys(marcados), ['1', '2']);
  assert.strictEqual(marcados[1].estado, 'pendiente');

  await assert.rejects(sindri.enviar({ desde: 'x', hasta: '2026-10-31' }), /fecha desde/);

  // Llave mala: un mensaje que se entiende.
  process.env.SINDRI_LLAVE = 'sdi_mala';
  const malo = await sindri.estado();
  assert.match(malo.error, /no acepta la llave/);

  // Sin configurar: el portal sigue igual.
  delete process.env.SINDRI_URL;
  assert.deepStrictEqual(await sindri.estado(), { activo: false });

  sindriFalso.close();
  console.log('sindri: todo bien');
})().catch(e => { console.error(e); process.exit(1); });
