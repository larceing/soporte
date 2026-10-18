// Sindri es la facturación central de la empresa (larceing/sindri): tiene los
// clientes y los productos, y factura. El portal se conecta a una empresa de
// Sindri con su llave de integración y:
//   - liga cada cliente del portal con el suyo en Sindri (o lo trae de allí);
//   - le manda las sesiones y gastos pendientes de cobro, que aparecen en
//     Sindri → Pedidos → Por facturar. Desde ese momento se facturan allí y aquí
//     solo se ve en qué punto están.
// Hacen falta SINDRI_URL y SINDRI_LLAVE (la llave se crea en Sindri → Empresa →
// Integraciones). Sin ellas el portal funciona igual que siempre.
// SINDRI_PRODUCTO es el producto (sku) con el que van las horas, HORA si no se
// dice; SINDRI_PRODUCTO_GASTO, el de los gastos sueltos (si no, el mismo).

const db = require('./db');
const fact = require('./facturacion');
const { ErrorUsuario, texto, esDia } = require('./util');

const URL = () => String(process.env.SINDRI_URL || '').replace(/\/+$/, '');
const LLAVE = () => process.env.SINDRI_LLAVE || '';
const PRODUCTO = () => process.env.SINDRI_PRODUCTO || 'HORA';
const PRODUCTO_GASTO = () => process.env.SINDRI_PRODUCTO_GASTO || PRODUCTO();
const LOTE = 500;

function activo() {
  return Boolean(URL() && LLAVE());
}

async function llamar(metodo, ruta, cuerpo, espera) {
  if (!activo()) throw new ErrorUsuario('Sindri no está configurado (SINDRI_URL y SINDRI_LLAVE).', 501);
  let r;
  try {
    r = await fetch(URL() + '/api/integracion/v1' + ruta, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + LLAVE(), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(espera || 30000)
    });
  } catch (e) {
    console.error('No se ha podido llamar a Sindri: ' + e.message);
    throw new ErrorUsuario('No se ha podido conectar con Sindri.', 502);
  }
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401) throw new ErrorUsuario('Sindri no acepta la llave: revisa SINDRI_LLAVE.', 502);
  if (!r.ok) {
    const e = new ErrorUsuario('Sindri: ' + (datos.error || datos.message || 'error ' + r.status), r.status === 404 || r.status === 409 ? r.status : 502);
    e.sindri = r.status;
    throw e;
  }
  return datos;
}

// Para Ajustes: si hay conexión y con qué empresa.
async function estado() {
  if (!activo()) return { activo: false };
  try {
    const yo = await llamar('GET', '/yo', null, 5000);
    return { activo: true, empresa: yo.empresa, producto: PRODUCTO(), productoGasto: PRODUCTO_GASTO() };
  } catch (e) {
    return { activo: true, error: e.message };
  }
}

async function clientes(q) {
  return llamar('GET', '/clientes' + (q ? '?q=' + encodeURIComponent(texto(q, 100)) : ''));
}

// Liga un cliente del portal con uno de Sindri (o lo desliga con sindriId vacío).
async function vincular(clienteId, sindriId) {
  const cliente = await fact.clientePorId(clienteId);
  const id = texto(sindriId, 64);
  if (id) {
    const lista = await clientes();
    if (!lista.some(c => c.id === id)) throw new ErrorUsuario('Ese cliente no está en Sindri.', 404);
  }
  await db.consulta('UPDATE ha_cliente SET sindri_id = ? WHERE id = ?', [id, cliente.id]);
  return fact.clientes();
}

