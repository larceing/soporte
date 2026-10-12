// Proformas, facturas y facturas rectificativas.
//
// Cada documento guarda una copia congelada de sus líneas y de los datos
// fiscales del momento (datos_json), de modo que editar después una petición o
// un cliente no altera un documento ya emitido. Las facturas no se borran ni se
// editan: un error se corrige con una factura rectificativa.

const DOC_COLUMNAS = [
  'id',
  'tipo',
  'codigo',
  'serie',
  'anio',
  'numero',
  'fecha_emision',
  'empresa',
  'periodo_desde',
  'periodo_hasta',
  'base',
  'iva_pct',
  'iva_importe',
  'irpf_pct',
  'irpf_importe',
  'total',
  'estado',
  'origen_id',
  'pago_id',
  'pdf_url',
  'datos_json',
  'creado_en'
];

const DOC_TITULOS = {
  PROFORMA: 'Factura proforma',
  FACTURA: 'Factura',
  RECTIFICATIVA: 'Factura rectificativa'
};

function documentosHoja_() {
  const ss = ss_();
  let sh = ss.getSheetByName(SHEETS.facturas);
  if (!sh) sh = ss.insertSheet(SHEETS.facturas);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, DOC_COLUMNAS.length).setValues([DOC_COLUMNAS]);
  }

  return sh;
}

function documentosLeer_() {
  const values = documentosHoja_().getDataRange().getValues();
  const docs = [];

  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;

    const doc = { fila: i + 1 };
    DOC_COLUMNAS.forEach(function(columna, c) {
      doc[columna] = values[i][c];
    });
    docs.push(doc);
  }

  return docs;
}

function documentosDatos_(doc) {
  try {
    return JSON.parse(doc.datos_json || '{}');
  } catch (e) {
    return {};
  }
}

function documentosBuscar_(docs, id) {
  const buscado = String(id || '').trim();

  for (let i = 0; i < docs.length; i++) {
    if (String(docs[i].id).trim() === buscado) return docs[i];
  }

  throw new Error('No se encontró el documento: ' + buscado);
}

function documentosEscribir_(doc, columna, valor) {
  documentosHoja_()
    .getRange(doc.fila, DOC_COLUMNAS.indexOf(columna) + 1)
    .setValue(valor);
}

function documentosFecha_(valor, formato) {
  if (!valor) return '';

  if (valor instanceof Date) {
    return Utilities.formatDate(valor, Session.getScriptTimeZone(), formato);
  }

  return String(valor);
}

