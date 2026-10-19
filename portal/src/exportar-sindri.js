// Los datos del gestor en el formato que importa Sindri («sindri-datos», versión 1): el emisor
// como empresa, los clientes con su contacto y su tarifa, los servicios (src/servicios.js) como artículos y el
// trabajo pendiente de cobrar como «por facturar» (las horas son la cantidad). En Sindri se
// importa en Empresa → Llevar y traer datos; no borra nada allí.

const IVA_SINDRI = ['0', '4', '10', '21'];

const { SERVICIOS, CARGO, servicioDe } = require('./servicios');

function numero(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const texto = n => String(Math.round(n * 10000) / 10000);

const dia = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// Pendiente de cobrar: cerrado, sin cobro y fuera de cualquier proforma o factura.
const pendiente = t => t.estado === 'CERRADA' && !t.pago_id && !t.ocupado;

function datosParaSindri(cfg, clientes, trabajos = []) {
  const irpf = numero(cfg.IRPF);
  const iva = IVA_SINDRI.includes(String(numero(cfg.IVA))) ? String(numero(cfg.IVA)) : '21';
  const general = numero(cfg.TARIFA_HORA);
  const horas = SERVICIOS;
  const nombreDe = c => (c.razon_social || c.nombre).trim();
  const porId = new Map(clientes.map(c => [Number(c.id), c]));

  const datos = {
    formato: 'sindri-datos',
    version: 1,
    origen: 'Gestor de incidencias',
    origen_app: 'incidencias',
    clientes: clientes.map(c => {
      const propia = numero(c.tarifa_hora);
      const cliente = {
        kind: 'customer',
        name: nombreDe(c),
        trade_name: c.razon_social && c.razon_social !== c.nombre ? c.nombre : null,
        tax_id: c.nif || null,
        email: c.email || null,
        phone: c.telefono || null,
        address: c.direccion || null,
        notes: c.notas || null,
        archived: !c.activo,
        contactos: c.contacto ? [{ name: c.contacto, email: c.email || null, phone: c.telefono || null }] : [],
        // Su tarifa por hora en cada servicio por horas. El descuento se pone en su ficha de Sindri.
        tarifas: propia > 0 ? horas.map(s => ({ sku: s.sku, precio: texto(propia) })) : []
      };
      if (irpf) cliente.withholding_rate = String(irpf);
      return cliente;
    }),
    productos: [
      ...horas.map(s => ({ sku: s.sku, name: s.name, kind: 'service', uom: 'h', vat_rate: iva, ...(general != null ? { sale_price: texto(general) } : {}) })),
      { sku: CARGO.sku, name: CARGO.name, kind: 'service', uom: 'ud', vat_rate: iva }
    ],
    modelos: [],
    por_facturar: trabajos.filter(pendiente).flatMap(t => {
      const c = porId.get(Number(t.cliente_id));
      if (!c) return [];
      const deTiempo = t.tipo === 'TIEMPO';
      const cantidad = deTiempo ? numero(t.horas) : 1;
      if (!(cantidad > 0)) return [];
      const inc = t.incidencia_codigo ? `${t.incidencia_codigo} ${t.incidencia_titulo || ''}`.trim() : '';
      const concepto = t.concepto && t.concepto !== t.incidencia_titulo ? t.concepto : '';
      return [{
        ref: t.codigo,
        cliente: { tax_id: c.nif || null, name: nombreDe(c) },
        sku: deTiempo ? (t.incidencia_servicio || servicioDe(`${t.incidencia_titulo || ''} ${t.concepto || ''}`, t.incidencia_tipo).sku) : CARGO.sku,
        fecha: dia(t.dia),
        cantidad: texto(cantidad),
        precio: texto(numero(deTiempo ? t.tarifa : t.importe) || 0),
        descripcion: [inc, concepto].filter(Boolean).join(' · ').slice(0, 500) || 'Trabajo'
      }];
    })
  };
  if (cfg.EMISOR_NOMBRE && cfg.EMISOR_NIF) {
    datos.empresa = { name: cfg.EMISOR_NOMBRE, tax_id: cfg.EMISOR_NIF, address: cfg.EMISOR_DIRECCION || null };
  }
  return datos;
}

module.exports = { datosParaSindri };