// Da de alta en el portal un cliente de Sindri, ya ligado. Si ya hay uno con el
// mismo NIF, solo se liga.
async function importar(sindriId) {
  const c = (await clientes()).find(x => x.id === texto(sindriId, 64));
  if (!c) throw new ErrorUsuario('Ese cliente no está en Sindri.', 404);

  const nif = texto(c.tax_id, 32);
  const [mismo] = nif ? await db.consulta('SELECT id FROM ha_cliente WHERE nif = ? AND nif <> \'\'', [nif]) : [];
  if (mismo) {
    await db.consulta('UPDATE ha_cliente SET sindri_id = ? WHERE id = ?', [c.id, mismo.id]);
    return fact.clientes();
  }

  let nombre = texto(c.trade_name || c.name, 120);
  const [repetido] = await db.consulta('SELECT 1 FROM ha_cliente WHERE nombre = ?', [nombre]);
  if (repetido) nombre = texto(nombre, 110) + ' (' + (c.code || c.id.slice(0, 6)) + ')';
  const direccion = [c.address, [c.postal_code, c.city].filter(Boolean).join(' '), c.province].filter(Boolean).join(', ');
  await db.consulta(
    `INSERT INTO ha_cliente (nombre, razon_social, nif, direccion, telefono, email, notas, sindri_id)
     VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
    [nombre, texto(c.name, 200), nif, texto(direccion, 1000), texto(c.phone, 64), texto(c.email, 200), c.id]
  );
  return fact.clientes();
}

// Lo que se manda a Sindri por cada trabajo. La ref es el código del trabajo:
// mandarlo otra vez actualiza lo que haya allí, nunca duplica.
function elementoDe(t, sindriId) {
  const incidencia = t.incidenciaId ? 'Incidencia ' + t.incidenciaId + ': ' : '';
  const base = { ref: t.codigo, cliente: sindriId, fecha: String(t.dia).slice(0, 10), descripcion: texto(incidencia + t.concepto, 1000) };
  if (t.tipo === 'UNICO') return { ...base, producto: PRODUCTO_GASTO(), cantidad: '1', precio: String(t.importe) };
  return { ...base, producto: PRODUCTO(), cantidad: String(t.horas), precio: String(t.tarifa) };
}

// Manda a Sindri lo pendiente de cobro del periodo (de los clientes ligados) que
// no esté ya en una proforma o factura del portal.
async function enviar(datos) {
  if (!esDia(datos.desde) || !esDia(datos.hasta)) throw new ErrorUsuario('Indica fecha desde y fecha hasta.');
  const filas = await db.consulta(
    `SELECT t.id, t.codigo, t.incidencia_id AS incidenciaId, t.concepto, t.dia, t.horas, t.tarifa, t.importe, t.tipo,
            c.sindri_id AS sindriId
       FROM ha_trabajo t JOIN ha_cliente c ON c.id = t.cliente_id
      WHERE t.estado = 'CERRADA' AND t.pago_id IS NULL AND t.sindri_en IS NULL AND t.dia BETWEEN ? AND ?
      ORDER BY t.dia, t.id`,
    [datos.desde, datos.hasta]
  );
  const ocupados = await fact.trabajosOcupados();
  const libres = filas.filter(f => !ocupados.has(Number(f.id)));
  const ligados = libres.filter(f => f.sindriId);
  const resultado = { enviados: 0, errores: [], sinCliente: libres.length - ligados.length, enDocumento: filas.length - libres.length };
  if (!ligados.length) return resultado;

  for (let i = 0; i < ligados.length; i += LOTE) {
    const lote = ligados.slice(i, i + LOTE);
    const r = await llamar('POST', '/por-facturar', { elementos: lote.map(t => elementoDe(t, t.sindriId)) });
    for (const e of r.elementos || []) {
      const t = lote.find(x => x.codigo === e.ref);
      if (!t) continue;
      if (e.estado === 'error') { resultado.errores.push({ codigo: t.codigo, error: e.error || 'Error' }); continue; }
      const estadoSindri = e.estado === 'creado' || e.estado === 'actualizado' ? 'pendiente' : e.estado;
      await db.consulta(
        'UPDATE ha_trabajo SET sindri_en = UTC_TIMESTAMP(), sindri_estado = ?, sindri_pedido = ? WHERE id = ?',
        [estadoSindri, texto(e.pedido, 40), t.id]
      );
      resultado.enviados++;
    }
  }
  return resultado;
}

// Trae de Sindri en qué punto está lo mandado (pendiente, en pedido, descartado).
async function actualizar() {
  if (!activo()) return { actualizados: 0 };
  const filas = await db.consulta('SELECT id, codigo, sindri_estado, sindri_pedido FROM ha_trabajo WHERE sindri_en IS NOT NULL');
  let actualizados = 0;
  for (let i = 0; i < filas.length; i += 50) {
    const lote = filas.slice(i, i + 50);
    const estados = await llamar('GET', '/por-facturar?refs=' + lote.map(f => encodeURIComponent(f.codigo)).join(','));
    for (const e of estados) {
      const f = lote.find(x => x.codigo === e.ref);
      if (!f) continue;
      const pedido = texto(e.pedido, 40);
      if (f.sindri_estado === e.estado && f.sindri_pedido === pedido) continue;
      await db.consulta('UPDATE ha_trabajo SET sindri_estado = ?, sindri_pedido = ? WHERE id = ?', [e.estado, pedido, f.id]);
      actualizados++;
    }
  }
  return { actualizados };
}

// Quita de Sindri un trabajo que allí sigue pendiente: vuelve a cobrarse desde el portal.
async function retirar(trabajoId) {
  const [t] = await db.consulta('SELECT id, codigo, sindri_en FROM ha_trabajo WHERE id = ?', [Number(trabajoId) || 0]);
  if (!t) throw new ErrorUsuario('Trabajo no encontrado.', 404);
  if (!t.sindri_en) throw new ErrorUsuario('Ese trabajo no está en Sindri.', 409);
  try {
    await llamar('DELETE', '/por-facturar/' + encodeURIComponent(t.codigo));
  } catch (e) {
    // Si en Sindri ya no está, se suelta igual.
    if (e.sindri !== 404) throw e;
  }
  await db.consulta("UPDATE ha_trabajo SET sindri_en = NULL, sindri_estado = '', sindri_pedido = '' WHERE id = ?", [t.id]);
}

module.exports = { activo, estado, clientes, vincular, importar, elementoDe, enviar, actualizar, retirar };