function documentosRedondear_(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

// Versión sin fechas ni JSON interno, apta para enviarla al navegador.
function documentosPublico_(doc) {
  const datos = documentosDatos_(doc);

  return {
    id: String(doc.id),
    tipo: String(doc.tipo),
    codigo: String(doc.codigo),
    fecha: documentosFecha_(doc.fecha_emision, 'dd/MM/yyyy'),
    empresa: String(doc.empresa || ''),
    periodoDesde: documentosFecha_(doc.periodo_desde, 'dd/MM/yyyy'),
    periodoHasta: documentosFecha_(doc.periodo_hasta, 'dd/MM/yyyy'),
    base: Number(doc.base || 0),
    total: Number(doc.total || 0),
    estado: String(doc.estado || ''),
    origenId: String(doc.origen_id || ''),
    pdfUrl: String(doc.pdf_url || ''),
    servicios: (datos.lineas || []).length
  };
}

function documentosListar() {
  return documentosLeer_().reverse().map(documentosPublico_);
}

function documentosSeries_(config) {
  return {
    PROFORMA: String(config.PROFORMA_SERIE || '').trim() || 'PF',
    FACTURA: String(config.FACTURA_SERIE || '').trim() || 'F',
    RECTIFICATIVA: String(config.RECTIFICATIVA_SERIE || '').trim() || 'R'
  };
}

// Numeración correlativa por tipo, serie y año. FACTURA_INICIO_ANIO y
// FACTURA_INICIO_NUMERO permiten continuar una numeración empezada fuera de
// la app, y solo actúan en el año indicado.
function documentosSiguienteNumero_(docs, tipo, serie, anio, config) {
  let maximo = 0;

  docs.forEach(function(doc) {
    if (String(doc.tipo) !== tipo) return;
    if (String(doc.serie) !== serie) return;
    if (Number(doc.anio) !== anio) return;

    maximo = Math.max(maximo, Number(doc.numero) || 0);
  });

  let siguiente = maximo + 1;

  if (tipo === 'FACTURA' && Number(config.FACTURA_INICIO_ANIO) === anio) {
    siguiente = Math.max(siguiente, Number(config.FACTURA_INICIO_NUMERO) || 1);
  }

  return siguiente;
}

function documentosCodigo_(serie, anio, numero) {
  return serie + '-' + anio + '-' + ('0000' + numero).slice(-4);
}

function documentosEmisor_(config) {
  return {
    nombre: String(config.EMISOR_NOMBRE || '').trim(),
    nif: String(config.EMISOR_NIF || '').trim(),
    direccion: String(config.EMISOR_DIRECCION || '').trim(),
    email: String(config.EMISOR_EMAIL || '').trim(),
    telefono: String(config.EMISOR_TELEFONO || '').trim()
  };
}

function documentosCliente_(empresa) {
  const cliente = facturacionObtenerCliente_(empresa) || {};

  return {
    empresa: String(cliente.empresa || empresa || ''),
    razonSocial: String(cliente.razonSocial || ''),
    nif: String(cliente.nif || ''),
    direccion: String(cliente.direccion || ''),
    contacto: String(cliente.contacto || ''),
    email: String(cliente.email || '')
  };
}

// Peticiones que ya están en una proforma pendiente o en una factura en vigor.
function documentosPeticionesOcupadas_(docs) {
  const ocupadas = {};

  docs.forEach(function(doc) {
    const tipo = String(doc.tipo);
    const estado = String(doc.estado);
    const enVigor =
      (tipo === 'PROFORMA' && estado === 'PENDIENTE') ||
      (tipo === 'FACTURA' && (estado === 'EMITIDA' || estado === 'COBRADA'));

    if (!enVigor) return;

    (documentosDatos_(doc).lineas || []).forEach(function(linea) {
      ocupadas[String(linea.id)] = String(doc.codigo);
    });
  });

  return ocupadas;
}

// Numera, calcula totales, genera el PDF y guarda la fila. El PDF se genera
// antes de guardar para que un fallo no consuma un número.
function documentosNuevo_(docs, config, tipo, campos) {
  const ahora = new Date();
  const anio = Number(Utilities.formatDate(ahora, Session.getScriptTimeZone(), 'yyyy'));
  const serie = documentosSeries_(config)[tipo];
  const numero = documentosSiguienteNumero_(docs, tipo, serie, anio, config);

  const ivaPct = Number(campos.ivaPct === undefined ? config.IVA || 0 : campos.ivaPct);
  const irpfPct = Number(campos.irpfPct === undefined ? config.IRPF || 0 : campos.irpfPct);

  const base = documentosRedondear_(campos.lineas.reduce(function(suma, linea) {
    return suma + Number(linea.importe || 0);
  }, 0));
  const ivaImporte = documentosRedondear_(base * ivaPct / 100);
  const irpfImporte = documentosRedondear_(base * irpfPct / 100);

  const notas = [];
  if (campos.nota) notas.push(campos.nota);
  if (tipo !== 'PROFORMA' && String(config.FACTURA_MENCION || '').trim()) {
    notas.push(String(config.FACTURA_MENCION).trim());
  }

  const datos = {
    moneda: String(config.MONEDA || '€'),
    emisor: campos.emisor || documentosEmisor_(config),
    cliente: campos.cliente || documentosCliente_(campos.empresa),
    pago: {
      iban: String(config.EMISOR_IBAN || '').trim(),
      condiciones: String(config.PAGO_CONDICIONES || '').trim()
    },
    pie: String(config.DOC_PIE || '').trim(),
    nota: notas.join('\n'),
    lineas: campos.lineas
  };

  const codigo = documentosCodigo_(serie, anio, numero);

  const doc = {
    // El código es único por construcción, así que sirve de identificador.
    id: 'DOC-' + codigo,
    tipo: tipo,
    codigo: codigo,
    serie: serie,
    anio: anio,
    numero: numero,
    fecha_emision: ahora,
    empresa: campos.empresa,
    periodo_desde: campos.desde,
    periodo_hasta: campos.hasta,
    base: base,
    iva_pct: ivaPct,
    iva_importe: ivaImporte,
    irpf_pct: irpfPct,
    irpf_importe: irpfImporte,
    total: documentosRedondear_(base + ivaImporte - irpfImporte),
    estado: tipo === 'PROFORMA' ? 'PENDIENTE' : 'EMITIDA',
    origen_id: campos.origenId || '',
    pago_id: '',
    pdf_url: '',
    datos_json: JSON.stringify(datos),
    creado_en: ahora
  };

  doc.pdf_url = documentosGenerarPdf_(doc, datos);

  documentosHoja_().appendRow(DOC_COLUMNAS.map(function(columna) {
    return doc[columna] === undefined ? '' : doc[columna];
  }));

  return doc;
}

function documentosGenerarPdf_(doc, datos) {
  const carpetaId = String(configGet_('CARPETA_PDF_FACTURAS') || '').trim();

  if (!carpetaId) {
    throw new Error('Falta CARPETA_PDF_FACTURAS en MacroData.');
  }

  const horasTotales = (datos.lineas || []).reduce(function(suma, linea) {
    return suma + Number(linea.horas || 0);
  }, 0);

  const html = facturacionHtmlPdf_({
    titulo: DOC_TITULOS[doc.tipo],
    numero: doc.codigo,
    fechaEmision: documentosFecha_(doc.fecha_emision, 'dd/MM/yyyy'),
    desde: documentosFecha_(doc.periodo_desde, 'yyyy-MM-dd'),
    hasta: documentosFecha_(doc.periodo_hasta, 'yyyy-MM-dd'),
    empresa: doc.empresa,
    cliente: datos.cliente,
    emisor: datos.emisor,
    pago: datos.pago,
    lineas: datos.lineas,
    horasTotales: horasTotales,
    subtotal: doc.base,
    ivaPorcentaje: doc.iva_pct,
    ivaImporte: doc.iva_importe,
    irpfPorcentaje: doc.irpf_pct,
    irpfImporte: doc.irpf_importe,
    total: doc.total,
    moneda: datos.moneda,
    pie: datos.pie,
    nota: datos.nota,
    // En una factura los tipos impositivos se muestran siempre, aunque sean 0.
    mostrarImpuestos: doc.tipo !== 'PROFORMA'
  });

  const nombre = doc.codigo + '_' + String(doc.empresa || 'Cliente')
    .replace(/[^\w\-]+/g, '_')
    .substring(0, 40);

  const blob = Utilities
    .newBlob(html, 'text/html', nombre + '.html')
    .getAs(MimeType.PDF)
    .setName(nombre + '.pdf');

  const file = DriveApp.getFolderById(carpetaId).createFile(blob);

  file.setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW
  );

  return 'https://drive.google.com/file/d/' + file.getId() + '/view';
}

