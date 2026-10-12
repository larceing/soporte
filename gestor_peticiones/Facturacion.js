const FACTURACION_MARCA = {
  nombre: 'HENRY ARCE',
  lema: 'Business Applications & Data',
  oscuro: '#0E1B33',
  acento: '#35D6C0',
  tinta: '#15202B',
  gris: '#5B6877',
  linea: '#DDE3EA',
  fondo: '#F4F6F8'
};

function facturacionObtenerResumen(filtros) {
  filtros = filtros || {};

  if (!filtros.desde || !filtros.hasta) {
    throw new Error('Debes indicar fecha desde y fecha hasta.');
  }

  const desde = new Date(filtros.desde + 'T00:00:00');
  const hasta = new Date(filtros.hasta + 'T23:59:59');

  if (isNaN(desde.getTime()) || isNaN(hasta.getTime())) {
    throw new Error('Fechas inválidas.');
  }

  if (hasta < desde) {
    throw new Error('La fecha hasta no puede ser anterior a la fecha desde.');
  }

  const empresaFiltro = String(filtros.empresa || '').trim().toLowerCase();
  const incluirDetalle = filtros.detalle === true || filtros.detalle === 'true';

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) throw new Error('No existe la hoja Peticiones.');

  const values = sh.getDataRange().getValues();
  const config = facturacionConfig_();

  const moneda = String(config.MONEDA || '€');
  const ivaPorcentaje = Number(config.IVA || 0);
  const irpfPorcentaje = Number(config.IRPF || 0);

  let subtotal = 0;
  let horasTotales = 0;
  const lineas = [];

  for (let i = 1; i < values.length; i++) {
    const id = values[i][0];
    const empresa = String(values[i][1] || '');
    const peticion = String(values[i][2] || '');
    const inicio = values[i][3];
    const horas = Number(values[i][6] || 0);
    const tarifa = Number(values[i][7] || 0);
    const importe = Number(values[i][8] || 0);
    const estado = String(values[i][9] || '').trim();
    const observaciones = String(values[i][10] || '').trim();
    const tipo = String(values[i][11] || '').trim();

    if (!id) continue;
    if (estado !== 'CERRADA') continue;
    if (!(inicio instanceof Date)) continue;
    if (inicio < desde || inicio > hasta) continue;

    if (empresaFiltro && !empresa.toLowerCase().includes(empresaFiltro)) {
      continue;
    }

    subtotal += importe;
    horasTotales += horas;

    lineas.push({
      fecha: Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
      servicio: peticion || empresa || 'Servicio',
      detalle: incluirDetalle ? observaciones : '',
      horas: horas,
      horasTexto: tipo === 'UNICO' ? '-' : horas,
      tarifa: tipo === 'UNICO' ? 0 : tarifa,
      importe: facturacionNumero_(importe)
    });
  }

  lineas.sort(function(a, b) {
    const pa = a.fecha.split('/').reverse().join('');
    const pb = b.fecha.split('/').reverse().join('');
    return pa.localeCompare(pb);
  });

  const ivaImporte = subtotal * ivaPorcentaje / 100;
  const irpfImporte = subtotal * irpfPorcentaje / 100;
  const total = subtotal + ivaImporte - irpfImporte;
  const cliente = facturacionObtenerCliente_(filtros.empresa);

  return {
    empresa: filtros.empresa || '',
    cliente: cliente,
    desde: filtros.desde,
    hasta: filtros.hasta,
    numero: String(filtros.numero || '').trim(),
    titulo: String(config.DOC_TITULO || '').trim() || 'Resumen de servicios',
    lineas: lineas,
    horasTotales: horasTotales,
    subtotal: facturacionNumero_(subtotal),
    ivaPorcentaje: ivaPorcentaje,
    ivaImporte: facturacionNumero_(ivaImporte),
    irpfPorcentaje: irpfPorcentaje,
    irpfImporte: facturacionNumero_(irpfImporte),
    total: facturacionNumero_(total),
    moneda: moneda,
    emisor: {
      nombre: String(config.EMISOR_NOMBRE || '').trim(),
      nif: String(config.EMISOR_NIF || '').trim(),
      direccion: String(config.EMISOR_DIRECCION || '').trim(),
      email: String(config.EMISOR_EMAIL || '').trim(),
      telefono: String(config.EMISOR_TELEFONO || '').trim()
    },
    pago: {
      iban: String(config.EMISOR_IBAN || '').trim(),
      condiciones: String(config.PAGO_CONDICIONES || '').trim()
    },
    pie: String(config.DOC_PIE || '').trim()
  };
}

