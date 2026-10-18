// Página imprimible de una proforma o factura. Es la plantilla del PDF del
// Gestor de peticiones; el PDF lo genera el navegador con Imprimir > Guardar
// como PDF, en lugar del conversor de Google Drive.

const { TITULOS, datosDe } = require('./facturacion');
const { diaCorto } = require('./util');

const MARCA = {
  nombre: 'HENRY ARCE',
  lema: 'Business Applications & Data',
  oscuro: '#0E1B33',
  acento: '#35D6C0',
  tinta: '#15202B',
  gris: '#5B6877',
  linea: '#DDE3EA',
  fondo: '#F4F6F8'
};

function esc(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function multilinea(texto) {
  return esc(String(texto || '').trim()).replace(/\r?\n/g, '<br>');
}

// Une en líneas solo las partes que tienen contenido.
function lineas(partes) {
  return partes.filter(p => p).map(p => '<div>' + p + '</div>').join('');
}

// Importe en formato español: 1.234,56 €
function dinero(valor, moneda) {
  const partes = Number(valor || 0).toFixed(2).split('.');
  return esc(partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + partes[1] + ' ' + (moneda || '€'));
}

// opciones.logo: la imagen del logo ya incrustada (data:…), para imprimir el
// PDF sin red. Si no, la del portal.
function documentoHtml(doc, prefijo, opciones) {
  const logo = (opciones && opciones.logo) || (prefijo || '') + '/img/monograma.svg';
  const m = MARCA;
  const datos = datosDe(doc);
  const emisor = datos.emisor || {};
  const cliente = datos.cliente || {};
  const pago = datos.pago || {};
  const filasDatos = datos.lineas || [];
  const eur = v => dinero(v, datos.moneda);
  const mostrarImpuestos = doc.tipo === 'FACTURA' || doc.tipo === 'RECTIFICATIVA';

  const etiqueta = 'font-size:8px;font-weight:bold;letter-spacing:1px;color:' + m.gris + ';text-transform:uppercase;padding-bottom:5px;';
  const celdaCabecera = 'background:' + m.oscuro + ';color:#FFFFFF;font-size:8px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:9px 10px;';

  const filas = filasDatos.map((r, i) => {
    const fondo = i % 2 === 1 ? 'background:' + m.fondo + ';' : '';
    const celda = 'padding:9px 10px;border-bottom:1px solid ' + m.linea + ';vertical-align:top;' + fondo;
    const tarifa = Number(r.tarifa || 0) > 0 ? eur(r.tarifa) + '/h' : '&ndash;';
    const horas = r.horasTexto === '-' ? '&ndash;' : esc(r.horasTexto) + ' h';
    const detalle = r.detalle
      ? '<div style="font-size:9px;color:' + m.gris + ';padding-top:3px;line-height:1.35;">' + multilinea(r.detalle) + '</div>'
      : '';
    const referencia = r.codigo
      ? '<div style="font-size:8px;color:' + m.gris + ';padding-top:2px;letter-spacing:0.3px;">Ref. ' + esc(r.codigo) + '</div>'
      : '';

    return '<tr>' +
      '<td style="' + celda + 'white-space:nowrap;color:' + m.gris + ';">' + esc(r.fecha) + '</td>' +
      '<td style="' + celda + '"><div style="font-weight:bold;">' + esc(r.servicio) + '</div>' + detalle + referencia + '</td>' +
      '<td style="' + celda + 'text-align:center;white-space:nowrap;">' + horas + '</td>' +
      '<td style="' + celda + 'text-align:right;white-space:nowrap;color:' + m.gris + ';">' + tarifa + '</td>' +
      '<td style="' + celda + 'text-align:right;white-space:nowrap;font-weight:bold;">' + eur(r.importe) + '</td>' +
      '</tr>';
  }).join('');

  const filaTotal = (nombre, valor) => '<tr>' +
    '<td style="padding:5px 12px;color:' + m.gris + ';">' + nombre + '</td>' +
    '<td style="padding:5px 12px;text-align:right;white-space:nowrap;">' + valor + '</td>' +
    '</tr>';

  const horasTotales = filasDatos.reduce((s, l) => s + Number(l.horas || 0), 0);
  const totales = [
    filaTotal('Horas totales', esc(horasTotales) + ' h'),
    filaTotal('Base imponible', eur(doc.base))
  ];

  // En una factura los tipos impositivos se muestran siempre, aunque sean 0.
  if (Number(doc.iva_pct) > 0 || mostrarImpuestos) {
    totales.push(filaTotal('IVA ' + esc(Number(doc.iva_pct)) + ' %', eur(doc.iva_importe)));
  }
  if (Number(doc.irpf_pct) > 0) {
    totales.push(filaTotal('Retención IRPF ' + esc(Number(doc.irpf_pct)) + ' %', '&minus; ' + eur(doc.irpf_importe)));
  }

  const bloqueEmisor = lineas([
    emisor.nombre ? '<strong>' + esc(emisor.nombre) + '</strong>' : '',
    emisor.nif ? 'NIF: ' + esc(emisor.nif) : '',
    multilinea(emisor.direccion),
    esc(emisor.email),
    esc(emisor.telefono)
  ]);

  const bloqueCliente = lineas([
    '<strong>' + esc(cliente.razonSocial || cliente.empresa || doc.cliente_nombre || 'Cliente') + '</strong>',
    cliente.nif ? 'NIF: ' + esc(cliente.nif) : '',
    multilinea(cliente.direccion),
    cliente.contacto ? 'Att. ' + esc(cliente.contacto) : '',
    esc(cliente.email)
  ]);

  const bloqueDetalles = lineas([
    'Nº: <strong>' + esc(doc.codigo) + '</strong>',
    'Fecha de emisión: ' + esc(diaCorto(doc.fecha_emision)),
    'Periodo: ' + esc(diaCorto(doc.periodo_desde)) + ' &ndash; ' + esc(diaCorto(doc.periodo_hasta)),
    'Servicios: ' + filasDatos.length
  ]);

  const bloquePago = lineas([
    esc(pago.condiciones),
    pago.iban ? 'IBAN: <strong>' + esc(pago.iban) + '</strong>' : '',
    pago.iban && emisor.nombre ? 'Titular: ' + esc(emisor.nombre) : ''
  ]);

  return '<!DOCTYPE html>' +
    '<html lang="es"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>' + esc(doc.codigo + ' ' + doc.cliente_nombre) + '</title>' +
    '<style>' +
      '@page{size:A4;margin:14mm;}' +
      '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
      'body{font-family:Arial,Helvetica,sans-serif;color:' + m.tinta + ';font-size:10.5px;line-height:1.4;margin:0;background:#E9EDF1;}' +
      '.hoja{background:#FFFFFF;max-width:190mm;margin:20px auto;padding:28px;}' +
      '.barra{max-width:190mm;margin:20px auto 0;display:flex;gap:10px;}' +
      '.barra button{font:600 14px Arial,sans-serif;padding:10px 16px;border-radius:10px;border:1px solid #C5CED8;background:#FFFFFF;cursor:pointer;}' +
      '.barra button.principal{background:#1D4F7A;border-color:#1D4F7A;color:#FFFFFF;}' +
      '@media print{body{background:#FFFFFF;}.barra{display:none;}.hoja{margin:0;padding:0;max-width:none;}}' +
    '</style></head>' +
    '<body>' +

    '<div class="barra">' +
      '<button class="principal" onclick="window.print()">Imprimir o guardar como PDF</button>' +
      '<button onclick="window.close()">Cerrar</button>' +
    '</div>' +

    '<div class="hoja">' +

    // Cabecera de marca
    '<table style="width:100%;border-collapse:collapse;"><tr>' +
      '<td style="background:' + m.oscuro + ';padding:20px 0 20px 22px;width:50px;vertical-align:middle;">' +
        '<img src="' + logo + '" width="50" height="50" alt=""></td>' +
      '<td style="background:' + m.oscuro + ';padding:20px 14px;vertical-align:middle;">' +
        '<div style="color:#FFFFFF;font-size:19px;font-weight:bold;letter-spacing:1px;">' + esc(m.nombre) + '</div>' +
        '<div style="color:' + m.acento + ';font-size:9px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;padding-top:3px;">' + esc(m.lema) + '</div>' +
      '</td>' +
      '<td style="background:' + m.oscuro + ';padding:20px 22px 20px 0;vertical-align:middle;text-align:right;">' +
        '<div style="color:#FFFFFF;font-size:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">' + esc(TITULOS[doc.tipo]) + '</div>' +
        '<div style="color:#AEB9CC;font-size:10px;padding-top:3px;">Nº ' + esc(doc.codigo) + '</div>' +
      '</td>' +
    '</tr><tr>' +
      '<td colspan="3" style="background:' + m.acento + ';height:4px;font-size:1px;line-height:1px;">&nbsp;</td>' +
    '</tr></table>' +

    // Emisor, cliente y datos del documento
    '<table style="width:100%;border-collapse:collapse;margin-top:22px;"><tr>' +
      '<td style="width:36%;vertical-align:top;padding-right:14px;"><div style="' + etiqueta + '">De</div>' + bloqueEmisor + '</td>' +
      '<td style="width:36%;vertical-align:top;padding-right:14px;"><div style="' + etiqueta + '">Para</div>' + bloqueCliente + '</td>' +
      '<td style="width:28%;vertical-align:top;"><div style="' + etiqueta + '">Documento</div>' + bloqueDetalles + '</td>' +
    '</tr></table>' +

    // Detalle de servicios
    '<table style="width:100%;border-collapse:collapse;margin-top:24px;">' +
      '<thead><tr>' +
        '<th style="' + celdaCabecera + 'text-align:left;width:62px;">Fecha</th>' +
        '<th style="' + celdaCabecera + 'text-align:left;">Servicio</th>' +
        '<th style="' + celdaCabecera + 'text-align:center;width:44px;">Horas</th>' +
        '<th style="' + celdaCabecera + 'text-align:right;width:64px;">Tarifa</th>' +
        '<th style="' + celdaCabecera + 'text-align:right;width:74px;">Importe</th>' +
      '</tr></thead>' +
      '<tbody>' + filas + '</tbody>' +
    '</table>' +

    // Forma de pago y totales
    '<table style="width:100%;border-collapse:collapse;margin-top:20px;"><tr>' +
      '<td style="vertical-align:top;padding-right:24px;">' +
        (bloquePago ? '<div style="' + etiqueta + '">Forma de pago</div>' + bloquePago : '') +
      '</td>' +
      '<td style="width:250px;vertical-align:top;">' +
        '<table style="width:100%;border-collapse:collapse;">' +
          totales.join('') +
          '<tr>' +
            '<td style="background:' + m.oscuro + ';color:#FFFFFF;font-size:12px;font-weight:bold;padding:11px 12px;">TOTAL</td>' +
            '<td style="background:' + m.oscuro + ';color:#FFFFFF;font-size:14px;font-weight:bold;padding:11px 12px;text-align:right;white-space:nowrap;">' + eur(doc.total) + '</td>' +
          '</tr>' +
        '</table>' +
      '</td>' +
    '</tr></table>' +

    // Menciones del documento (proforma, rectificativa, exenciones)
    (datos.nota
      ? '<table style="width:100%;border-collapse:collapse;margin-top:22px;"><tr>' +
          '<td style="background:' + m.fondo + ';border-left:3px solid ' + m.acento + ';padding:10px 12px;font-size:9.5px;">' +
            multilinea(datos.nota) +
          '</td>' +
        '</tr></table>'
      : '') +

    // Pie
    '<table style="width:100%;border-collapse:collapse;margin-top:34px;"><tr>' +
      '<td style="border-top:1px solid ' + m.linea + ';padding-top:10px;color:' + m.gris + ';font-size:9px;">' +
        esc(datos.pie || 'Servicios prestados durante el periodo indicado.') +
      '</td>' +
      '<td style="border-top:1px solid ' + m.linea + ';padding-top:10px;color:' + m.gris + ';font-size:9px;text-align:right;white-space:nowrap;">' +
        'Henry Arce &middot; ' + esc(m.lema) +
      '</td>' +
    '</tr></table>' +

    '</div></body></html>';
}

module.exports = { documentoHtml };
