// Envío automático a Sindri: lo pendiente de cobrar del gestor aparece solo en Sindri → Pedidos →
// Por facturar, con su servicio y su tarifa. Usa la API de integración de Sindri con una llave de
// la empresa (en Sindri, Ajustes → Integraciones). La llave se llama «incidencias», como el origen
// del fichero «Descargar para Sindri», para que lo importado y lo enviado sean lo mismo.
//
// Cada envío manda todo lo pendiente (Sindri actualiza lo que sigue pendiente allí y no toca lo que
// ya está en un pedido) y retira de Sindri lo que aquí ya no está pendiente. Se envía unos
// segundos después de cada cambio en el portal y, por si acaso, cada 10 minutos.
//
// Dónde está Sindri y su llave: SINDRI_URL y SINDRI_LLAVE en el entorno o, si no están, en
// Ajustes → Sindri (la llave se guarda en ha_config y nunca vuelve al navegador).
//
// Varias personas, cada una con su empresa: quien pone su propia llave (ha_sindri_persona) manda
// sus horas a su empresa de Sindri; lo de los demás va a la empresa de la llave general. Un
// trabajo que ya está en un pedido se queda con la empresa que lo tiene (ha_trabajo.sindri_empresa).

const { consulta } = require('./db');
const fact = require('./facturacion');
const { datosParaSindri } = require('./exportar-sindri');
const { AREAS, CATALOGO } = require('./servicios');

const ESPERA = 5000;
const CADA = 10 * 60 * 1000;
const NOMBRE_LLAVE = 'incidencias';

let ultima = null;
let enCurso = null;
let pendienteOtra = false;
let temporizador = null;

let ultimaPersona = {};
const sinBarra = s => String(s || '').trim().replace(/\/+$/, '');

async function conexion() {
  if (process.env.SINDRI_URL && process.env.SINDRI_LLAVE) {
    return { url: sinBarra(process.env.SINDRI_URL), llave: process.env.SINDRI_LLAVE.trim(), desde: 'entorno' };
  }
  const filas = await consulta("SELECT clave, valor FROM ha_config WHERE clave IN ('SINDRI_URL', 'SINDRI_LLAVE')");
  const v = Object.fromEntries(filas.map(f => [f.clave, f.valor]));
  if (v.SINDRI_URL && v.SINDRI_LLAVE) return { url: sinBarra(v.SINDRI_URL), llave: v.SINDRI_LLAVE, desde: 'ajustes' };
  return { url: sinBarra(v.SINDRI_URL || process.env.SINDRI_URL), llave: '', desde: null };
}

async function guardarConexion({ url, llave, quitar }) {
  const poner = (clave, valor) => consulta(
    'INSERT INTO ha_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, valor]
  );
  if (quitar) {
    await consulta("DELETE FROM ha_config WHERE clave = 'SINDRI_LLAVE'");
    ultima = null;
    return estado();
  }
  if (url !== undefined) {
    const u = sinBarra(url);
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) {
      const e = new Error('La dirección de Sindri debe empezar por http:// o https://');
      e.status = 400;
      throw e;
    }
    // Una llave guardada no viaja a otra dirección: si cambia la URL y no llega llave nueva,
    // se borra la de antes y hay que escribirla otra vez.
    const antes = (await consulta("SELECT clave, valor FROM ha_config WHERE clave IN ('SINDRI_URL')")).find(f => f.clave === 'SINDRI_URL');
    const nueva = u.slice(0, 500);
    if (antes && antes.valor && sinBarra(antes.valor) !== nueva && !(llave && String(llave).trim())) {
      await consulta("DELETE FROM ha_config WHERE clave = 'SINDRI_LLAVE'");
    }
    await poner('SINDRI_URL', nueva);
  }
  if (llave && String(llave).trim()) await poner('SINDRI_LLAVE', String(llave).trim().slice(0, 200));
  ultima = null;
  programar();
  return estado();
}

