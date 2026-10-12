const SPREADSHEET_ID = '13RDD9jNUDpMzTGbMS2uT-2YVi3ssyKwokwkRtZ6GYKs';

const SHEETS = {
  macro: 'MacroData',
  estado: 'Estado',
  peticiones: 'Peticiones',
  clientes: 'Clientes',
  pagos: 'Pagos',
  facturas: 'Facturas'
};

function doGet() {
  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Gestor de peticiones')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Gestor')
    .addItem('Instalar / revisar estructura', 'instalarEstructuraSegura')
    .addItem('Abrir app', 'abrirApp')
    .addToUi();
}

function abrirApp() {
  const html = HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setWidth(1100)
    .setHeight(760);

  SpreadsheetApp.getUi().showModalDialog(html, 'Gestor de peticiones');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function instalarEstructuraSegura() {
  const ss = ss_();

  crearHojaSiNoExiste_(ss, SHEETS.macro);
  crearHojaSiNoExiste_(ss, SHEETS.estado);
  crearHojaSiNoExiste_(ss, SHEETS.peticiones);
  crearHojaSiNoExiste_(ss, SHEETS.clientes);
  crearHojaSiNoExiste_(ss, SHEETS.pagos);

  asegurarMacroData_();
  asegurarEstado_();
  asegurarPeticiones_();
  asegurarClientes_();
  asegurarPagos_();
  documentosHoja_();

  return true;
}

function crearHojaSiNoExiste_(ss, nombre) {
  let sh = ss.getSheetByName(nombre);
  if (!sh) sh = ss.insertSheet(nombre);
  return sh;
}

function asegurarMacroData_() {
  const sh = ss_().getSheetByName(SHEETS.macro);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['clave', 'valor', 'descripcion']]);
  }

  const defaults = [
    ['TARIFA_HORA', 15, 'Importe por hora'],
    ['MONEDA', '€', 'Símbolo monetario'],
    ['HORAS_MINIMAS', 1, 'Mínimo facturable'],
    ['REDONDEO', 'ARRIBA', 'Redondeo a la hora superior'],
    ['EMPRESA_DEFECTO', '', 'Empresa por defecto'],
    ['APP_NOMBRE', 'Gestor de peticiones', 'Nombre visible'],
    ['IRPF', 0, 'Porcentaje de retención de IRPF en el PDF (0 = no aplicar)'],
    ['DOC_TITULO', 'Resumen de servicios', 'Título del documento PDF'],
    ['EMISOR_NOMBRE', '', 'Nombre o razón social que aparece en el PDF'],
    ['EMISOR_NIF', '', 'NIF del emisor'],
    ['EMISOR_DIRECCION', '', 'Dirección fiscal del emisor'],
    ['EMISOR_EMAIL', '', 'Email de contacto del emisor'],
    ['EMISOR_TELEFONO', '', 'Teléfono de contacto del emisor'],
    ['EMISOR_IBAN', '', 'IBAN para el pago'],
    ['PAGO_CONDICIONES', '', 'Condiciones de pago, por ejemplo: Transferencia a 15 días'],
    ['DOC_PIE', '', 'Texto del pie del PDF'],
    ['FACTURA_SERIE', 'F', 'Serie de las facturas (F-2026-0001)'],
    ['PROFORMA_SERIE', 'PF', 'Serie de las proformas'],
    ['RECTIFICATIVA_SERIE', 'R', 'Serie de las facturas rectificativas'],
    ['FACTURA_INICIO_ANIO', '', 'Año en el que se continúa una numeración ya empezada fuera de la app'],
    ['FACTURA_INICIO_NUMERO', '', 'Primer número de factura a usar ese año'],
    ['FACTURA_MENCION', '', 'Mención legal que debe figurar en las facturas, si aplica']
  ];

  defaults.forEach(row => asegurarClaveMacro_(row[0], row[1], row[2]));
}

function asegurarClaveMacro_(clave, valor, descripcion) {
  const sh = ss_().getSheetByName(SHEETS.macro);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === clave) return;
  }

  sh.appendRow([clave, valor, descripcion]);
}

function asegurarEstado_() {
  const sh = ss_().getSheetByName(SHEETS.estado);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 2).setValues([['clave', 'valor']]);
  }

  asegurarClaveEstado_('PETICION_ACTIVA', 'FALSE');
  asegurarClaveEstado_('ID_ACTIVO', '');
  asegurarClaveEstado_('FECHA_INICIO', '');
  asegurarClaveEstado_('ULTIMA_ACCION', '');
}

function asegurarClaveEstado_(clave, valor) {
  const sh = ss_().getSheetByName(SHEETS.estado);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === clave) return;
  }

  sh.appendRow([clave, valor]);
}

function asegurarPeticiones_() {
  const sh = ss_().getSheetByName(SHEETS.peticiones);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 15).setValues([[
      'id',
      'empresa',
      'peticion',
      'inicio',
      'fin',
      'minutos_reales',
      'horas_facturadas',
      'tarifa_hora',
      'importe',
      'estado',
      'observaciones',
      'tipo',
      'creado_en',
      'pago_id',
      'pagado_en'
    ]]);
    return;
  }

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  if (headers.indexOf('pago_id') === -1) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue('pago_id');
  }

  const headersConPago = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  if (headersConPago.indexOf('pagado_en') === -1) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue('pagado_en');
  }
}

function peticionesHeaderMap_() {
  const sh = ss_().getSheetByName(SHEETS.peticiones);
  asegurarPeticiones_();

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const map = {};

  headers.forEach(function(header, index) {
    map[String(header || '').trim()] = index + 1;
  });

  return map;
}

function peticionesEsPagada_(row, headerMap) {
  const pagoCol = headerMap.pago_id || 14;
  return Boolean(String(row[pagoCol - 1] || '').trim());
}

function peticionesMarcarPagadas_(filas, pagoId) {
  if (!filas || !filas.length) return;

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  const headers = peticionesHeaderMap_();
  const pagoCol = headers.pago_id;
  const pagadoEnCol = headers.pagado_en;
  const ahora = new Date();

  filas.forEach(function(fila) {
    sh.getRange(fila, pagoCol).setValue(pagoId);
    sh.getRange(fila, pagadoEnCol).setValue(ahora);
  });
}

function asegurarClientes_() {
  const sh = ss_().getSheetByName(SHEETS.clientes);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 7).setValues([[
      'empresa',
      'tarifa_hora',
      'telefono_whatsapp',
      'email',
      'contacto',
      'notas',
      'activo'
    ]]);
    return;
  }

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  if (headers[1] === 'telefono_whatsapp') {
    sh.insertColumnAfter(1);
    sh.getRange(1, 2).setValue('tarifa_hora');
  }

  const actuales = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  if (actuales.indexOf('activo') === -1) {
    const col = sh.getLastColumn() + 1;
    sh.getRange(1, col).setValue('activo');
    if (sh.getLastRow() > 1) {
      sh.getRange(2, col, sh.getLastRow() - 1, 1).setValue('TRUE');
    }
  }
}

function asegurarPagos_() {
  const sh = ss_().getSheetByName(SHEETS.pagos);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 10).setValues([[
      'id',
      'empresa',
      'fecha_pago',
      'periodo_desde',
      'periodo_hasta',
      'importe',
      'metodo',
      'concepto',
      'observaciones',
      'creado_en'
    ]]);
  }
}
