// Los datos del gestor en el formato que importa Sindri («sindri-datos», versión 1): el emisor
// como empresa, los clientes con su contacto y la hora de trabajo como producto (servicio) con la
// tarifa general. En Sindri se importa en Empresa → Llevar y traer datos; no borra nada allí.

const IVA_SINDRI = ['0', '4', '10', '21'];

function numero(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function datosParaSindri(cfg, clientes) {
  const irpf = numero(cfg.IRPF);
  const iva = IVA_SINDRI.includes(String(numero(cfg.IVA))) ? String(numero(cfg.IVA)) : '21';
  const tarifa = numero(cfg.TARIFA_HORA);
  const datos = {
    formato: 'sindri-datos',
    version: 1,
    origen: 'Gestor de incidencias',
    clientes: clientes.map(c => {
      const cliente = {
        kind: 'customer',
        name: (c.razon_social || c.nombre).trim(),
        trade_name: c.razon_social && c.razon_social !== c.nombre ? c.nombre : null,
        tax_id: c.nif || null,
        email: c.email || null,
        phone: c.telefono || null,
        address: c.direccion || null,
        notes: [c.notas, c.tarifa_hora != null ? `Tarifa por hora en el gestor: ${c.tarifa_hora} ${cfg.MONEDA || '€'}` : '']
          .filter(Boolean).join('\n') || null,
        archived: !c.activo,
        contactos: c.contacto ? [{ name: c.contacto, email: c.email || null, phone: c.telefono || null }] : []
      };
      if (irpf) cliente.withholding_rate = String(irpf);
      return cliente;
    }),
    productos: tarifa != null ? [{
      sku: 'HORA', name: 'Hora de soporte', kind: 'service', uom: 'h', sale_price: String(tarifa), vat_rate: iva
    }] : [],
    modelos: []
  };
  if (cfg.EMISOR_NOMBRE && cfg.EMISOR_NIF) {
    datos.empresa = { name: cfg.EMISOR_NOMBRE, tax_id: cfg.EMISOR_NIF, address: cfg.EMISOR_DIRECCION || null };
  }
  return datos;
}

module.exports = { datosParaSindri };