async function llamar(c, metodo, ruta, cuerpo) {
  const r = await fetch(c.url + '/api/integracion/v1' + ruta, {
    method: metodo,
    headers: { Authorization: 'Bearer ' + c.llave, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(r.status === 401 ? 'Sindri no acepta la llave (no es válida o está revocada).' : (datos.error || 'Sindri ha respondido ' + r.status + '.'));
    e.status = r.status;
    throw e;
  }
  return datos;
}

// Lo que en el gestor está pendiente de cobrar, igual que en «Descargar para Sindri».
async function trabajosPendientes() {
  const ocupados = await fact.trabajosOcupados();
  return (await consulta(
    `SELECT t.id, t.codigo, t.autor, t.sindri_pedido, t.sindri_empresa, t.cliente_id, t.concepto, t.dia, t.horas, t.tarifa, t.importe, t.tipo, t.estado, t.pago_id,
            i.tipo AS incidencia_tipo, i.codigo AS incidencia_codigo, i.titulo AS incidencia_titulo, i.servicio_sku AS incidencia_servicio
       FROM ha_trabajo t LEFT JOIN ha_incidencia i ON i.id = t.incidencia_id
      WHERE t.estado = 'CERRADA' AND t.pago_id IS NULL
      ORDER BY t.dia, t.id`
  )).map(t => ({ ...t, ocupado: ocupados.has(Number(t.id)) }));
}

const clave = s => String(s || '').trim().toLowerCase();
const nif = s => String(s || '').replace(/[\s.-]/g, '').toUpperCase();

// El cliente de Sindri de cada elemento: por NIF y, si no, por nombre o nombre comercial.
function elementosParaSindri(porFacturar, clientesSindri) {
  const porNif = new Map(clientesSindri.filter(c => c.tax_id).map(c => [nif(c.tax_id), c.id]));
  const porNombre = new Map();
  clientesSindri.forEach(c => [c.name, c.trade_name].filter(Boolean).forEach(n => porNombre.set(clave(n), c.id)));
  const elementos = [];
  const sinCliente = [];
  for (const p of porFacturar) {
    const id = (p.cliente.tax_id && porNif.get(nif(p.cliente.tax_id))) || porNombre.get(clave(p.cliente.name));
    if (!id) { sinCliente.push({ ref: p.ref, error: 'No hay cliente ' + p.cliente.name + ' en Sindri' }); continue; }
    elementos.push({ ref: p.ref, cliente: id, producto: p.sku, fecha: p.fecha, cantidad: p.cantidad, precio: p.precio, descripcion: p.descripcion });
  }
  return { elementos, sinCliente };
}

// Cada trabajo sabe si ya está en un pedido de Sindri (en cuál, y de qué empresa): así no se cobra
// también aquí ni en otra empresa. Cada empresa solo toca sus marcas ('' = la de la llave general).
// Sindri da como mucho 2000 referencias; si llega al tope no se borra ninguna marca.
async function anotarPedidos(enSindri, grupo = '') {
  const enPedido = enSindri.filter(e => e.estado === 'en_pedido' && e.pedido);
  for (const e of enPedido) {
    const pedido = String(e.pedido).slice(0, 40);
    await consulta(
      'UPDATE ha_trabajo SET sindri_pedido = ?, sindri_empresa = ? WHERE codigo = ? AND NOT (sindri_pedido <=> ? AND sindri_empresa <=> ?)',
      [pedido, grupo, e.ref, pedido, grupo]
    );
  }
  if (enSindri.length >= 2000) return;
  const refs = enPedido.map(e => e.ref);
  await consulta(
    "UPDATE ha_trabajo SET sindri_pedido = NULL WHERE sindri_pedido IS NOT NULL AND COALESCE(sindri_empresa, '') = ?" + (refs.length ? ' AND codigo NOT IN (?)' : ''),
    refs.length ? [grupo, refs] : [grupo]
  );
}

// A qué empresa va cada trabajo: la que ya lo tiene en un pedido; si no, la de su autor si tiene
// llave propia ('' = la llave general). Quien quitó su llave (llave vacía) no manda nada: sus
// horas esperan a que ponga otra y no acaban en la empresa de otro (fact.grupoDe).
const grupoDe = (t, personas) => fact.grupoDe(t, personas);

async function personasConLlave() {
  const filas = await consulta('SELECT usuario, llave FROM ha_sindri_persona');
  return new Map(filas.map(f => [f.usuario, f.llave || '']));
}

let servCache = null;

// Los servicios que se pueden elegir en una incidencia.
async function servicios() {
  const c = await conexion();
  if (c.url && c.llave) {
    if (servCache && servCache.hasta > Date.now() && servCache.url === c.url) return servCache.datos;
    try {
      const productos = await llamar(c, 'GET', '/productos');
      const enSindri = productos.filter(p => p.kind === 'service' && p.uom === 'h').map(p => ({ sku: p.sku, name: p.name }));
      const datos = { desde: 'sindri', servicios: conCatalogo(enSindri) };
      servCache = { url: c.url, hasta: Date.now() + 5 * 60 * 1000, datos };
      return datos;
    } catch (e) {
      // Sin Sindri a mano, el catálogo propio.
    }
  }
  return { desde: 'gestor', servicios: conCatalogo([]) };
}

// Lo de Sindri (con su nombre de allí) más el catálogo propio que aún no está allí: un servicio
// nuevo del catálogo se puede elegir antes de usarlo, y se da de alta en Sindri al enviar el
// trabajo. Cada uno con su área para agruparlos; lo que solo está en Sindri va a «Otros».
function conCatalogo(enSindri) {
  const deSindri = new Map(enSindri.map(s => [s.sku, s]));
  const lista = CATALOGO.map(s => ({ sku: s.sku, name: (deSindri.get(s.sku) || s).name, area: s.area, ...(s.alias ? { alias: s.alias } : {}) }));
  const propios = new Set(lista.map(s => s.sku));
  return [...lista, ...enSindri.filter(s => !propios.has(s.sku)).map(s => ({ ...s, area: 'Otros' }))]
    .sort((a, b) => orden(a.area) - orden(b.area));
}
const orden = area => (AREAS.includes(area) ? AREAS.indexOf(area) : AREAS.length);

// Lo que falta en Sindri se da de alta allí con los datos de aquí: el cliente (por NIF o nombre)
// y el servicio (por sku). Sindri no toca lo que ya tiene. Un Sindri sin altas (404) se deja estar.
async function altaPermitida(c, ruta, cuerpo, altas, que) {
  try {
    const r = await llamar(c, 'POST', ruta, cuerpo);
    return r && r.creado ? 1 : 0;
  } catch (e) {
    if (e.status !== 404) altas.errores.push({ ref: que, error: 'No se ha podido dar de alta en Sindri: ' + e.message });
    return e.status === 404 ? -1 : 0;
  }
}

async function altaServicios(c, datos, altas) {
  const hace = [...new Set(datos.por_facturar.map(p => p.sku))];
  if (!hace.length) return;
  const hay = new Set((await llamar(c, 'GET', '/productos')).map(p => p.sku));
  for (const sku of hace.filter(s => !hay.has(s))) {
    const p = datos.productos.find(x => x.sku === sku) || { sku, name: sku, uom: 'h' };
    const r = await altaPermitida(c, '/productos', { sku: p.sku, name: p.name, uom: p.uom, sale_price: p.sale_price, vat_rate: p.vat_rate }, altas, sku);
    if (r < 0) return;
    if (r) { altas.servicios++; servCache = null; }
  }
}

async function altaClientes(c, datos, clientesSindri, altas) {
  const { sinCliente } = elementosParaSindri(datos.por_facturar, clientesSindri);
  if (!sinCliente.length) return false;
  const faltan = new Set(datos.por_facturar.filter(p => sinCliente.some(s => s.ref === p.ref)).map(p => clave(p.cliente.name)));
  let hechos = 0;
  for (const cli of datos.clientes.filter(x => faltan.has(clave(x.name)))) {
    const cuerpo = Object.fromEntries(['name', 'trade_name', 'tax_id', 'email', 'phone', 'address', 'notes'].filter(k => cli[k]).map(k => [k, cli[k]]));
    const r = await altaPermitida(c, '/clientes', cuerpo, altas, cli.name);
    if (r < 0) return hechos > 0;
    if (r) { altas.clientes++; hechos++; }
  }
  return true;
}

// Lo de una empresa: los trabajos que le tocan, con su llave.
async function enviarGrupo(c, grupo) {
  const yo = await llamar(c, 'GET', '/yo');
  const personas = await personasConLlave();
  const [cfg, clientes, todos] = await Promise.all([fact.config(), consulta('SELECT * FROM ha_cliente ORDER BY nombre'), trabajosPendientes()]);
  const trabajos = todos.filter(t => grupoDe(t, personas) === grupo);
  const datos = datosParaSindri(cfg, clientes, trabajos);
  const { por_facturar } = datos;
  const altas = { clientes: 0, servicios: 0, errores: [] };
  await altaServicios(c, datos, altas);
  let clientesSindri = await llamar(c, 'GET', '/clientes');
  if (await altaClientes(c, datos, clientesSindri, altas)) clientesSindri = await llamar(c, 'GET', '/clientes');
  const { elementos, sinCliente } = elementosParaSindri(por_facturar, clientesSindri);

  const cuenta = { creado: 0, actualizado: 0, en_pedido: 0, descartado: 0, retirados: 0 };
  const errores = [...altas.errores, ...sinCliente];
  for (let i = 0; i < elementos.length; i += 500) {
    const r = await llamar(c, 'POST', '/por-facturar', { elementos: elementos.slice(i, i + 500) });
    for (const e of r.elementos || []) {
      if (e.estado === 'error') errores.push({ ref: e.ref, error: e.error });
      else cuenta[e.estado] = (cuenta[e.estado] || 0) + 1;
    }
  }

  // Lo que Sindri tiene pendiente de este origen y aquí ya no lo está (reabierto, no cobrar,
  // cobrado aquí, de otra persona...) se retira. Lo que ya está en un pedido de Sindri no se toca.
  const aqui = new Set(por_facturar.map(p => p.ref));
  const enSindri = await llamar(c, 'GET', '/por-facturar');
  await anotarPedidos(enSindri, grupo);
  for (const e of enSindri) {
    if (e.estado !== 'pendiente' || aqui.has(e.ref)) continue;
    try {
      await llamar(c, 'DELETE', '/por-facturar/' + encodeURIComponent(e.ref));
      cuenta.retirados++;
    } catch (err) {
      errores.push({ ref: e.ref, error: err.message });
    }
  }
  return {
    ok: true, empresa: yo.empresa && (yo.empresa.trade_name || yo.empresa.name),
    llave: yo.app, aviso: yo.app !== NOMBRE_LLAVE ? 'La llave de Sindri se llama «' + yo.app + '»: llámala «' + NOMBRE_LLAVE + '» para que lo enviado y lo importado con el fichero sean lo mismo.' : '',
    pendientes: por_facturar.length, ...cuenta, altas: { clientes: altas.clientes, servicios: altas.servicios }, errores: errores.slice(0, 50)
  };
}

const fallo = (e, c) => {
  if (!e.status) console.error('Sindri: ' + (e.cause ? e.cause.message : e.message));
  return { ok: false, error: e.name === 'TimeoutError' ? 'Sindri no responde.' : (e.cause ? 'No se puede conectar con Sindri en ' + c.url + '.' : e.message) };
};

async function enviar() {
  const c = await conexion();
  if (!c.url) return null;
  const inicio = new Date().toISOString();
  // Primero la empresa general: si algo acaba de entrar en un pedido suyo, queda suyo.
  if (c.llave) {
    try {
      ultima = { cuando: inicio, ...(await enviarGrupo(c, '')) };
    } catch (e) {
      ultima = { cuando: inicio, ...fallo(e, c) };
    }
  }
  const personas = await personasConLlave();
  const nuevas = {};
  for (const [usuario, llave] of personas) {
    if (!llave) continue;
    const cp = { url: c.url, llave };
    try {
      nuevas[usuario] = { cuando: inicio, ...(await enviarGrupo(cp, usuario)) };
    } catch (e) {
      nuevas[usuario] = { cuando: inicio, ...fallo(e, cp) };
    }
  }
  ultimaPersona = nuevas;
  return c.llave ? ultima : (Object.keys(nuevas).length ? { ok: true, cuando: inicio, personas: Object.keys(nuevas).length } : null);
}

// La llave propia de una persona: sus horas van a su empresa de Sindri. Se prueba antes de
// guardarla y no puede ser de la misma empresa que la llave general (eso no separa nada).
async function guardarMia(usuario, { llave, quitar }) {
  if (!usuario) { const e = new Error('No se sabe quién eres.'); e.status = 401; throw e; }
  if (quitar) {
    // Se queda la fila sin llave: sus horas esperan, no pasan a la empresa general.
    await consulta(
      'INSERT INTO ha_sindri_persona (usuario, llave, actualizada) VALUES (?, \'\', UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE llave = \'\', actualizada = UTC_TIMESTAMP()',
      [usuario]
    );
    delete ultimaPersona[usuario];
    return estado(usuario);
  }
  const l = String(llave || '').trim().slice(0, 200);
  const c = await conexion();
  const error = (m, s = 422) => { const e = new Error(m); e.status = s; return e; };
  if (!l) throw error('Escribe tu llave de Sindri.', 400);
  if (!c.url) throw error('Falta la dirección de Sindri en Ajustes → Sindri.', 409);
  let tuya;
  try {
    tuya = await llamar({ url: c.url, llave: l }, 'GET', '/yo');
  } catch (e) {
    throw error(e.status === 401 ? 'Sindri no acepta esa llave.' : fallo(e, c).error);
  }
  if (c.llave) {
    const general = await llamar(c, 'GET', '/yo').catch(() => null);
    const id = y => y && y.empresa && (y.empresa.id || y.empresa.code);
    if (general && id(general) && id(general) === id(tuya)) {
      throw error('Esa llave es de la misma empresa que la llave general: créala en tu empresa de Sindri.');
    }
  }
  await consulta(
    'INSERT INTO ha_sindri_persona (usuario, llave, actualizada) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE llave = VALUES(llave), actualizada = UTC_TIMESTAMP()',
    [usuario, l]
  );
  delete ultimaPersona[usuario];
  programar();
  return estado(usuario);
}

// Un envío cada vez; si llega un cambio mientras tanto, se repite al terminar.
async function sincronizar() {
  if (enCurso) { pendienteOtra = true; return enCurso; }
  enCurso = enviar().finally(() => {
    enCurso = null;
    if (pendienteOtra) { pendienteOtra = false; programar(); }
  });
  return enCurso;
}

function programar() {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => sincronizar().catch(() => {}), ESPERA);
  temporizador.unref?.();
}

function arrancar() {
  programar();
  setInterval(() => sincronizar().catch(() => {}), CADA).unref?.();
}

async function estado(usuario) {
  const c = await conexion();
  const personas = await personasConLlave();
  const mia = usuario && personas.has(usuario)
    ? { configurada: Boolean(personas.get(usuario)), enEspera: !personas.get(usuario), ultima: ultimaPersona[usuario] || null }
    : { configurada: false, enEspera: false, ultima: null };
  // Quien tiene su propia empresa no ve cómo le va a la general ni puede cambiar su conexión.
  const independiente = Boolean(usuario && personas.has(usuario));
  return {
    configurado: Boolean(c.url && c.llave), url: c.url || '', desde: c.desde, llaveNombre: NOMBRE_LLAVE, ultima: independiente ? null : ultima,
    independiente, mia, personas: [...personas].filter(([, l]) => l).map(([u]) => u)
  };
}

module.exports = { servicios, arrancar, programar, sincronizar, estado, guardarConexion, guardarMia, trabajosPendientes, elementosParaSindri };
