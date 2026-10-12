function cobroUnicoCrear(datos) {
  datos = datos || {};

  const importe = Number(String(datos.importe || '').replace(',', '.'));

  if (!importe || importe <= 0) {
    throw new Error('Debes indicar un importe mayor que cero.');
  }

  const fecha = datos.fecha
    ? new Date(datos.fecha + 'T12:00:00')
    : new Date();

  if (isNaN(fecha.getTime())) {
    throw new Error('Fecha inválida.');
  }

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) throw new Error('No existe la hoja Peticiones.');

  const id = cobroUnicoGenerarId_();
  const concepto = datos.concepto || 'Cobro único';

  sh.appendRow([
    id,
    datos.empresa || '',
    concepto,
    fecha,
    fecha,
    0,
    0,
    0,
    Number(importe.toFixed(2)),
    'CERRADA',
    datos.observaciones || '',
    'UNICO',
    new Date()
  ]);

  return id;
}

function cobroUnicoGenerarId_() {
  return 'COB-' + Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyyMMdd-HHmmss'
  );
}