// Lee MacroData una sola vez y lo devuelve como mapa clave -> valor.
function facturacionConfig_() {
  const sh = ss_().getSheetByName(SHEETS.macro);
  if (!sh) throw new Error('No existe la hoja MacroData.');

  const values = sh.getDataRange().getValues();
  const config = {};

  for (let i = 1; i < values.length; i++) {
    const clave = String(values[i][0] || '').trim();
    if (clave) config[clave] = values[i][1];
  }

  return config;
}

function facturacionGenerarPdfDrive(filtros) {
  const resumen = facturacionObtenerResumen(filtros);

  if (!resumen.lineas.length) {
    throw new Error('No hay registros para generar PDF.');
  }

  const carpetaId = String(configGet_('CARPETA_PDF_FACTURAS') || '').trim();

  if (!carpetaId) {
    throw new Error('Falta CARPETA_PDF_FACTURAS en MacroData.');
  }

  const html = facturacionHtmlPdf_(resumen);
  const nombre = facturacionNombreArchivo_(resumen);

  const blob = Utilities
    .newBlob(html, 'text/html', nombre + '.html')
    .getAs(MimeType.PDF)
    .setName(nombre + '.pdf');

  const folder = DriveApp.getFolderById(carpetaId);
  const file = folder.createFile(blob);

  file.setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW
  );

  return {
    resumen: resumen,
    url: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    id: file.getId(),
    nombre: file.getName()
  };
}

