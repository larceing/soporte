function cobroCalcularImporte(datos) {
  return cobroObtenerResumenPendiente_(datos, false);
}

function cobroCobrarTodoPeriodo(datos) {
  datos = datos || {};

  if (!datos.empresa) {
    throw new Error('Selecciona una empresa concreta antes de cobrar todo el periodo.');
  }

  const resumen = cobroObtenerResumenPendiente_(datos, true);

  if (!resumen.registros || resumen.total <= 0) {
    throw new Error('No hay registros pendientes de cobro en este periodo.');
  }

  const hoy = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd'
  );

  const id = pagosCrear({
    empresa: resumen.empresa,
    fechaPago: hoy,
    periodoDesde: resumen.desde,
    periodoHasta: resumen.hasta,
    importe: resumen.total,
    metodo: datos.metodo || 'No indicado',
    concepto: 'Cobro total periodo ' + resumen.desde + ' - ' + resumen.hasta,
    observaciones: 'Registros marcados como pagados desde Calcular cobro.'
  });

  peticionesMarcarPagadas_(resumen.filasPendientes, id);

  return {
    id: id,
    resumen: cobroObtenerResumenPendiente_(datos, false)
  };
}

function cobroObtenerResumenPendiente_(datos, incluirFilas) {
  datos = datos || {};

  if (!datos.desde || !datos.hasta) {
    throw new Error('Debes indicar fecha desde y fecha hasta.');
  }

  const desde = new Date(datos.desde + 'T00:00:00');
  const hasta = new Date(datos.hasta + 'T23:59:59');

  if (isNaN(desde.getTime()) || isNaN(hasta.getTime())) {
    throw new Error('Fechas inválidas.');
  }

  if (hasta < desde) {
    throw new Error('La fecha hasta no puede ser anterior a la fecha desde.');
  }

  asegurarPeticiones_();

  const empresaFiltro = String(datos.empresa || '').trim().toLowerCase();
  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) throw new Error('No existe la hoja Peticiones.');

  const headers = peticionesHeaderMap_();
  const values = sh.getDataRange().getValues();

  let total = 0;
  let horas = 0;
  let registros = 0;
  const lineas = [];
  const filasPendientes = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[0];
    const empresa = String(row[1] || '');
    const peticion = String(row[2] || '');
    const inicio = row[3];
    const horasFacturadas = Number(row[6] || 0);
    const importe = Number(row[8] || 0);
    const estado = String(row[9] || '').trim();
    const tipo = String(row[11] || '').trim();

    if (!id) continue;
    if (!(inicio instanceof Date)) continue;
    if (estado !== 'CERRADA') continue;
    if (peticionesEsPagada_(row, headers)) continue;

    if (empresaFiltro && empresa.toLowerCase() !== empresaFiltro) {
      continue;
    }

    if (inicio >= desde && inicio <= hasta) {
      total += importe;
      horas += horasFacturadas;
      registros++;
      filasPendientes.push(i + 1);

      lineas.push({
        id: String(id),
        fecha: Utilities.formatDate(inicio, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
        empresa: empresa,
        peticion: peticion,
        horas: horasFacturadas,
        horasTexto: tipo === 'UNICO' ? '-' : horasFacturadas,
        importe: Number(importe.toFixed(2)),
        estado: estado,
        tipo: tipo
      });
    }
  }

  const pagos = pagosListarPorPeriodo_(datos.empresa || '', desde, hasta);
  const totalPagado = pagos.reduce((sum, pago) => sum + Number(pago.importe || 0), 0);

  const resumen = {
    desde: datos.desde,
    hasta: datos.hasta,
    empresa: datos.empresa || '',
    total: Number(total.toFixed(2)),
    totalPagado: Number(totalPagado.toFixed(2)),
    pendiente: Number(total.toFixed(2)),
    horas: horas,
    registros: registros,
    moneda: String(configGet_('MONEDA') || '€'),
    pagos: pagos,
    lineas: lineas
  };

  if (incluirFilas) {
    resumen.filasPendientes = filasPendientes;
  }

  return resumen;
}
