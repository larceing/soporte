// Pruebas de lo que el gestor da a Sindri (src/exportar-sindri.js). Sin base de datos:
//   node portal/tests/exportar-sindri.js
const assert = require('assert');
const { datosParaSindri } = require('../src/exportar-sindri');
const { SERVICIOS, servicioDe } = require('../src/servicios');

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
assert.strictEqual(d.clientes[0].tarifas.length, SERVICIOS.length);
assert.ok(d.clientes[0].tarifas.every(t => t.precio === '20'));
assert.strictEqual(d.clientes[1].tax_id, null);
assert.strictEqual(d.clientes[1].archived, true);
assert.deepStrictEqual(d.clientes[1].tarifas, []);

// El catálogo de servicios como artículos: por horas con la tarifa general, y los cargos sin precio.
assert.strictEqual(d.productos.length, SERVICIOS.length + 1);
assert.ok(d.productos.slice(0, -1).every(p => p.uom === 'h' && p.sale_price === '15.5' && p.vat_rate === '0'));
assert.deepStrictEqual(d.productos.at(-1), { sku: 'SOP-CARGO', name: 'Gastos repercutidos y licencias', kind: 'service', uom: 'ud', vat_rate: '0' });
assert.strictEqual(new Set(d.productos.map(p => p.sku)).size, d.productos.length);

// Cada trabajo a su servicio por lo que dice; si nada encaja, por su tipo.
const sku = (titulo, tipo = 'Petición') => servicioDe(titulo, tipo).sku;
assert.strictEqual(sku('Gateway: revisión de versión, credenciales y recargas'), 'SOP-BI-GW');
assert.strictEqual(sku('Informe Cobros: revisión de recarga fallida'), 'SOP-BI-REC');
assert.strictEqual(sku('Informe Susana: cálculo de stock'), 'SOP-BI-INF');
assert.strictEqual(sku('Copia BD A3ERP y plan de migración Power BI'), 'SOP-ERP-MIG');
assert.strictEqual(sku('Lin-AI: conexión a datos reales y demo para Susana'), 'SOP-IA-DES');
assert.strictEqual(sku('Consulta de seguridad: smishing'), 'SOP-SEG');
assert.strictEqual(sku('Algo que no encaja'), 'SOP-DES');
assert.strictEqual(sku('Algo que no encaja', 'Incidencia'), 'SOP-INC');
assert.strictEqual(sku('Algo que no encaja', null), 'HORA');
// Los de la ampliación: infraestructura y demás, sin quitar nada a los de antes.
assert.strictEqual(sku('Renovar el certificado SSL de la web'), 'INF-SSL');
assert.strictEqual(sku('Contenedor Docker que se reinicia'), 'INF-DOCKER');
assert.strictEqual(sku('Crear alias de correo para Iván'), 'COR-BUZON');
assert.strictEqual(sku('Registros SPF y DKIM del dominio'), 'COR-ENTREGA');
assert.strictEqual(sku('Presupuesto para el cliente'), 'ERP-CRM');
assert.strictEqual(sku('Envío de Facturae a FACe'), 'ERP-EFACT');
assert.strictEqual(sku('Grupo nuevo en Keycloak'), 'INF-SSO');
// Todos tienen área conocida, y 150 o así, sin repetir referencia.
const { AREAS } = require('../src/servicios');
assert.ok(SERVICIOS.every(s => AREAS.includes(s.area)));
assert.ok(SERVICIOS.length >= 140);

// Solo lo pendiente de cobrar, con las horas como cantidad y la tarifa del momento.
assert.deepStrictEqual(d.por_facturar.map(p => [p.ref, p.sku, p.cantidad, p.precio]),
  [['SES-1', 'SOP-USR', '2', '20'], ['SES-2', 'SOP-BI-INF', '1.5', '20'], ['SES-3', 'HORA', '1', '20'], ['COB-1', 'SOP-CARGO', '1', '12.3']]);
assert.deepStrictEqual(d.por_facturar[0].cliente, { tax_id: 'B91234567', name: 'Corto Largo SL' });
assert.strictEqual(d.por_facturar[0].descripcion, 'INC_X_1 Impresora · Revisar');
assert.strictEqual(d.por_facturar[0].fecha, '2026-10-01');

// Sin emisor no hay empresa; un IVA que Sindri no conoce pasa al general; sin trabajos, nada por facturar.
const sin = datosParaSindri({ TARIFA_HORA: '15', IVA: '7' }, []);
assert.strictEqual(sin.empresa, undefined);
assert.strictEqual(sin.productos[0].vat_rate, '21');
assert.deepStrictEqual(sin.por_facturar, []);

// El servicio elegido en la incidencia manda sobre el que se deduce del título.
const elegido = datosParaSindri(cfg, clientes, [{ ...trabajos[0], incidencia_servicio: 'SOP-FORM' }]);
assert.strictEqual(elegido.por_facturar[0].sku, 'SOP-FORM');

// Uno del catálogo por tecnología: va a Sindri como artículo (y con la tarifa del cliente) solo si se usa.
const tec = datosParaSindri(cfg, clientes, [{ ...trabajos[0], incidencia_servicio: 'DOCKER-INC' }]);
assert.strictEqual(tec.por_facturar[0].sku, 'DOCKER-INC');
assert.deepStrictEqual(tec.productos.find(p => p.sku === 'DOCKER-INC'), { sku: 'DOCKER-INC', name: 'Docker: resolución de incidencias', kind: 'service', uom: 'h', vat_rate: '0', sale_price: '15.5' });
assert.ok(tec.clientes[0].tarifas.some(t => t.sku === 'DOCKER-INC'));
assert.ok(!d.productos.some(p => p.sku === 'DOCKER-INC'));

// El catálogo entero: unos mil, sin referencias repetidas, todos con área conocida.
const { CATALOGO } = require('../src/servicios');
assert.ok(CATALOGO.length >= 1000, String(CATALOGO.length));
assert.strictEqual(new Set(CATALOGO.map(s => s.sku)).size, CATALOGO.length);
assert.ok(CATALOGO.every(s => AREAS.includes(s.area) && s.sku.length <= 40 && s.name.length <= 120));

console.log('exportar-sindri: bien');
