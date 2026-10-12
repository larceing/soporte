function historialObtenerPeticiones(filtros) {
  filtros = filtros || {};

  asegurarPeticiones_();

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) return [];

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = peticionesHeaderMap_();

  const desde = filtros.desde ? new Date(filtros.desde + 'T00:00:00') : null;
  const hasta = filtros.hasta ? new Date(filtros.hasta + 'T23:59:59') : null;

  const idFiltro = String(filtros.id || '').trim().toLowerCase();
  const empresaFiltro = String(filtros.empresa || '').trim().toLowerCase();
  const peticionFiltro = String(filtros.peticion || '').trim().toLowerCase();
  const estadoFiltro =
  String(filtros.estado || '')
  .trim()
  .toLowerCase();
  const estadoCobroFiltro = String(filtros.estadoCobro || '').trim().toLowerCase();

  return values
    .slice(1)
    .filter(r => r[0])
    .filter(r => {
      const id = String(r[0] || '').toLowerCase();
      const empresa = String(r[1] || '').toLowerCase();
      const peticion = String(r[2] || '').toLowerCase();
      const inicio = r[3];
      const estado =String(r[9] || '').trim();
      const estadoLower = estado.toLowerCase();
      const estadoCobro = historialEstadoCobro_(r, headers).toLowerCase();

      if (estado === 'ELIMINADA') return false; 
      if (estadoFiltro && estadoLower !== estadoFiltro) return false;
      if (estadoCobroFiltro && estadoCobro !== estadoCobroFiltro) return false;
      if (idFiltro && !id.includes(idFiltro)) return false;
      if (empresaFiltro && !empresa.includes(empresaFiltro)) return false;
      if (peticionFiltro && !peticion.includes(peticionFiltro)) return false;

      if (desde || hasta) {
        if (!(inicio instanceof Date)) return false;
        if (desde && inicio < desde) return false;
        if (hasta && inicio > hasta) return false;
      }

      return true;
    })
    .reverse()
    .map(r => {
      const pagoId = String(r[(headers.pago_id || 14) - 1] || '');
      const pagadoEn = r[(headers.pagado_en || 15) - 1];

      return {
        id: String(r[0] || ''),
        empresa: String(r[1] || ''),
        peticion: String(r[2] || ''),
        inicio: historialFechaTexto_(r[3]),
        fin: historialFechaTexto_(r[4]),
        minutosReales: r[5],
        horasFacturadas: r[6],
        tarifaHora: r[7],
        importe: r[8],
        estado: String(r[9] || ''),
        estadoCobro: historialEstadoCobro_(r, headers),
        pagoId: pagoId,
        pagadoEn: historialFechaTexto_(pagadoEn),
        observaciones: String(r[10] || ''),
        tipo: String(r[11] || ''),
        creadoEn: historialFechaTexto_(r[12])
      };
    });
}

function historialEstadoCobro_(row, headers) {
  const estado = String(row[9] || '').trim();

  if (estado !== 'CERRADA') return '-';

  return peticionesEsPagada_(row, headers) ? 'COBRADO' : 'PENDIENTE';
}

function historialFechaTexto_(valor) {
  if (!valor) return '';

  if (valor instanceof Date) {
    return Utilities.formatDate(
      valor,
      Session.getScriptTimeZone(),
      'dd/MM/yyyy HH:mm'
    );
  }

  return String(valor);
}

function historialObtenerPeticionPorId(id) {
  asegurarPeticiones_();

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) throw new Error('No existe la hoja Peticiones.');

  const values = sh.getDataRange().getValues();
  const headers = peticionesHeaderMap_();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(id).trim()) {
      return {
        id: String(values[i][0] || ''),
        empresa: String(values[i][1] || ''),
        peticion: String(values[i][2] || ''),
        inicio: historialFechaInput_(values[i][3]),
        fin: historialFechaInput_(values[i][4]),
        minutosReales: values[i][5],
        horasFacturadas: values[i][6],
        tarifaHora: values[i][7],
        importe: values[i][8],
        estado: String(values[i][9] || ''),
        estadoCobro: historialEstadoCobro_(values[i], headers),
        pagoId: String(values[i][(headers.pago_id || 14) - 1] || ''),
        pagadoEn: historialFechaInput_(values[i][(headers.pagado_en || 15) - 1]),
        observaciones: String(values[i][10] || ''),
        tipo: String(values[i][11] || '')
      };
    }
  }

  throw new Error('No se encontró la petición: ' + id);
}

function historialActualizarPeticion(datos) {
  datos = datos || {};

  if (!datos.id) {
    throw new Error('Falta el ID de la petición.');
  }

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) throw new Error('No existe la hoja Peticiones.');

  const values = sh.getDataRange().getValues();

  const inicio = datos.inicio ? new Date(datos.inicio) : '';
  const fin = datos.fin ? new Date(datos.fin) : '';

  if (inicio && isNaN(inicio.getTime())) {
    throw new Error('Fecha de inicio inválida.');
  }

  if (fin && isNaN(fin.getTime())) {
    throw new Error('Fecha de fin inválida.');
  }

  let minutos = Number(datos.minutosReales || 0);
  let horas = Number(datos.horasFacturadas || 0);
  let tarifa = Number(datos.tarifaHora || configGet_('TARIFA_HORA') || 0);
  let importe = Number(datos.importe || 0);

  if (inicio && fin && fin > inicio) {
    minutos = Math.max(1, Math.ceil((fin - inicio) / 1000 / 60));

    if (!horas || horas <= 0) {
      horas = Math.max(
        Number(configGet_('HORAS_MINIMAS') || 1),
        Math.ceil(minutos / 60)
      );
    }

    if (!importe || importe <= 0) {
      importe = horas * tarifa;
    }
  }

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(datos.id).trim()) {
      const fila = i + 1;

      sh.getRange(fila, 2).setValue(datos.empresa || '');
      sh.getRange(fila, 3).setValue(datos.peticion || '');
      sh.getRange(fila, 4).setValue(inicio || '');
      sh.getRange(fila, 5).setValue(fin || '');
      sh.getRange(fila, 6).setValue(minutos);
      sh.getRange(fila, 7).setValue(horas);
      sh.getRange(fila, 8).setValue(tarifa);
      sh.getRange(fila, 9).setValue(importe);
      sh.getRange(fila, 10).setValue(datos.estado || 'CERRADA');
      sh.getRange(fila, 11).setValue(datos.observaciones || '');
      sh.getRange(fila, 12).setValue(datos.tipo || 'MANUAL');

      return true;
    }
  }

  throw new Error('No se encontró la petición para actualizar.');
}

function historialFechaInput_(valor) {
  if (!valor) return '';

  const fecha = valor instanceof Date ? valor : new Date(valor);

  if (isNaN(fecha.getTime())) return '';

  return Utilities.formatDate(
    fecha,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd'T'HH:mm"
  );
}

function historialEliminarPeticion(id) {
  if (!id) {
    throw new Error('Falta el ID de la petición.');
  }

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) throw new Error('No existe la hoja Peticiones.');

  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(id).trim()) {
      const fila = i + 1;

      sh.getRange(fila, 10).setValue('ELIMINADA');

      return true;
    }
  }

  throw new Error('No se encontró la petición para eliminar.');
}
