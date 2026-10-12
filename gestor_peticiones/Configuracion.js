function configObtener() {
  return {
    tarifaHora: Number(configGet_('TARIFA_HORA') || 0),
    moneda: String(configGet_('MONEDA') || '€'),
    horasMinimas: Number(configGet_('HORAS_MINIMAS') || 1),
    empresaDefecto: String(configGet_('EMPRESA_DEFECTO') || ''),
    appNombre: String(configGet_('APP_NOMBRE') || 'Gestor de peticiones')
  };
}

function configGuardar(datos) {
  datos = datos || {};

  configSet_('TARIFA_HORA', Number(datos.tarifaHora || 0));
  configSet_('MONEDA', datos.moneda || '€');
  configSet_('HORAS_MINIMAS', Number(datos.horasMinimas || 1));
  configSet_('EMPRESA_DEFECTO', datos.empresaDefecto || '');

  return configObtener();
}

function configGet_(clave) {
  const sh = ss_().getSheetByName(SHEETS.macro);
  if (!sh) throw new Error('No existe la hoja MacroData.');

  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === clave) {
      return values[i][1];
    }
  }

  return '';
}

function configSet_(clave, valor) {
  const sh = ss_().getSheetByName(SHEETS.macro);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === clave) {
      sh.getRange(i + 1, 2).setValue(valor);
      return;
    }
  }

  sh.appendRow([clave, valor, '']);
}
