function manualCrearPeticion(datos) {
  datos = datos || {};

  if (!datos.inicio || !datos.fin) {
    throw new Error('Debes indicar inicio y fin.');
  }

  const inicio = new Date(datos.inicio);
  const fin = new Date(datos.fin);

  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) {
    throw new Error('Fecha de inicio o fin inválida.');
  }

  if (fin <= inicio) {
    throw new Error('La fecha de fin debe ser posterior al inicio.');
  }

  const minutos = Math.max(1, Math.ceil((fin - inicio) / 1000 / 60));
  const horas = manualCalcularHoras_(minutos);
  const tarifa = clientesTarifaHora_(datos.empresa);
  const importe = horas * tarifa;

  const sh = ss_().getSheetByName(SHEETS.peticiones);
  const id = manualGenerarId_();

  sh.appendRow([
    id,
    datos.empresa || '',
    datos.peticion || '',
    inicio,
    fin,
    minutos,
    horas,
    tarifa,
    importe,
    'CERRADA',
    datos.observaciones || '',
    'MANUAL',
    new Date()
  ]);

  return id;
}

function manualCalcularHoras_(minutos) {
  const horasMinimas = Number(configGet_('HORAS_MINIMAS') || 1);
  const horasRedondeadas = Math.ceil(Number(minutos || 0) / 60);

  return Math.max(horasMinimas, horasRedondeadas);
}

function manualGenerarId_() {
  return 'PET-' + Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyyMMdd-HHmmss'
  );
}
