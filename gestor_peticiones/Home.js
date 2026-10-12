function homeObtenerEstado() {
  const estado = homeLeerEstado_();

  const activa = homeEsTrue_(estado.PETICION_ACTIVA);
  let peticion = null;

  if (activa && estado.ID_ACTIVO) {
    peticion = homeBuscarPeticionPorId_(estado.ID_ACTIVO);
  }

  return JSON.parse(JSON.stringify({
    activa: activa,
    idActivo: String(estado.ID_ACTIVO || ''),
    fechaInicio: homeFechaTexto_(estado.FECHA_INICIO),
    ultimaAccion: homeFechaTexto_(estado.ULTIMA_ACCION),
    peticion: peticion
  }));
}

function homeEmpezarPeticion(datos) {
  datos = datos || {};

  const estado = homeLeerEstado_();

  if (homeEsTrue_(estado.PETICION_ACTIVA)) {
    throw new Error('Ya hay una petición activa. Debes pararla antes de empezar otra.');
  }

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  const ahora = new Date();
  const id = homeGenerarId_();

  sh.appendRow([
    id,
    datos.empresa || configGet_('EMPRESA_DEFECTO') || '',
    datos.peticion || '',
    ahora,
    '',
    '',
    '',
    '',
    '',
    'EN_CURSO',
    datos.observaciones || '',
    'AUTO',
    ahora
  ]);

  homeEscribirEstado_('PETICION_ACTIVA', 'TRUE');
  homeEscribirEstado_('ID_ACTIVO', id);
  homeEscribirEstado_('FECHA_INICIO', ahora);
  homeEscribirEstado_('ULTIMA_ACCION', ahora);

  //return homeObtenerEstado();
  return true;
}

function homePararPeticion() {
  const estado = homeLeerEstado_();

  if (!homeEsTrue_(estado.PETICION_ACTIVA) || !estado.ID_ACTIVO) {
    throw new Error('No hay ninguna petición activa.');
  }

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  const peticion = homeBuscarPeticionPorId_(estado.ID_ACTIVO);

  if (!peticion) {
    homeLimpiarEstadoActivo_();
    throw new Error('El estado indicaba una petición activa, pero no se encontró en Peticiones.');
  }

  const fin = new Date();
  const inicio = new Date(peticion.inicioRaw);

  const minutos = Math.max(1, Math.ceil((fin - inicio) / 1000 / 60));
  const horas = homeCalcularHorasFacturables_(minutos);
  const tarifa = clientesTarifaHora_(peticion.empresa);
  const importe = horas * tarifa;

  sh.getRange(peticion.fila, 5).setValue(fin);
  sh.getRange(peticion.fila, 6).setValue(minutos);
  sh.getRange(peticion.fila, 7).setValue(horas);
  sh.getRange(peticion.fila, 8).setValue(tarifa);
  sh.getRange(peticion.fila, 9).setValue(importe);
  sh.getRange(peticion.fila, 10).setValue('CERRADA');

  homeLimpiarEstadoActivo_();

  //return homeObtenerEstado();
  return true;
}

function homeLeerEstado_() {
  const sh = ss_().getSheetByName(SHEETS.estado);
  if (!sh) throw new Error('No existe la hoja Estado.');

  const values = sh.getDataRange().getValues();
  const obj = {};

  for (let i = 1; i < values.length; i++) {
    obj[String(values[i][0]).trim()] = values[i][1];
  }

  return obj;
}

function homeEscribirEstado_(clave, valor) {
  const sh = ss_().getSheetByName(SHEETS.estado);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === clave) {
      sh.getRange(i + 1, 2).setValue(valor);
      return;
    }
  }

  sh.appendRow([clave, valor]);
}

function homeLimpiarEstadoActivo_() {
  homeEscribirEstado_('PETICION_ACTIVA', 'FALSE');
  homeEscribirEstado_('ID_ACTIVO', '');
  homeEscribirEstado_('FECHA_INICIO', '');
  homeEscribirEstado_('ULTIMA_ACCION', new Date());
}

function homeBuscarPeticionPorId_(id) {
  const sh = ss_().getSheetByName(SHEETS.peticiones);
  if (!sh) return null;

  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(id).trim()) {
      return {
        fila: i + 1,
        id: String(values[i][0] || ''),
        empresa: String(values[i][1] || ''),
        peticion: String(values[i][2] || ''),
        inicio: homeFechaTexto_(values[i][3]),
        inicioRaw: homeFechaTexto_(values[i][3]),
        fin: homeFechaTexto_(values[i][4]),
        minutosReales: values[i][5],
        horasFacturadas: values[i][6],
        tarifaHora: values[i][7],
        importe: values[i][8],
        estado: String(values[i][9] || ''),
        observaciones: String(values[i][10] || ''),
        tipo: String(values[i][11] || '')
      };
    }
  }

  return null;
}

function homeCalcularHorasFacturables_(minutos) {
  const horasMinimas = Number(configGet_('HORAS_MINIMAS') || 1);
  const horasRedondeadas = Math.ceil(Number(minutos || 0) / 60);

  return Math.max(horasMinimas, horasRedondeadas);
}

function homeGenerarId_() {
  return 'PET-' + Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyyMMdd-HHmmss'
  );
}

function homeEsTrue_(valor) {
  const v = String(valor).trim().toLowerCase();
  return valor === true || v === 'true' || v === 'sí' || v === 'si' || v === '1';
}

function homeFechaTexto_(valor) {
  if (!valor) return '';

  if (valor instanceof Date) {
    return Utilities.formatDate(
      valor,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd'T'HH:mm:ss"
    );
  }

  return String(valor);
}


function testHomeEstado() {
  Logger.log(JSON.stringify(homeObtenerEstado()));
}
