// 30 escenarios de cobro con dos técnicos, cada uno con su empresa de Sindri, contra un Odin y un
// Sindri de verdad en marcha (en local, con bases de datos vacías):
//  - luis: lleva el gestor (grupo general) y factura en la 001.
//  - ivan: trabaja con su propia empresa, la 002 (clientes y productos de la 001).
//  - pepe: trabaja para Luis (grupo general).
//
// CREA DATOS: solo contra instancias de prueba recién creadas.
//
//   ODIN=http://localhost:8090 SINDRI=http://localhost:8000 \
//   CLAVE_LUIS=... CLAVE_IVAN=... CLAVE_PEPE=... node tests/escenarios-cobro.js
//
// Sindri en modo local (sin SSO): el puesto local administra y elige empresa con su cookie.

const assert = require('assert');

const ODIN = process.env.ODIN || 'http://localhost:8090';
const SINDRI = process.env.SINDRI || 'http://localhost:8000';
const CLAVES = { luis: process.env.CLAVE_LUIS, ivan: process.env.CLAVE_IVAN, pepe: process.env.CLAVE_PEPE };

const tarros = {};
async function pedir(base, tarro, metodo, ruta, cuerpo) {
  const t = tarros[tarro] = tarros[tarro] || {};
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: {
      ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Cookie: Object.entries(t).map(([k, v]) => k + '=' + v).join('; ')
    },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    redirect: 'manual'
  });
  for (const c of r.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    t[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const texto = await r.text();
  let datos;
  try { datos = JSON.parse(texto); } catch (e) { datos = texto; }
  return { status: r.status, datos };
}
const odin = (quien, metodo, ruta, cuerpo) => pedir(ODIN, 'odin-' + quien, metodo, '/api' + ruta, cuerpo);
const sindri = (empresa, metodo, ruta, cuerpo) => pedir(SINDRI, 'sindri-' + empresa, metodo, '/api/v1' + ruta, cuerpo);
const ok = (r, status = 200) => { assert.strictEqual(r.status, status, JSON.stringify(r.datos).slice(0, 300)); return r.datos; };

// Lo pendiente de facturar en una empresa de Sindri, por referencia de Odin (partner_name es el
// nombre comercial, que en Odin es el nombre del cliente).
async function porFacturar(empresa, estado) {
  const lista = ok(await sindri(empresa, 'GET', '/por-facturar' + (estado ? '?state=' + estado : '')));
  return new Map(lista.map(i => [i.external_ref, i]));
}
const enviar = quien => odin(quien, 'POST', '/sindri/enviar', {});
async function enviarTodo() { ok(await enviar('luis')); }
const trabajosDe = async quien => ok(await odin(quien, 'GET', '/trabajos'));
const ultimo = async (quien, filtro) => (await trabajosDe(quien)).filter(filtro || (() => true))[0];

const resultados = [];
async function escenario(n, nombre, fn) {
  try {
    await fn();
    resultados.push({ n, nombre, ok: true });
  } catch (e) {
    resultados.push({ n, nombre, ok: false, error: e.message.replace(/\s+/g, ' ').slice(0, 300) });
  }
}

const ids = {};
const llaves = {};

async function preparar() {
  // Sindri: la 001 de Luis y la 002 de Ivan, que usa los clientes y productos de la 001.
  ids.c001 = ok(await sindri('001', 'PUT', '/company', { name: 'Luis Consultoría', tax_id: 'B12345674', code: '001' })).id;
  ids.c002 = ok(await sindri('001', 'POST', '/companies', { name: 'Ivan Servicios', tax_id: 'B41234568', code: '002' }), 201).id;
  ok(await sindri('001', 'POST', '/session/company', { company_id: ids.c001 }));
  ok(await sindri('002', 'POST', '/session/company', { company_id: ids.c002 }));
  ok(await sindri('002', 'PUT', '/company/sharing', { master_company_id: ids.c001 }));
  llaves.k1 = ok(await sindri('001', 'POST', '/integraciones/llaves', { name: 'incidencias' }), 201).key;
  llaves.k2 = ok(await sindri('002', 'POST', '/integraciones/llaves', { name: 'incidencias' }), 201).key;

  for (const quien of ['luis', 'ivan', 'pepe']) ok(await odin(quien, 'POST', '/login', { usuario: quien, clave: CLAVES[quien] }));
  ok(await odin('luis', 'PUT', '/sindri', { url: SINDRI, llave: llaves.k1 }));
  ok(await odin('luis', 'POST', '/clientes', { nombre: 'Cliente Común', nif: 'B20128567', razon_social: 'Cliente Común SL' }));
  ok(await odin('luis', 'POST', '/clientes', { nombre: 'Cliente Norte', nif: 'A58818501', razon_social: 'Cliente Norte SA' }));
  const clientes = ok(await odin('luis', 'GET', '/clientes'));
  ids.comun = clientes.find(c => c.nombre === 'Cliente Común').id;
  ids.norte = clientes.find(c => c.nombre === 'Cliente Norte').id;
}

const incidencia = async (quien, titulo, extra) => ok(await odin(quien, 'POST', '/incidencias', { tipo: 'Incidencia', titulo, descripcion: titulo, ...extra }), 201);
const apuntar = async (quien, inc, minutos) => odin(quien, 'POST', '/incidencias/' + inc.id + '/notas', { texto: 'Trabajo de ' + quien, minutos });

(async () => {
  await preparar();
  const inc = {};
  const ref = {};

  await escenario(1, 'Luis abre una incidencia sin cliente y apunta 90 min: 2 h a 15 € en la 001, a su cliente por defecto', async () => {
    inc.l1 = await incidencia('luis', 'Servidor caído');
    ok(await apuntar('luis', inc.l1, 90), 201);
    await enviarTodo();
    ref.l1 = (await ultimo('luis')).codigo;
    const i = (await porFacturar('001')).get(ref.l1);
    assert.ok(i, 'no está en la 001');
    assert.strictEqual(Number(i.quantity), 2);
    assert.strictEqual(Number(i.price), 15);
    assert.strictEqual(i.partner_name, 'Cliente Común');
  });

  await escenario(2, 'Luis abre una incidencia para Cliente Norte: se le cobra a Norte', async () => {
    inc.l2 = await incidencia('luis', 'Copias de seguridad', { clienteId: ids.norte });
    ok(await apuntar('luis', inc.l2, 30), 201);
    await enviarTodo();
    ref.l2 = (await ultimo('luis')).codigo;
    assert.strictEqual((await porFacturar('001')).get(ref.l2).partner_name, 'Cliente Norte');
  });

  await escenario(3, 'Ivan intenta poner una llave de la 001 como suya: se rechaza', async () => {
    const r = await odin('ivan', 'PUT', '/sindri/mia', { llave: llaves.k1 });
    assert.strictEqual(r.status, 422);
    assert.match(r.datos.error, /misma empresa/);
  });

  await escenario(4, 'Ivan pone una llave falsa: se rechaza', async () => {
    const r = await odin('ivan', 'PUT', '/sindri/mia', { llave: 'sdi_falsa' });
    assert.strictEqual(r.status, 422);
  });

  await escenario(5, 'Ivan pone la llave de la 002: su tarifa por defecto es 1', async () => {
    const e = ok(await odin('ivan', 'PUT', '/sindri/mia', { llave: llaves.k2 }));
    assert.strictEqual(e.mia.configurada, true);
    assert.ok(!JSON.stringify(e).includes(llaves.k2), 'la llave vuelve al navegador');
    assert.strictEqual(ok(await odin('ivan', 'GET', '/horas/tarifa')).seAplica, 1);
  });

  await escenario(6, 'Ivan da de alta su cliente, abre incidencia y apunta 60 min: 1 h a 1 € en la 002 y nada en la 001', async () => {
    ok(await odin('ivan', 'POST', '/clientes', { nombre: 'Cliente Sur', nif: 'B91234567', razon_social: 'Cliente Sur SL' }));
    ids.sur = ok(await odin('ivan', 'GET', '/clientes')).find(c => c.nombre === 'Cliente Sur').id;
    inc.i1 = await incidencia('ivan', 'Correo no sale', { clienteId: ids.sur });
    ok(await apuntar('ivan', inc.i1, 60), 201);
    await enviarTodo();
    ref.i1 = (await ultimo('ivan')).codigo;
    const i = (await porFacturar('002')).get(ref.i1);
    assert.ok(i, 'no está en la 002');
    assert.strictEqual(Number(i.price), 1);
    assert.strictEqual(i.partner_name, 'Cliente Sur');
    assert.ok(!(await porFacturar('001')).has(ref.i1), 'también está en la 001');
  });

  await escenario(7, 'Ivan pone su tarifa a 40: lo siguiente sale a 40 €', async () => {
    ok(await odin('ivan', 'PUT', '/horas/tarifa', { tarifa: '40' }));
    ok(await apuntar('ivan', inc.i1, 45), 201);
    await enviarTodo();
    ref.i1b = (await ultimo('ivan')).codigo;
    assert.strictEqual(Number((await porFacturar('002')).get(ref.i1b).price), 40);
  });

  await escenario(8, 'Luis no ve la incidencia de Ivan ni en la lista ni por su número', async () => {
    assert.ok(!ok(await odin('luis', 'GET', '/incidencias')).some(i => i.id === inc.i1.id));
    assert.strictEqual((await odin('luis', 'GET', '/incidencias/' + inc.i1.id)).status, 404);
  });

  await escenario(9, 'Ivan no ve las incidencias de Luis', async () => {
    assert.ok(!ok(await odin('ivan', 'GET', '/incidencias')).some(i => i.id === inc.l1.id));
    assert.strictEqual((await odin('ivan', 'GET', '/incidencias/' + inc.l1.id)).status, 404);
  });

  await escenario(10, 'Ninguno ve las horas ni los importes del otro', async () => {
    const deLuis = await trabajosDe('luis');
    const deIvan = await trabajosDe('ivan');
    assert.ok(!deLuis.some(t => t.codigo === ref.i1));
    assert.ok(!deIvan.some(t => t.codigo === ref.l1));
  });

  await escenario(11, 'Ivan no puede apuntar horas en una incidencia de Luis que no le ha compartido', async () => {
    assert.strictEqual((await apuntar('ivan', inc.l2, 30)).status, 404);
  });

  await escenario(12, 'Luis le comparte sus incidencias a Ivan: Ivan ya las ve', async () => {
    ok(await odin('luis', 'PUT', '/compartir', { usuario: 'ivan', que: 'incidencias', ver: true }));
    assert.ok(ok(await odin('ivan', 'GET', '/incidencias')).some(i => i.id === inc.l2.id));
  });

  await escenario(13, 'Ivan trabaja 2 h en la incidencia de Luis para Norte: se cobra desde la 002, a Norte y a 40 €', async () => {
    ok(await apuntar('ivan', inc.l2, 120), 201);
    await enviarTodo();
    ref.i2 = (await ultimo('ivan')).codigo;
    const i = (await porFacturar('002')).get(ref.i2);
    assert.ok(i, 'no está en la 002');
    assert.strictEqual(i.partner_name, 'Cliente Norte');
    assert.strictEqual(Number(i.quantity), 2);
    assert.strictEqual(Number(i.price), 40);
    assert.ok(!(await porFacturar('001')).has(ref.i2), 'también lo cobra la 001');
  });

  await escenario(14, 'En la incidencia compartida Luis solo ve sus sesiones, no las de Ivan', async () => {
    const d = ok(await odin('luis', 'GET', '/incidencias/' + inc.l2.id));
    assert.ok(d.sesiones.some(s => s.codigo === ref.l2));
    assert.ok(!d.sesiones.some(s => s.codigo === ref.i2));
  });

  await escenario(15, 'Ivan le deja ver sus horas a Luis: las ve con su importe, pero no las cambia', async () => {
    ok(await odin('ivan', 'PUT', '/compartir', { usuario: 'luis', que: 'horas', ver: true }));
    const t = (await trabajosDe('luis')).find(x => x.codigo === ref.i2);
    assert.ok(t && t.deOtro);
    assert.strictEqual(Number(t.importe), 80);
    assert.strictEqual((await odin('luis', 'POST', '/trabajos/' + t.id + '/estado', { estado: 'NO_COBRAR' })).status, 403);
  });

  await escenario(16, 'Luis también trabaja en esa incidencia: cada uno cobra lo suyo desde su empresa', async () => {
    ok(await apuntar('luis', inc.l2, 60), 201);
    await enviarTodo();
    ref.l2b = (await ultimo('luis', t => !t.deOtro)).codigo;
    assert.strictEqual(Number((await porFacturar('001')).get(ref.l2b).price), 15);
    assert.ok((await porFacturar('002')).has(ref.i2));
  });

  await escenario(17, 'Ivan pasa sus horas de Norte a un pedido en la 002: Odin lo marca y ya no se pueden cambiar', async () => {
    const i = (await porFacturar('002')).get(ref.i2);
    ok(await sindri('002', 'POST', '/por-facturar/pedido', { ids: [i.id] }), 201);
    await enviarTodo();
    const t = (await trabajosDe('ivan')).find(x => x.codigo === ref.i2);
    assert.ok(t.sindriPedido, 'no queda marcado');
    assert.strictEqual((await odin('ivan', 'POST', '/trabajos/' + t.id + '/estado', { estado: 'NO_COBRAR' })).status, 409);
  });

  await escenario(18, 'Otro envío de la empresa general no le quita a Ivan la marca de su pedido', async () => {
    await enviarTodo();
    await enviarTodo();
    assert.ok((await trabajosDe('ivan')).find(x => x.codigo === ref.i2).sindriPedido);
  });

  await escenario(19, 'Ivan quita su llave: lo nuevo espera, no va ni a la 001 ni a la 002', async () => {
    ok(await odin('ivan', 'PUT', '/sindri/mia', { quitar: true }));
    ok(await apuntar('ivan', inc.i1, 30), 201);
    await enviarTodo();
    ref.i3 = (await ultimo('ivan')).codigo;
    assert.ok(!(await porFacturar('001')).has(ref.i3));
    assert.ok(!(await porFacturar('002')).has(ref.i3));
  });

  await escenario(20, 'Ivan vuelve a poner su llave: lo que esperaba sale a la 002', async () => {
    ok(await odin('ivan', 'PUT', '/sindri/mia', { llave: llaves.k2 }));
    await enviarTodo();
    assert.ok((await porFacturar('002')).has(ref.i3));
    assert.ok(!(await porFacturar('001')).has(ref.i3));
  });

  await escenario(21, 'Ivan apunta un cobro suelto de 120,50 € a Cliente Sur: llega a la 002 con ese importe', async () => {
    ok(await odin('ivan', 'POST', '/trabajos/gasto', { concepto: 'Licencia antivirus', importe: '120,50', clienteId: ids.sur }), 201);
    await enviarTodo();
    ref.g1 = (await ultimo('ivan', t => t.tipo === 'UNICO')).codigo;
    const i = (await porFacturar('002')).get(ref.g1);
    assert.strictEqual(Number(i.amount), 120.5);
  });

  await escenario(22, 'Ivan no puede cobrar a un cliente de Luis que no le ha compartido', async () => {
    assert.strictEqual((await odin('ivan', 'POST', '/trabajos/gasto', { concepto: 'X', importe: '10', clienteId: ids.norte })).status, 404);
  });

  await escenario(23, 'Luis le comparte sus clientes: Ivan cobra un gasto a Norte desde la 002', async () => {
    ok(await odin('luis', 'PUT', '/compartir', { usuario: 'ivan', que: 'clientes', ver: true }));
    ok(await odin('ivan', 'POST', '/trabajos/gasto', { concepto: 'Cableado', importe: '35', clienteId: ids.norte }), 201);
    await enviarTodo();
    ref.g2 = (await ultimo('ivan', t => t.tipo === 'UNICO')).codigo;
    assert.strictEqual((await porFacturar('002')).get(ref.g2).partner_name, 'Cliente Norte');
    assert.ok(!(await porFacturar('001')).has(ref.g2));
  });

  await escenario(24, 'Ivan usa el cliente compartido pero no lo puede cambiar', async () => {
    const r = await odin('ivan', 'POST', '/clientes', { id: ids.norte, nombre: 'Norte cambiado' });
    assert.strictEqual(r.status, 403);
  });

  await escenario(25, 'Pepe, que trabaja para Luis, apunta en una incidencia de Luis: va a la 001 a la tarifa general', async () => {
    ok(await apuntar('pepe', inc.l1, 60), 201);
    await enviarTodo();
    ref.p1 = (await ultimo('pepe')).codigo;
    const i = (await porFacturar('001')).get(ref.p1);
    assert.ok(i);
    assert.strictEqual(Number(i.price), 15);
  });

  await escenario(26, 'Norte tiene tarifa propia de 20: Luis la cobra a 20, Ivan sigue a su 40', async () => {
    const norte = ok(await odin('luis', 'GET', '/clientes')).find(c => c.id === ids.norte);
    ok(await odin('luis', 'POST', '/clientes', { ...norte, tarifa_hora: '20' }));
    ok(await apuntar('luis', inc.l2, 60), 201);
    ok(await apuntar('ivan', inc.l2, 60), 201);
    await enviarTodo();
    const l = (await porFacturar('001')).get((await ultimo('luis', t => !t.deOtro)).codigo);
    const iv = (await porFacturar('002')).get((await ultimo('ivan')).codigo);
    assert.strictEqual(Number(l.price), 20);
    assert.strictEqual(Number(iv.price), 40);
  });

  await escenario(27, 'Luis marca una sesión suya como "no facturar": desaparece de la 001', async () => {
    const t = (await trabajosDe('luis')).find(x => x.codigo === ref.l1);
    ok(await odin('luis', 'POST', '/trabajos/' + t.id + '/estado', { estado: 'NO_COBRAR' }));
    await enviarTodo();
    assert.ok(!(await porFacturar('001')).has(ref.l1));
  });

  await escenario(28, 'Ivan no puede cambiar la conexión general con Sindri ni la configuración', async () => {
    assert.strictEqual((await odin('ivan', 'PUT', '/sindri', { url: 'http://otro', llave: 'x' })).status, 403);
    assert.strictEqual((await odin('ivan', 'PUT', '/config', { TARIFA_HORA: '1' })).status, 403);
  });

  await escenario(29, '"Descargar para Sindri" solo trae lo de cada uno', async () => {
    const deIvan = ok(await odin('ivan', 'GET', '/exportar-sindri')).por_facturar.map(p => p.ref);
    const deLuis = ok(await odin('luis', 'GET', '/exportar-sindri')).por_facturar.map(p => p.ref);
    assert.ok(deIvan.includes(ref.i1) && !deIvan.includes(ref.l2b));
    assert.ok(deLuis.includes(ref.l2b) && !deLuis.includes(ref.i1));
  });

  await escenario(30, 'Luis deja de compartir incidencias: Ivan ya no la ve, pero sus horas siguen en la 002 y en su lista', async () => {
    ok(await odin('luis', 'PUT', '/compartir', { usuario: 'ivan', que: 'incidencias', ver: false }));
    assert.strictEqual((await odin('ivan', 'GET', '/incidencias/' + inc.l2.id)).status, 404);
    await enviarTodo();
    assert.ok((await trabajosDe('ivan')).some(t => t.codigo === ref.i2));
    assert.ok((await porFacturar('002', 'ordered')).has(ref.i2));
  });

  for (const r of resultados) console.log((r.ok ? 'BIEN ' : 'MAL  ') + String(r.n).padStart(2) + '. ' + r.nombre + (r.ok ? '' : '\n        → ' + r.error));
  const mal = resultados.filter(r => !r.ok).length;
  console.log('\n' + (resultados.length - mal) + ' de ' + resultados.length + ' escenarios bien');
  process.exit(mal ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
