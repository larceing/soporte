// Pruebas de corregir una sesión de trabajo (src/facturacion.js, trabajoEditar y tramoValido).
// Sin base de datos: la base se sustituye por una en memoria.
//   node portal/tests/sesiones.js
const assert = require('assert');
const path = require('path');

const trabajos = [];
const notas = [];
const cambios = [];
const docs = [];
const config = new Map([['TARIFA_HORA', '15'], ['HORAS_MINIMAS', '1'], ['COBRO_POR', 'HORAS']]);

async function consulta(sql, p = []) {
  if (/FROM ha_config/.test(sql)) return [...config].map(([clave, valor]) => ({ clave, valor }));
  if (/SELECT usuario FROM ha_sindri_persona/.test(sql)) return [];
  if (/SELECT dueno, que FROM ha_compartir/.test(sql)) return [];
  if (/FROM ha_documento/.test(sql)) return docs;
  if (/FROM ha_trabajo WHERE id = \?/.test(sql)) return trabajos.filter(t => t.id === p[0]).map(t => ({ ...t }));
  if (/^UPDATE ha_trabajo SET inicio/.test(sql)) {
    const t = trabajos.find(x => x.id === p[8]);
    Object.assign(t, { inicio: p[0], fin: p[1], minutos: p[2], horas: p[3], importe: p[4], dia: p[5], detalle: p[6], horas_manual: p[7] });
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

  // Horas a cobrar a mano (recargo por franja): 11 minutos que se cobran como 2 h.
  const m = await fact.trabajoEditar(7, { inicio: '2026-10-26T23:12:00Z', fin: '2026-10-26T23:23:00Z', horas: '2' }, 'luis');
  assert.deepStrictEqual([m.minutos, m.horas, m.importe], [11, 2, 30]);
  assert.strictEqual(t.horas_manual, 2);
  assert.strictEqual(cambios[cambios.length - 1].campo, 'Horas a cobrar');
  assert.strictEqual(cambios[cambios.length - 1].despues, '2');
  // Vacío vuelve a lo automático; 1,5 vale; lo que no es número, no.
  assert.strictEqual((await fact.trabajoEditar(7, { inicio: '2026-10-26T23:12:00Z', fin: '2026-10-26T23:23:00Z', horas: '' }, 'luis')).horas, 1);
  assert.strictEqual((await fact.trabajoEditar(7, { inicio: '2026-10-26T23:12:00Z', fin: '2026-10-26T23:23:00Z', horas: '1,5' }, 'luis')).importe, 22.5);
  await assert.rejects(fact.trabajoEditar(7, { inicio: '2026-10-26T23:12:00Z', fin: '2026-10-26T23:23:00Z', horas: 'dos' }, 'luis'), /0,25 a 48/);
  await assert.rejects(fact.trabajoEditar(7, { inicio: '2026-10-26T23:12:00Z', fin: '2026-10-26T23:23:00Z', horas: '60' }, 'luis'), /0,25 a 48/);

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

  // Por franjas de reloj, con 1 h de recargo si algo cae fuera de 8:00-17:00 (hora de España).
  const cfg = { HORAS_MINIMAS: '1', COBRO_POR: 'FRANJAS', HORARIO_DESDE: '8', HORARIO_HASTA: '17', RECARGO_HORAS: '1' };
  const h = (a, b) => fact.horasFacturables(0, cfg, a, b);
  assert.strictEqual(h('2026-10-27T09:00:00Z', '2026-10-27T09:20:00Z'), 1);   // 10:00-10:20
  assert.strictEqual(h('2026-10-27T08:00:00Z', '2026-10-27T10:00:00Z'), 2);   // 09:00-11:00
  assert.strictEqual(h('2026-10-27T08:50:00Z', '2026-10-27T09:10:00Z'), 2);   // 09:50-10:10
  assert.strictEqual(h('2026-10-26T22:50:00Z', '2026-10-26T23:10:00Z'), 3);   // 23:50-00:10
  assert.strictEqual(h('2026-10-26T22:38:00Z', '2026-10-26T23:08:00Z'), 3);   // 23:38-00:08 (#57)
  assert.strictEqual(h('2026-10-26T23:12:00Z', '2026-10-26T23:23:00Z'), 2);   // 00:12-00:23 (#58)
  assert.strictEqual(h('2026-10-26T23:59:00Z', '2026-10-27T02:00:00Z'), 4);   // 00:59-03:00
  assert.strictEqual(h('2026-10-27T15:30:00Z', '2026-10-27T16:30:00Z'), 3);   // 16:30-17:30
  assert.strictEqual(h('2026-07-15T06:00:00Z', '2026-07-15T07:00:00Z'), 1);   // verano: 08:00-09:00
  assert.strictEqual(h('2026-07-15T05:59:00Z', '2026-07-15T06:30:00Z'), 3);   // verano: 07:59-08:30
  assert.strictEqual(fact.horasFacturables(25, { ...cfg, COBRO_POR: 'HORAS' }, '2026-10-26T23:12:00Z', '2026-10-26T23:37:00Z'), 1);

  // La sesión corregida se cuenta por franjas.
  config.set('COBRO_POR', 'FRANJAS');
  const n = await fact.trabajoEditar(7, { inicio: '2026-10-26T22:38:00Z', fin: '2026-10-26T23:08:00Z' }, 'luis');
  assert.deepStrictEqual([n.minutos, n.horas, n.importe], [30, 3, 45]);
  assert.strictEqual(t.horas_manual, null);

  // tramoValido redondea al minuto.
  assert.strictEqual(fact.tramoValido('2026-10-27T08:00:30Z', '2026-10-27T09:15:10Z').minutos, 75);

  console.log('Sesiones: correcto');
})().catch(err => { console.error(err); process.exit(1); });
