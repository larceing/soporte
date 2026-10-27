// Pruebas de corregir una sesión de trabajo (src/facturacion.js, trabajoEditar y tramoValido).
// Sin base de datos: la base se sustituye por una en memoria.
//   node portal/tests/sesiones.js
const assert = require('assert');
const path = require('path');

const trabajos = [];
const notas = [];
const cambios = [];
const docs = [];
const config = new Map([['TARIFA_HORA', '15'], ['HORAS_MINIMAS', '1']]);

async function consulta(sql, p = []) {
  if (/FROM ha_config/.test(sql)) return [...config].map(([clave, valor]) => ({ clave, valor }));
  if (/SELECT usuario FROM ha_sindri_persona/.test(sql)) return [];
  if (/SELECT dueno, que FROM ha_compartir/.test(sql)) return [];
  if (/FROM ha_documento/.test(sql)) return docs;
  if (/FROM ha_trabajo WHERE id = \?/.test(sql)) return trabajos.filter(t => t.id === p[0]).map(t => ({ ...t }));
  if (/^UPDATE ha_trabajo SET inicio/.test(sql)) {
    const t = trabajos.find(x => x.id === p[7]);
    Object.assign(t, { inicio: p[0], fin: p[1], minutos: p[2], horas: p[3], importe: p[4], dia: p[5], detalle: p[6] });
    return [];
  }
  if (/^UPDATE ha_nota/.test(sql)) {
    Object.assign(notas.find(n => n.id === p[3]), { minutos: p[0], fecha: p[1], texto: p[2] });
    return [];
  }
  if (/INSERT INTO ha_cambio/.test(sql)) { cambios.push({ incidencia: p[0], campo: p[1], antes: p[2], despues: p[3] }); return []; }
  if (/UPDATE ha_incidencia SET actualizada/.test(sql)) return [];
  throw new Error('Consulta no prevista: ' + sql);
}
const pool = {
  getConnection: async () => ({
    query: async (sql, p) => [await consulta(sql, p)],
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}
  })
};
require.cache[path.join(__dirname, '../src/db.js')] = { id: 'db', loaded: true, exports: { consulta, pool } };

const fact = require('../src/facturacion');

(async () => {
  // La sesión del cronómetro olvidado: 26/10 09:45 (hora de España) y parada a las 02:00 del 27.
  const t = {
    id: 7, tipo: 'TIEMPO', incidencia_id: 58, nota_id: 70, detalle: 'Requisitos API', minutos: 975,
    tarifa: 15, inicio: new Date('2026-10-26T08:45:00Z'), fin: new Date('2026-10-27T01:00:00Z'),
    pago_id: null, sindri_pedido: null, sindri_empresa: null, autor: 'luis', dia: '2026-10-27'
  };
  trabajos.push(t);
  notas.push({ id: 70, minutos: 975, fecha: t.fin, texto: t.detalle });

  // Se corrige a 09:45-14:30 del 26: tiempo, horas, importe, día y nota cambian juntos.
  const r = await fact.trabajoEditar(7, { inicio: '2026-10-26T08:45:00Z', fin: '2026-10-26T13:30:00Z', texto: 'Requisitos API y acceso' }, 'luis');
  assert.deepStrictEqual(r, { id: 7, incidenciaId: 58, minutos: 285, horas: 5, importe: 75 });
  assert.strictEqual(t.dia, '2026-10-26');
  assert.strictEqual(t.detalle, 'Requisitos API y acceso');
  assert.strictEqual(notas[0].minutos, 285);
  assert.strictEqual(notas[0].texto, 'Requisitos API y acceso');
  assert.strictEqual(notas[0].fecha.toISOString(), '2026-10-26T13:30:00.000Z');
  assert.strictEqual(cambios.length, 1);
  assert.strictEqual(cambios[0].campo, 'Sesión');
  assert.strictEqual(cambios[0].antes, '26/10/2026, 09:45 – 27/10/2026, 02:00 (16 h 15 min)');
  assert.strictEqual(cambios[0].despues, '26/10/2026, 09:45 – 26/10/2026, 14:30 (4 h 45 min)');

  // Sin texto, se queda el que tenía.
  await fact.trabajoEditar(7, { inicio: '2026-10-26T08:45:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis');
  assert.strictEqual(t.detalle, 'Requisitos API y acceso');
  assert.strictEqual(t.horas, 1);

  // Lo que no vale.
  await assert.rejects(fact.trabajoEditar(7, { inicio: '2026-10-26T10:00:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis'), /posterior/);
  await assert.rejects(fact.trabajoEditar(7, { inicio: '2026-10-25T08:00:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis'), /24 horas/);
  await assert.rejects(fact.trabajoEditar(7, { inicio: 'ayer', fin: '' }, 'luis'), /hora de inicio/);
  const futuro = new Date(Date.now() + 3600000);
  await assert.rejects(fact.trabajoEditar(7, { inicio: new Date(futuro - 600000).toISOString(), fin: futuro.toISOString() }, 'luis'), /futuro/);
  await assert.rejects(fact.trabajoEditar(99, { inicio: '2026-10-26T08:00:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis'), /no encontrada/);

  // Lo ya cobrado o en Sindri no se toca, ni los gastos sueltos.
  t.sindri_pedido = 'PED-1';
  await assert.rejects(fact.trabajoEditar(7, { inicio: '2026-10-26T08:00:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis'), /Sindri/);
  t.sindri_pedido = null;
  t.pago_id = 3;
  await assert.rejects(fact.trabajoEditar(7, { inicio: '2026-10-26T08:00:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis'), /cobrada/);
  t.pago_id = null;
  trabajos.push({ id: 8, tipo: 'UNICO', pago_id: null });
  await assert.rejects(fact.trabajoEditar(8, { inicio: '2026-10-26T08:00:00Z', fin: '2026-10-26T09:00:00Z' }, 'luis'), /sesiones de trabajo/);

  // tramoValido redondea al minuto.
  assert.strictEqual(fact.tramoValido('2026-10-27T08:00:30Z', '2026-10-27T09:15:10Z').minutos, 75);

  console.log('Sesiones: correcto');
})().catch(err => { console.error(err); process.exit(1); });