// El conversor de HTML a PDF de Apps Script solo entiende CSS básico: la
// maquetación va con tablas y estilos en línea, sin flexbox ni fuentes web.
function facturacionHtmlPdf_(data) {
  const m = FACTURACION_MARCA;
  const esc = facturacionEsc_;
  const dinero = function(valor) {
    return esc(facturacionDinero_(valor, data.moneda));
  };

  const emisor = data.emisor || {};
  const cliente = data.cliente || {};
  const pago = data.pago || {};
  const hoy = data.fechaEmision ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy');

  const etiqueta = 'font-size:8px;font-weight:bold;letter-spacing:1px;color:' + m.gris + ';text-transform:uppercase;padding-bottom:5px;';
  const celdaCabecera = 'background:' + m.oscuro + ';color:#FFFFFF;font-size:8px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:9px 10px;';

  const filas = data.lineas.map(function(r, i) {
    const fondo = i % 2 === 1 ? 'background:' + m.fondo + ';' : '';
    const celda = 'padding:9px 10px;border-bottom:1px solid ' + m.linea + ';vertical-align:top;' + fondo;
    const detalle = r.detalle
      ? '<div style="font-size:9px;color:' + m.gris + ';padding-top:3px;line-height:1.35;">' + facturacionMultilinea_(r.detalle) + '</div>'
      : '';
    const tarifa = Number(r.tarifa || 0) > 0 ? dinero(r.tarifa) + '/h' : '&ndash;';
    const horas = r.horasTexto === '-' ? '&ndash;' : esc(r.horasTexto) + ' h';

    return '<tr>' +
      '<td style="' + celda + 'white-space:nowrap;color:' + m.gris + ';">' + esc(r.fecha) + '</td>' +
      '<td style="' + celda + '"><div style="font-weight:bold;">' + esc(r.servicio) + '</div>' + detalle + '</td>' +
      '<td style="' + celda + 'text-align:center;white-space:nowrap;">' + horas + '</td>' +
      '<td style="' + celda + 'text-align:right;white-space:nowrap;color:' + m.gris + ';">' + tarifa + '</td>' +
      '<td style="' + celda + 'text-align:right;white-space:nowrap;font-weight:bold;">' + dinero(r.importe) + '</td>' +
      '</tr>';
  }).join('');

  const filaTotal = function(nombre, valor) {
    return '<tr>' +
      '<td style="padding:5px 12px;color:' + m.gris + ';">' + nombre + '</td>' +
      '<td style="padding:5px 12px;text-align:right;white-space:nowrap;">' + valor + '</td>' +
      '</tr>';
  };

  const lineasTotales = [
    filaTotal('Horas totales', esc(data.horasTotales) + ' h'),
    filaTotal('Base imponible', dinero(data.subtotal))
  ];

  if (Number(data.ivaPorcentaje || 0) > 0 || data.mostrarImpuestos) {
    lineasTotales.push(filaTotal('IVA ' + esc(Number(data.ivaPorcentaje || 0)) + ' %', dinero(data.ivaImporte)));
  }

  if (Number(data.irpfPorcentaje || 0) > 0) {
    lineasTotales.push(filaTotal('Retención IRPF ' + esc(data.irpfPorcentaje) + ' %', '&minus; ' + dinero(data.irpfImporte)));
  }

  const bloqueEmisor = facturacionLineas_([
    emisor.nombre ? '<strong>' + esc(emisor.nombre) + '</strong>' : '',
    emisor.nif ? 'NIF: ' + esc(emisor.nif) : '',
    facturacionMultilinea_(emisor.direccion),
    esc(emisor.email),
    esc(emisor.telefono)
  ]);

  const bloqueCliente = facturacionLineas_([
    '<strong>' + esc(cliente.razonSocial || cliente.empresa || data.empresa || 'Cliente') + '</strong>',
    cliente.nif ? 'NIF: ' + esc(cliente.nif) : '',
    facturacionMultilinea_(cliente.direccion),
    cliente.contacto ? 'Att. ' + esc(cliente.contacto) : '',
    esc(cliente.email)
  ]);

  const bloqueDetalles = facturacionLineas_([
    data.numero ? 'Nº: <strong>' + esc(data.numero) + '</strong>' : '',
    'Fecha de emisión: ' + esc(hoy),
    'Periodo: ' + esc(facturacionFechaCorta_(data.desde)) + ' &ndash; ' + esc(facturacionFechaCorta_(data.hasta)),
    'Servicios: ' + data.lineas.length
  ]);

  const bloquePago = facturacionLineas_([
    esc(pago.condiciones),
    pago.iban ? 'IBAN: <strong>' + esc(pago.iban) + '</strong>' : '',
    pago.iban && emisor.nombre ? 'Titular: ' + esc(emisor.nombre) : ''
  ]);

  const logo = typeof FACTURACION_LOGO_BASE64 === 'string' && FACTURACION_LOGO_BASE64
    ? '<img src="data:image/png;base64,' + FACTURACION_LOGO_BASE64 + '" width="50" height="50" alt="">'
    : '';

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;color:' + m.tinta + ';font-size:10.5px;line-height:1.4;margin:28px;">' +

    // Cabecera de marca
    '<table style="width:100%;border-collapse:collapse;"><tr>' +
      '<td style="background:' + m.oscuro + ';padding:20px 0 20px 22px;width:50px;vertical-align:middle;">' + logo + '</td>' +
      '<td style="background:' + m.oscuro + ';padding:20px 14px;vertical-align:middle;">' +
        '<div style="color:#FFFFFF;font-size:19px;font-weight:bold;letter-spacing:1px;">' + esc(m.nombre) + '</div>' +
        '<div style="color:' + m.acento + ';font-size:9px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;padding-top:3px;">' + esc(m.lema) + '</div>' +
      '</td>' +
      '<td style="background:' + m.oscuro + ';padding:20px 22px 20px 0;vertical-align:middle;text-align:right;">' +
        '<div style="color:#FFFFFF;font-size:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">' + esc(data.titulo) + '</div>' +
        (data.numero ? '<div style="color:#AEB9CC;font-size:10px;padding-top:3px;">Nº ' + esc(data.numero) + '</div>' : '') +
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
          lineasTotales.join('') +
          '<tr>' +
            '<td style="background:' + m.oscuro + ';color:#FFFFFF;font-size:12px;font-weight:bold;padding:11px 12px;">TOTAL</td>' +
            '<td style="background:' + m.oscuro + ';color:#FFFFFF;font-size:14px;font-weight:bold;padding:11px 12px;text-align:right;white-space:nowrap;">' + dinero(data.total) + '</td>' +
          '</tr>' +
        '</table>' +
      '</td>' +
    '</tr></table>' +

    // Menciones del documento (proforma, rectificativa, exenciones)
    (data.nota
      ? '<table style="width:100%;border-collapse:collapse;margin-top:22px;"><tr>' +
          '<td style="background:' + m.fondo + ';border-left:3px solid ' + m.acento + ';padding:10px 12px;font-size:9.5px;">' +
            facturacionMultilinea_(data.nota) +
          '</td>' +
        '</tr></table>'
      : '') +

    // Pie
    '<table style="width:100%;border-collapse:collapse;margin-top:34px;"><tr>' +
      '<td style="border-top:1px solid ' + m.linea + ';padding-top:10px;color:' + m.gris + ';font-size:9px;">' +
        esc(data.pie || 'Servicios prestados durante el periodo indicado.') +
      '</td>' +
      '<td style="border-top:1px solid ' + m.linea + ';padding-top:10px;color:' + m.gris + ';font-size:9px;text-align:right;white-space:nowrap;">' +
        'Henry Arce &middot; ' + esc(m.lema) +
      '</td>' +
    '</tr></table>' +

    '</body></html>';
}

