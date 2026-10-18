// El PDF de un documento sale de la página imprimible y Chromium: se comprueba
// que la imagen lo genera (CI lo pasa dentro de ella) sin pedir nada a la red.
//
//   node tests/pdf.js            (con Chromium instalado, o CHROMIUM_RUTA=…)

const assert = require('assert');
const { documentoHtml } = require('../src/documento-html');
const pdf = require('../src/pdf');

const doc = {
  id: 1, tipo: 'FACTURA', codigo: 'F-2026-0001', cliente_nombre: 'Cliente de prueba',
  fecha_emision: '2026-10-12', periodo_desde: '2026-09-01', periodo_hasta: '2026-09-30',
  base: 30, iva_pct: 21, iva_importe: 6.3, irpf_pct: 0, irpf_importe: 0, total: 36.3,
  datos_json: JSON.stringify({
    moneda: '€', emisor: { nombre: 'Emisor', nif: '00000000T' }, cliente: { empresa: 'Cliente de prueba' },
    lineas: [{ fecha: '01/09/2026', servicio: 'Revisión', horasTexto: '2', horas: 2, tarifa: 15, importe: 30 }]
  })
};

(async () => {
  const html = documentoHtml(doc, '', { logo: pdf.logoEnLinea() });
  assert.ok(html.includes('data:image/svg+xml;base64,'), 'el logo va dentro del HTML');

  const fichero = await pdf.deHtml(html);
  assert.strictEqual(fichero.slice(0, 5).toString(), '%PDF-');
  assert.ok(fichero.length > 5000, 'el PDF tiene contenido');

  // Lo que pida a la red se corta: la página no espera por ello.
  const otro = await pdf.deHtml('<p>Hola</p><img src="https://example.com/x.png">');
  assert.strictEqual(otro.slice(0, 5).toString(), '%PDF-');

  console.log('pdf: bien (' + fichero.length + ' bytes)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