function documentosConBloqueo_(accion) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    return accion();
  } finally {
    lock.releaseLock();
  }
}

function documentosCrearProforma(datos) {
  datos = datos || {};

  const empresa = String(datos.empresa || '').trim();
  if (!empresa) throw new Error('Selecciona una empresa.');

  return documentosConBloqueo_(function() {
    const config = facturacionConfig_();
    const docs = documentosLeer_();
    const resumen = cobroObtenerResumenPendiente_({
      desde: datos.desde,
      hasta: datos.hasta,
      empresa: empresa
    }, false);

    const ocupadas = documentosPeticionesOcupadas_(docs);

    const lineas = resumen.lineas
      .filter(function(linea) {
        return !ocupadas[String(linea.id)];
      })
      .map(function(linea) {
        const horas = Number(linea.horas || 0);
        const esUnico = linea.tipo === 'UNICO';

        return {
          id: String(linea.id),
          fecha: linea.fecha,
          servicio: linea.peticion || 'Servicio',
          horas: esUnico ? 0 : horas,
          horasTexto: esUnico ? '-' : horas,
          tarifa: esUnico || horas <= 0 ? 0 : documentosRedondear_(Number(linea.importe) / horas),
          importe: documentosRedondear_(linea.importe)
        };
      })
      .sort(function(a, b) {
        const pa = a.fecha.split('/').reverse().join('');
        const pb = b.fecha.split('/').reverse().join('');
        return pa.localeCompare(pb);
      });

    if (!lineas.length) {
      throw new Error('No hay peticiones pendientes en ese periodo que no estén ya en una proforma o factura.');
    }

    const doc = documentosNuevo_(docs, config, 'PROFORMA', {
      empresa: resumen.empresa,
      desde: new Date(datos.desde + 'T00:00:00'),
      hasta: new Date(datos.hasta + 'T00:00:00'),
      lineas: lineas,
      nota: 'Documento informativo sin validez como factura. Servicios pendientes de confirmación.'
    });

    return documentosPublico_(doc);
  });
}

function documentosAnularProforma(id) {
  return documentosConBloqueo_(function() {
    const doc = documentosBuscar_(documentosLeer_(), id);

    if (doc.tipo !== 'PROFORMA' || doc.estado !== 'PENDIENTE') {
      throw new Error('Solo se puede anular una proforma pendiente.');
    }

    documentosEscribir_(doc, 'estado', 'ANULADA');
    return true;
  });
}

