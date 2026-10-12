function pagosCrear(datos) {
  datos = datos || {};

  const empresa = String(datos.empresa || '').trim();
  if (!empresa) throw new Error('Debes seleccionar una empresa.');

  if (!datos.fechaPago || !datos.periodoDesde || !datos.periodoHasta) {
    throw new Error('Debes indicar fecha de pago y periodo pagado.');
  }

  const fechaPago = new Date(datos.fechaPago + 'T12:00:00');
  const desde = new Date(datos.periodoDesde + 'T00:00:00');
  const hasta = new Date(datos.periodoHasta + 'T23:59:59');
  const importe = Number(String(datos.importe || '').replace(',', '.'));

  if (isNaN(fechaPago.getTime()) || isNaN(desde.getTime()) || isNaN(hasta.getTime())) {
    throw new Error('Hay una fecha inválida.');
  }

  if (hasta < desde) {
    throw new Error('El periodo hasta no puede ser anterior al periodo desde.');
  }

  if (!importe || importe <= 0) {
    throw new Error('Debes indicar un importe pagado mayor que cero.');
  }

  const sh = pagosHoja_();

  const id = pagosGenerarId_();

  sh.appendRow([
    id,
    empresa,
    fechaPago,
    desde,
    hasta,
    Number(importe.toFixed(2)),
    datos.metodo || '',
    datos.concepto || 'Pago recibido',
    datos.observaciones || '',
    new Date()
  ]);

  return id;
}

function pagosListar(filtros) {
  filtros = filtros || {};

  const sh = pagosHoja_();

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const empresaFiltro = String(filtros.empresa || '').trim().toLowerCase();

  return values
    .slice(1)
    .filter(r => r[0])
    .filter(r => {
      const empresa = String(r[1] || '').toLowerCase();
      return !empresaFiltro || empresa === empresaFiltro;
    })
    .reverse()
    .map(r => ({
      id: String(r[0] || ''),
      empresa: String(r[1] || ''),
      fechaPago: pagosFechaTexto_(r[2]),
      periodoDesde: pagosFechaTexto_(r[3]),
      periodoHasta: pagosFechaTexto_(r[4]),
      importe: Number(r[5] || 0),
      metodo: String(r[6] || ''),
      concepto: String(r[7] || ''),
      observaciones: String(r[8] || '')
    }));
}

function pagosListarPorPeriodo_(empresa, desde, hasta) {
  const sh = pagosHoja_();

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const buscada = String(empresa || '').trim().toLowerCase();

  return values
    .slice(1)
    .filter(r => r[0])
    .filter(r => {
      const emp = String(r[1] || '').trim().toLowerCase();
      const pDesde = r[3];
      const pHasta = r[4];

      if (buscada && emp !== buscada) return false;
      if (!(pDesde instanceof Date) || !(pHasta instanceof Date)) return false;

      return pDesde <= hasta && pHasta >= desde;
    })
    .map(r => ({
      id: String(r[0] || ''),
      empresa: String(r[1] || ''),
      fechaPago: pagosFechaTexto_(r[2]),
      periodoDesde: pagosFechaTexto_(r[3]),
      periodoHasta: pagosFechaTexto_(r[4]),
      importe: Number(r[5] || 0),
      metodo: String(r[6] || ''),
      concepto: String(r[7] || '')
    }));
}

function pagosGenerarId_() {
  return 'PAG-' + Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyyMMdd-HHmmss'
  );
}

function pagosFechaTexto_(valor) {
  if (!valor) return '';

  if (valor instanceof Date) {
    return Utilities.formatDate(valor, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }

  return String(valor);
}

function pagosHoja_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEETS.pagos);
  if (!sh) sh = ss.insertSheet(SHEETS.pagos);
  asegurarPagos_();
  return sh;
}
