// Pruebas de lo que el gestor da a Sindri (src/exportar-sindri.js). Sin base de datos:
//   node portal/tests/exportar-sindri.js
const assert = require('assert');
const { datosParaSindri } = require('../src/exportar-sindri');

const cfg = { TARIFA_HORA: '15,5', IVA: '0', IRPF: '15', MONEDA: '€', EMISOR_NOMBRE: 'Emisor', EMISOR_NIF: '12345678Z', EMISOR_DIRECCION: 'Calle 1' };
const clientes = [
  { id: 1, nombre: 'Corto', razon_social: 'Corto Largo SL', nif: 'B91234567', direccion: 'Calle 2', tarifa_hora: '20.00', telefono: '600', email: 'a@b.c', contacto: 'Ana', notas: '', activo: 1 },
  { id: 2, nombre: 'Viejo', razon_social: '', nif: '', direccion: '', tarifa_hora: null, telefono: '', email: '', contacto: '', notas: 'nota', activo: 0 }
];
const base = { estado: 'CERRADA', pago_id: null, ocupado: false, cliente_id: 1, dia: '2026-10-01' };
const trabajos = [
  { ...base, codigo: 'SES-1', tipo: 'TIEMPO', horas: 2, tarifa: 20, importe: 40, concepto: 'Revisar', incidencia_tipo: 'Incidencia', incidencia_codigo: 'INC_X_1', incidencia_titulo: 'Impresora' },
  { ...base, codigo: 'SES-2', tipo: 'TIEMPO', horas: 1.5, tarifa: 20, importe: 30, concepto: 'Nuevo informe', incidencia_tipo: 'Petición', incidencia_codigo: 'PET_X_2', incidencia_titulo: 'Informe' },
  { ...base, codigo: 'SES-3', tipo: 'TIEMPO', horas: 1, tarifa: 20, importe: 20, concepto: 'Llamada' },
  { ...base, codigo: 'COB-1', tipo: 'UNICO', horas: 0, tarifa: 0, importe: 12.3, concepto: 'Cable' },
  { ...base, codigo: 'SES-4', tipo: 'TIEMPO', horas: 1, tarifa: 20, importe: 20, concepto: 'En proforma', ocupado: true },
  { ...base, codigo: 'SES-5', tipo: 'TIEMPO', horas: 1, tarifa: 20, importe: 20, concepto: 'Cobrado', pago_id: 9 },
  { ...base, codigo: 'SES-6', tipo: 'TIEMPO', horas: 1, tarifa: 20, importe: 20, concepto: 'No se cobra', estado: 'NO_COBRAR' }
];
const d = datosParaSindri(cfg, clientes, trabajos);

assert.strictEqual(d.formato, 'sindri-datos');
assert.strictEqual(d.version, 1);
assert.strictEqual(d.origen_app, 'incidencias');
assert.deepStrictEqual(d.empresa, { name: 'Emisor', tax_id: '12345678Z', address: 'Calle 1' });
assert.strictEqual(d.clientes.length, 2);
assert.strictEqual(d.clientes[0].name, 'Corto Largo SL');
assert.strictEqual(d.clientes[0].trade_name, 'Corto');
assert.strictEqual(d.clientes[0].withholding_rate, '15');
assert.deepStrictEqual(d.clientes[0].contactos, [{ name: 'Ana', email: 'a@b.c', phone: '600' }]);
assert.deepStrictEqual(d.clientes[0].tarifas, [{ sku: 'SOP-INC', precio: '20' }, { sku: 'SOP-PET', precio: '20' }, { sku: 'HORA', precio: '20' }]);
assert.strictEqual(d.clientes[1].tax_id, null);
assert.strictEqual(d.clientes[1].archived, true);
assert.deepStrictEqual(d.clientes[1].tarifas, []);

// Los servicios como artículos: por horas con la tarifa general y otros cargos sin precio.
assert.deepStrictEqual(d.productos.map(p => [p.sku, p.uom, p.sale_price, p.vat_rate]),
  [['SOP-INC', 'h', '15.5', '0'], ['SOP-PET', 'h', '15.5', '0'], ['HORA', 'h', '15.5', '0'], ['SOP-CARGO', 'ud', undefined, '0']]);

// Solo lo pendiente de cobrar, con las horas como cantidad y la tarifa del momento.
assert.deepStrictEqual(d.por_facturar.map(p => [p.ref, p.sku, p.cantidad, p.precio]),
  [['SES-1', 'SOP-INC', '2', '20'], ['SES-2', 'SOP-PET', '1.5', '20'], ['SES-3', 'HORA', '1', '20'], ['COB-1', 'SOP-CARGO', '1', '12.3']]);
assert.deepStrictEqual(d.por_facturar[0].cliente, { tax_id: 'B91234567', name: 'Corto Largo SL' });
assert.strictEqual(d.por_facturar[0].descripcion, 'INC_X_1 Impresora · Revisar');
assert.strictEqual(d.por_facturar[0].fecha, '2026-10-01');

// Sin emisor no hay empresa; un IVA que Sindri no conoce pasa al general; sin trabajos, nada por facturar.
const sin = datosParaSindri({ TARIFA_HORA: '15', IVA: '7' }, []);
assert.strictEqual(sin.empresa, undefined);
assert.strictEqual(sin.productos[0].vat_rate, '21');
assert.deepStrictEqual(sin.por_facturar, []);

console.log('exportar-sindri: bien');