// La factura copia las líneas, el periodo y los tipos de la proforma sin
// recalcular nada. Los datos fiscales sí se toman al día, por si se
// completaron después de crear la proforma.
function documentosEmitirFactura(proformaId) {
  return documentosConBloqueo_(function() {
    const docs = documentosLeer_();
    const proforma = documentosBuscar_(docs, proformaId);

    if (proforma.tipo !== 'PROFORMA' || proforma.estado !== 'PENDIENTE') {
      throw new Error('Solo se puede facturar una proforma pendiente.');
    }

    const config = facturacionConfig_();
    const emisor = documentosEmisor_(config);
    const cliente = documentosCliente_(proforma.empresa);
    const faltan = [];

    if (!emisor.nombre) faltan.push('EMISOR_NOMBRE (MacroData)');
    if (!emisor.nif) faltan.push('EMISOR_NIF (MacroData)');
    if (!emisor.direccion) faltan.push('EMISOR_DIRECCION (MacroData)');
    if (!cliente.nif) faltan.push('nif del cliente (hoja Clientes)');
    if (!cliente.direccion) faltan.push('direccion_fiscal del cliente (hoja Clientes)');

    if (faltan.length) {
      throw new Error('Faltan datos obligatorios para emitir la factura: ' + faltan.join(', ') + '.');
    }

    const factura = documentosNuevo_(docs, config, 'FACTURA', {
      empresa: proforma.empresa,
      desde: proforma.periodo_desde,
      hasta: proforma.periodo_hasta,
      lineas: documentosDatos_(proforma).lineas || [],
      ivaPct: Number(proforma.iva_pct || 0),
      irpfPct: Number(proforma.irpf_pct || 0),
      origenId: proforma.id,
      emisor: emisor,
      cliente: cliente
    });

    documentosEscribir_(proforma, 'estado', 'FACTURADA');

    return documentosPublico_(factura);
  });
}

// Anula una factura emitida con una rectificativa por el importe total en
// negativo. La factura original se conserva y sus peticiones quedan libres.
function documentosRectificar(facturaId, motivo) {
  motivo = String(motivo || '').trim();
  if (!motivo) throw new Error('Indica el motivo de la rectificación.');

  return documentosConBloqueo_(function() {
    const docs = documentosLeer_();
    const factura = documentosBuscar_(docs, facturaId);

    if (factura.tipo !== 'FACTURA' || factura.estado !== 'EMITIDA') {
      throw new Error('Solo se puede rectificar una factura emitida y sin cobro registrado.');
    }

    const datos = documentosDatos_(factura);

    const lineas = (datos.lineas || []).map(function(linea) {
      return {
        id: linea.id,
        fecha: linea.fecha,
        servicio: linea.servicio,
        horas: -Number(linea.horas || 0),
        horasTexto: linea.horasTexto === '-' ? '-' : -Number(linea.horas || 0),
        tarifa: linea.tarifa,
        importe: -Number(linea.importe || 0)
      };
    });

    const rectificativa = documentosNuevo_(docs, facturacionConfig_(), 'RECTIFICATIVA', {
      empresa: factura.empresa,
      desde: factura.periodo_desde,
      hasta: factura.periodo_hasta,
      lineas: lineas,
      ivaPct: Number(factura.iva_pct || 0),
      irpfPct: Number(factura.irpf_pct || 0),
      origenId: factura.id,
      emisor: datos.emisor,
      cliente: datos.cliente,
      nota: 'Factura rectificativa de la factura ' + factura.codigo +
        ' de fecha ' + documentosFecha_(factura.fecha_emision, 'dd/MM/yyyy') +
        '. Motivo: ' + motivo
    });

    documentosEscribir_(factura, 'estado', 'RECTIFICADA');

    return documentosPublico_(rectificativa);
  });
}

// Registra el cobro de una factura: crea el pago y marca como cobradas las
// peticiones que incluye, igual que hace Cobrar periodo.
function documentosRegistrarCobro(facturaId) {
  return documentosConBloqueo_(function() {
    const factura = documentosBuscar_(documentosLeer_(), facturaId);

    if (factura.tipo !== 'FACTURA' || factura.estado !== 'EMITIDA') {
      throw new Error('Solo se puede registrar el cobro de una factura emitida.');
    }

    const ids = {};
    (documentosDatos_(factura).lineas || []).forEach(function(linea) {
      ids[String(linea.id)] = true;
    });

    const sh = ss_().getSheetByName(SHEETS.peticiones);
    const headers = peticionesHeaderMap_();
    const values = sh.getDataRange().getValues();
    const filas = [];

    for (let i = 1; i < values.length; i++) {
      if (!ids[String(values[i][0])]) continue;
      if (peticionesEsPagada_(values[i], headers)) continue;

      filas.push(i + 1);
    }

    const pagoId = pagosCrear({
      empresa: factura.empresa,
      fechaPago: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      periodoDesde: documentosFecha_(factura.periodo_desde, 'yyyy-MM-dd'),
      periodoHasta: documentosFecha_(factura.periodo_hasta, 'yyyy-MM-dd'),
      importe: Number(factura.base || 0),
      metodo: 'No indicado',
      concepto: 'Cobro factura ' + factura.codigo,
      observaciones: 'Registrado desde Facturas.'
    });

    peticionesMarcarPagadas_(filas, pagoId);

    documentosEscribir_(factura, 'estado', 'COBRADA');
    documentosEscribir_(factura, 'pago_id', pagoId);

    return true;
  });
}