// Une en líneas solo las partes que tienen contenido.
function facturacionLineas_(partes) {
  return partes
    .filter(function(parte) { return parte; })
    .map(function(parte) { return '<div>' + parte + '</div>'; })
    .join('');
}

function facturacionMultilinea_(texto) {
  return facturacionEsc_(String(texto || '').trim()).replace(/\r?\n/g, '<br>');
}

function facturacionFechaCorta_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
}

// Importe en formato español: 1.234,56 €
function facturacionDinero_(valor, moneda) {
  const partes = Number(valor || 0).toFixed(2).split('.');
  const entero = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return entero + ',' + partes[1] + ' ' + (moneda || '€');
}

function facturacionNombreArchivo_(resumen) {
  const empresa = String(resumen.empresa || 'Cliente')
    .replace(/[^\w\-]+/g, '_')
    .substring(0, 40);

  return 'Servicios_' +
    empresa +
    '_' +
    String(resumen.desde).replace(/-/g, '') +
    '_' +
    String(resumen.hasta).replace(/-/g, '');
}

function facturacionNumero_(n) {
  return Number(n || 0).toFixed(2);
}

function facturacionEsc_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Las columnas nif y direccion_fiscal son opcionales: se localizan por el
// nombre de la cabecera para no depender de su posición en la hoja.
function facturacionObtenerCliente_(empresa) {
  asegurarClientes_();

  const sh = ss_().getSheetByName(SHEETS.clientes);
  if (!sh) return null;

  const values = sh.getDataRange().getValues();
  const buscada = String(empresa || '').trim().toLowerCase();
  const cabeceras = (values[0] || []).map(function(h) {
    return String(h || '').trim().toLowerCase();
  });
  const colNif = cabeceras.indexOf('nif');
  const colDireccion = cabeceras.indexOf('direccion_fiscal');
  const colRazon = cabeceras.indexOf('razon_social');

  for (let i = 1; i < values.length; i++) {
    const emp = String(values[i][0] || '').trim().toLowerCase();

    if (emp === buscada) {
      return {
        empresa: String(values[i][0] || ''),
        tarifaHora: Number(values[i][1] || 0),
        telefonoWhatsapp: String(values[i][2] || ''),
        email: String(values[i][3] || ''),
        contacto: String(values[i][4] || ''),
        notas: String(values[i][5] || ''),
        nif: colNif === -1 ? '' : String(values[i][colNif] || '').trim(),
        direccion: colDireccion === -1 ? '' : String(values[i][colDireccion] || '').trim(),
        razonSocial: colRazon === -1 ? '' : String(values[i][colRazon] || '').trim()
      };
    }
  }

  return null;
}
