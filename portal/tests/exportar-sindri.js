// Pruebas de lo que el gestor da a Sindri (src/exportar-sindri.js). Sin base de datos:
//   node portal/tests/exportar-sindri.js
const assert = require('assert');
const { datosParaSindri } = require('../src/exportar-sindri');

const cfg = { TARIFA_HORA: '15,5', IVA: '0', IRPF: '15', MONEDA: '€', EMISOR_NOMBRE: 'Emisor', EMISOR_NIF: '12345678Z', EMISOR_DIRECCION: 'Calle 1' };
const clientes = [
  { nombre: 'Corto', razon_social: 'Corto Largo SL', nif: 'B91234567', direccion: 'Calle 2', tarifa_hora: '20.00', telefono: '600', email: 'a@b.c', contacto: 'Ana', notas: '', activo: 1 },
  { nombre: 'Viejo', razon_social: '', nif: '', direccion: '', tarifa_hora: null, telefono: '', email: '', contacto: '', notas: 'nota', activo: 0 }
];
const d = datosParaSindri(cfg, clientes);

assert.strictEqual(d.formato, 'sindri-datos');
assert.strictEqual(d.version, 1);
assert.deepStrictEqual(d.empresa, { name: 'Emisor', tax_id: '12345678Z', address: 'Calle 1' });
assert.strictEqual(d.clientes.length, 2);
assert.strictEqual(d.clientes[0].name, 'Corto Largo SL');
assert.strictEqual(d.clientes[0].trade_name, 'Corto');
assert.strictEqual(d.clientes[0].withholding_rate, '15');
assert.deepStrictEqual(d.clientes[0].contactos, [{ name: 'Ana', email: 'a@b.c', phone: '600' }]);
assert.ok(d.clientes[0].notes.includes('20.00'));
assert.strictEqual(d.clientes[1].name, 'Viejo');
assert.strictEqual(d.clientes[1].tax_id, null);
assert.strictEqual(d.clientes[1].archived, true);
assert.deepStrictEqual(d.clientes[1].contactos, []);
assert.deepStrictEqual(d.productos, [{ sku: 'HORA', name: 'Hora de soporte', kind: 'service', uom: 'h', sale_price: '15.5', vat_rate: '0' }]);

// Sin emisor no hay empresa; un IVA que Sindri no conoce pasa al general.
const sin = datosParaSindri({ TARIFA_HORA: '15', IVA: '7' }, []);
assert.strictEqual(sin.empresa, undefined);
assert.strictEqual(sin.productos[0].vat_rate, '21');

console.log('exportar-sindri: bien');
