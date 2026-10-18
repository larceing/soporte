// Horas, cobros, proformas y facturas. Es la lógica del Gestor de peticiones
// (Apps Script) trasladada de Google Sheets a tablas ha_*.

const { consulta } = require('./db');
const { ErrorUsuario, diaLocal, selloLocal, esDia, diaCorto, redondear, texto, enSerie } = require('./util');

const CONFIG_DEFECTO = {
  TARIFA_HORA: '15',
  MONEDA: '€',
  HORAS_MINIMAS: '1',
  IVA: '0',
  IRPF: '0',
  EMISOR_NOMBRE: '',
  EMISOR_NIF: '',
  EMISOR_DIRECCION: '',
  EMISOR_EMAIL: '',
  EMISOR_TELEFONO: '',
  EMISOR_IBAN: '',
  PAGO_CONDICIONES: '',
  DOC_PIE: '',
  FACTURA_SERIE: 'F',
  PROFORMA_SERIE: 'PF',
  RECTIFICATIVA_SERIE: 'R',
  FACTURA_INICIO_ANIO: '',
  FACTURA_INICIO_NUMERO: '',
  FACTURA_MENCION: ''
};

/* Configuración */

async function config() {
  const filas = await consulta('SELECT clave, valor FROM ha_config');
  const mapa = { ...CONFIG_DEFECTO };
  filas.forEach(f => { mapa[f.clave] = f.valor; });
  return mapa;
}

async function configGuardar(datos) {
  for (const clave of Object.keys(CONFIG_DEFECTO)) {
    if (datos[clave] === undefined) continue;
    await consulta(
      'INSERT INTO ha_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
      [clave, texto(datos[clave], 2000)]
    );
  }
  return config();
}

/* Clientes */

async function clientes() {
  return consulta('SELECT * FROM ha_cliente WHERE activo = 1 ORDER BY nombre');
}

// Mientras solo haya un cliente, todo el trabajo es suyo.
async function clientePorDefecto() {
  const lista = await clientes();
  if (!lista.length) throw new ErrorUsuario('Da de alta un cliente en Ajustes antes de registrar trabajo.');
  return lista[0];
}

async function clientePorId(id) {
  if (!id) return clientePorDefecto();
  const filas = await consulta('SELECT * FROM ha_cliente WHERE id = ?', [Number(id)]);
  if (!filas.length) throw new ErrorUsuario('Cliente no encontrado.', 404);
  return filas[0];
}

async function clienteGuardar(datos) {
  const nombre = texto(datos.nombre, 120);
  if (!nombre) throw new ErrorUsuario('Indica el nombre del cliente.');

  const tarifa = datos.tarifa_hora === '' || datos.tarifa_hora == null ? null : Number(datos.tarifa_hora);
  const valores = [
    nombre, texto(datos.razon_social, 200), texto(datos.nif, 32), texto(datos.direccion, 1000),
    tarifa > 0 ? tarifa : null, texto(datos.telefono, 64), texto(datos.email, 200),
    texto(datos.contacto, 200), texto(datos.notas, 4000)
  ];

  if (datos.id) {
    await consulta(
      `UPDATE ha_cliente SET nombre = ?, razon_social = ?, nif = ?, direccion = ?, tarifa_hora = ?,
              telefono = ?, email = ?, contacto = ?, notas = ? WHERE id = ?`,
      [...valores, Number(datos.id)]
    );
  } else {
    await consulta(
      `INSERT INTO ha_cliente (nombre, razon_social, nif, direccion, tarifa_hora, telefono, email, contacto, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      valores
    );
  }
  return clientes();
}

/* Trabajos */

function horasFacturables(minutos, cfg) {
  const minimas = Number(cfg.HORAS_MINIMAS || 1);
  return Math.max(minimas, Math.ceil(Number(minutos || 0) / 60));
}

function tarifaDe(cliente, cfg) {
  return Number(cliente.tarifa_hora) > 0 ? Number(cliente.tarifa_hora) : Number(cfg.TARIFA_HORA || 0);
}

async function codigoLibre(prefijo, fecha) {
  const base = prefijo + '-' + selloLocal(fecha);
  for (let n = 0; ; n++) {
    const codigo = n ? base + '-' + n : base;
    const filas = await consulta(
      'SELECT 1 FROM ha_trabajo WHERE codigo = ? UNION SELECT 1 FROM ha_pago WHERE codigo = ?',
      [codigo, codigo]
    );
    if (!filas.length) return codigo;
  }
}

// Sesión de trabajo: cada una se redondea a horas enteras con el mínimo
// configurado, como hacía el gestor antiguo.
async function trabajoDeTiempo({ incidenciaId, notaId, concepto, detalle, minutos, fecha }) {
  const cfg = await config();
  const cliente = await clientePorDefecto();
  const horas = horasFacturables(minutos, cfg);
  const tarifa = tarifaDe(cliente, cfg);
  const momento = fecha || new Date();

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, incidencia_id, nota_id, concepto, detalle, dia,
                             minutos, horas, tarifa, importe, tipo, estado, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TIEMPO', 'CERRADA', UTC_TIMESTAMP())`,
    [await codigoLibre('SES', momento), cliente.id, incidenciaId, notaId || null, texto(concepto, 255),
      texto(detalle, 20000), diaLocal(momento), minutos, horas, tarifa, redondear(horas * tarifa)]
  );
}

async function gastoCrear(datos) {
  const concepto = texto(datos.concepto, 255);
  const importe = Number(String(datos.importe || '').replace(',', '.'));
  if (!concepto) throw new ErrorUsuario('Indica el concepto.');
  if (!importe || importe <= 0) throw new ErrorUsuario('Indica un importe mayor que cero.');

  const cliente = await clientePorId(datos.clienteId);
  const dia = esDia(datos.dia) ? datos.dia : diaLocal();

  await consulta(
    `INSERT INTO ha_trabajo (codigo, cliente_id, concepto, detalle, dia, importe, tipo, estado, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, 'UNICO', 'CERRADA', UTC_TIMESTAMP())`,
    [await codigoLibre('COB'), cliente.id, concepto, texto(datos.detalle, 20000), dia, redondear(importe)]
  );
}

async function trabajos(filtros) {
  const donde = [];
  const params = [];

  if (esDia(filtros.desde)) { donde.push('t.dia >= ?'); params.push(filtros.desde); }
  if (esDia(filtros.hasta)) { donde.push('t.dia <= ?'); params.push(filtros.hasta); }
  if (filtros.incidenciaId) { donde.push('t.incidencia_id = ?'); params.push(Number(filtros.incidenciaId)); }
  if (filtros.cobro === 'PENDIENTE') donde.push("t.pago_id IS NULL AND t.estado = 'CERRADA' AND t.sindri_en IS NULL");
  if (filtros.cobro === 'SINDRI') donde.push('t.sindri_en IS NOT NULL');
  if (filtros.cobro === 'COBRADO') donde.push('t.pago_id IS NOT NULL');
  if (filtros.cobro === 'NO_COBRAR') donde.push("t.estado = 'NO_COBRAR'");
  if (filtros.q) {
    donde.push('(t.concepto LIKE ? OR t.detalle LIKE ? OR t.codigo LIKE ?)');
    const patron = '%' + String(filtros.q).slice(0, 100) + '%';
    params.push(patron, patron, patron);
  }

  const filas = await consulta(
    `SELECT t.id, t.codigo, t.incidencia_id AS incidenciaId, t.concepto, t.detalle, t.dia, t.minutos,
            t.horas, t.tarifa, t.importe, t.tipo, t.estado, t.pago_id AS pagoId, c.nombre AS cliente,
            t.sindri_en AS sindriEn, t.sindri_estado AS sindriEstado, t.sindri_pedido AS sindriPedido
       FROM ha_trabajo t JOIN ha_cliente c ON c.id = t.cliente_id
      ${donde.length ? 'WHERE ' + donde.join(' AND ') : ''}
      ORDER BY t.dia DESC, t.id DESC`,
    params
  );

  const ocupados = await trabajosOcupados();
  return filas.map(f => ({ ...f, situacion: situacionDe(f, ocupados.get(Number(f.id))) }));
}

// En qué punto del cobro está un trabajo. Una vez en una factura o cobrado
// ya no se puede tocar.
function situacionDe(trabajo, doc) {
  if (trabajo.pagoId) return { clave: 'COBRADO', texto: 'Cobrado' + (doc ? ' · ' + doc.codigo : '') };
  if (trabajo.estado === 'NO_COBRAR') return { clave: 'NO_COBRAR', texto: 'No se cobra' };
  if (trabajo.sindriEn) return { clave: 'SINDRI', texto: textoSindri(trabajo) };
  if (doc && doc.tipo === 'PROFORMA') return { clave: 'PROFORMA', texto: 'En proforma ' + doc.codigo };
  if (doc) return { clave: 'FACTURADO', texto: 'Facturado ' + doc.codigo };
  return { clave: 'PENDIENTE', texto: 'Pendiente' };
}

// Lo mandado a Sindri se factura allí: aquí solo se ve en qué punto está.
function textoSindri(t) {
  if (t.sindriEstado === 'en_pedido') return 'En Sindri · pedido ' + (t.sindriPedido || '');
  if (t.sindriEstado === 'descartado') return 'Descartado en Sindri';
  return 'En Sindri · por facturar';
}

async function trabajoEstado(id, estado) {
  if (['CERRADA', 'NO_COBRAR'].indexOf(estado) === -1) throw new ErrorUsuario('Estado no válido.');

  const [trabajo] = await consulta('SELECT id, pago_id, sindri_en FROM ha_trabajo WHERE id = ?', [Number(id) || 0]);
  if (!trabajo) throw new ErrorUsuario('Trabajo no encontrado.', 404);
  if (trabajo.pago_id) throw new ErrorUsuario('No se puede cambiar un trabajo ya cobrado.', 409);
  if (trabajo.sindri_en) throw new ErrorUsuario('Está mandado a Sindri: retíralo antes desde Sesiones.', 409);

  const doc = (await trabajosOcupados()).get(trabajo.id);
  if (doc) throw new ErrorUsuario('No se puede cambiar: el trabajo está en ' + doc.codigo + '.', 409);

  await consulta('UPDATE ha_trabajo SET estado = ? WHERE id = ?', [estado, trabajo.id]);
}

/* Cobros */

function validarPeriodo(datos) {
  if (!esDia(datos.desde) || !esDia(datos.hasta)) throw new ErrorUsuario('Indica fecha desde y fecha hasta.');
  if (datos.hasta < datos.desde) throw new ErrorUsuario('La fecha hasta no puede ser anterior a la fecha desde.');
}

async function pendiente(datos) {
  validarPeriodo(datos);
  const cliente = await clientePorId(datos.clienteId);
  const cfg = await config();
  const ocupados = await trabajosOcupados();

  const filas = await consulta(
    `SELECT id, codigo, incidencia_id AS incidenciaId, concepto, detalle, dia, minutos, horas, tarifa, importe, tipo
       FROM ha_trabajo
      WHERE cliente_id = ? AND estado = 'CERRADA' AND pago_id IS NULL AND sindri_en IS NULL AND dia BETWEEN ? AND ?
      ORDER BY dia, id`,
    [cliente.id, datos.desde, datos.hasta]
  );
  const lineas = filas.map(f => ({ ...f, documento: (ocupados.get(Number(f.id)) || {}).codigo || '' }));

  return {
    desde: datos.desde,
    hasta: datos.hasta,
    cliente: { id: cliente.id, nombre: cliente.nombre },
    moneda: cfg.MONEDA,
    total: redondear(lineas.reduce((s, l) => s + Number(l.importe), 0)),
    horas: lineas.reduce((s, l) => s + Number(l.horas), 0),
    registros: lineas.length,
    lineas: lineas
  };
}

async function pagoCrear({ clienteId, fechaPago, desde, hasta, importe, metodo, concepto, observaciones }) {
  const codigo = await codigoLibre('PAG');
  const resultado = await consulta(
    `INSERT INTO ha_pago (codigo, cliente_id, fecha_pago, periodo_desde, periodo_hasta, importe,
                          metodo, concepto, observaciones, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [codigo, clienteId, fechaPago, desde, hasta, redondear(importe), texto(metodo, 64) || 'No indicado',
      texto(concepto, 255), texto(observaciones, 4000)]
  );
  return resultado.insertId;
}

async function cobrarPeriodo(datos) {
  return enSerie(async () => {
    const resumen = await pendiente(datos);
    if (!resumen.registros || resumen.total <= 0) {
      throw new ErrorUsuario('No hay registros pendientes de cobro en este periodo.');
    }

    // Lo que ya está en una proforma o factura se cobra desde ese documento,
    // para que no quede una factura emitida sin su cobro.
    const enDocumento = resumen.lineas.filter(l => l.documento);
    if (enDocumento.length) {
      throw new ErrorUsuario('Hay ' + enDocumento.length + ' trabajos de este periodo en ' +
        [...new Set(enDocumento.map(l => l.documento))].join(', ') +
        '. Registra el cobro desde la factura, o anula la proforma antes.', 409);
    }

    const pagoId = await pagoCrear({
      clienteId: resumen.cliente.id,
      fechaPago: diaLocal(),
      desde: resumen.desde,
      hasta: resumen.hasta,
      importe: resumen.total,
      metodo: datos.metodo,
      concepto: 'Cobro total periodo ' + resumen.desde + ' - ' + resumen.hasta,
      observaciones: 'Registros marcados como cobrados desde Cobros.'
    });

    await consulta('UPDATE ha_trabajo SET pago_id = ? WHERE id IN (?)', [pagoId, resumen.lineas.map(l => l.id)]);
    return pagoId;
  });
}

async function pagos() {
  return consulta(
    `SELECT p.id, p.codigo, p.fecha_pago AS fechaPago, p.periodo_desde AS desde, p.periodo_hasta AS hasta,
            p.importe, p.metodo, p.concepto, c.nombre AS cliente
       FROM ha_pago p JOIN ha_cliente c ON c.id = p.cliente_id
      ORDER BY p.fecha_pago DESC, p.id DESC`
  );
}

/* Documentos */

const TITULOS = {
  PROFORMA: 'Factura proforma', FACTURA: 'Factura', RECTIFICATIVA: 'Factura rectificativa',
  RESUMEN: 'Resumen de servicios'
};
const SERIES = { PROFORMA: 'PF', FACTURA: 'F', RECTIFICATIVA: 'R', RESUMEN: 'RS' };

function datosDe(doc) {
  try {
    return JSON.parse(doc.datos_json || '{}');
  } catch (e) {
    return {};
  }
}

function publico(doc) {
  return {
    ivaPct: Number(doc.iva_pct),
    ivaImporte: Number(doc.iva_importe),
    irpfPct: Number(doc.irpf_pct),
    irpfImporte: Number(doc.irpf_importe),
    origenId: doc.origen_id,
    pagoId: doc.pago_id,
    tienePdf: Boolean(doc.tiene_pdf),
    id: doc.id,
    tipo: doc.tipo,
    codigo: doc.codigo,
    fecha: doc.fecha_emision,
    cliente: doc.cliente_nombre,
    desde: doc.periodo_desde,
    hasta: doc.periodo_hasta,
    base: Number(doc.base),
    total: Number(doc.total),
    estado: doc.estado,
    servicios: (datosDe(doc).lineas || []).length
  };
}

const SQL_DOCUMENTO = `SELECT d.*, (SELECT 1 FROM ha_documento_pdf p WHERE p.documento_id = d.id) AS tiene_pdf
                         FROM ha_documento d`;

async function documentos() {
  return (await consulta(SQL_DOCUMENTO + ' ORDER BY d.fecha_emision DESC, d.id DESC')).map(publico);
}

async function documento(id) {
  const filas = await consulta(SQL_DOCUMENTO + ' WHERE d.id = ?', [Number(id) || 0]);
  if (!filas.length) throw new ErrorUsuario('No se encontró el documento.', 404);
  return filas[0];
}

// Todo lo necesario para revisar un documento en pantalla: sus líneas, sus
// totales, de dónde viene y qué salió de él.
async function documentoDetalle(id) {
  const doc = await documento(id);
  const datos = datosDe(doc);
  const relacionados = await consulta(
    `SELECT id, tipo, codigo, estado FROM ha_documento
      WHERE id = ? OR origen_id = ? ORDER BY id`,
    [doc.origen_id || 0, doc.id]
  );
  const [pago] = doc.pago_id
    ? await consulta('SELECT codigo, fecha_pago AS fechaPago, importe, metodo FROM ha_pago WHERE id = ?', [doc.pago_id])
    : [];

  return {
    ...publico(doc),
    titulo: TITULOS[doc.tipo] || doc.tipo,
    moneda: datos.moneda || '€',
    emisor: datos.emisor || {},
    clienteFiscal: datos.cliente || {},
    nota: datos.nota || '',
    nombrePdf: datos.nombrePdf || '',
    lineas: datos.lineas || [],
    relacionados: relacionados,
    pago: pago || null
  };
}

async function documentoPdf(id) {
  const [pdf] = await consulta('SELECT nombre, contenido FROM ha_documento_pdf WHERE documento_id = ?', [Number(id) || 0]);
  if (!pdf) throw new ErrorUsuario('Este documento no tiene PDF guardado.', 404);
  return pdf;
}

function emisorDe(cfg) {
  return {
    nombre: cfg.EMISOR_NOMBRE.trim(),
    nif: cfg.EMISOR_NIF.trim(),
    direccion: cfg.EMISOR_DIRECCION.trim(),
    email: cfg.EMISOR_EMAIL.trim(),
    telefono: cfg.EMISOR_TELEFONO.trim()
  };
}

function clienteFiscal(cliente) {
  return {
    empresa: cliente.nombre,
    razonSocial: cliente.razon_social,
    nif: cliente.nif,
    direccion: cliente.direccion,
    contacto: cliente.contacto,
    email: cliente.email
  };
}

// Trabajos que ya están en una proforma pendiente o en una factura en vigor.
async function trabajosOcupados() {
  const docs = await consulta(
    `SELECT codigo, tipo, datos_json FROM ha_documento
      WHERE (tipo = 'PROFORMA' AND estado = 'PENDIENTE')
         OR (tipo = 'FACTURA' AND estado IN ('EMITIDA', 'COBRADA'))`
  );
  const ocupados = new Map();
  docs.forEach(doc => (datosDe(doc).lineas || []).forEach(l => {
    ocupados.set(Number(l.id), { codigo: doc.codigo, tipo: doc.tipo });
  }));
  return ocupados;
}

// Numeración correlativa por tipo, serie y año. FACTURA_INICIO_ANIO y
// FACTURA_INICIO_NUMERO permiten continuar una numeración empezada fuera de
// la app, y solo actúan en el año indicado.
async function siguienteNumero(tipo, serie, anio, cfg) {
  const [{ maximo }] = await consulta(
    'SELECT COALESCE(MAX(numero), 0) AS maximo FROM ha_documento WHERE tipo = ? AND serie = ? AND anio = ?',
    [tipo, serie, anio]
  );

  let siguiente = Number(maximo) + 1;
  if (tipo === 'FACTURA' && Number(cfg.FACTURA_INICIO_ANIO) === anio) {
    siguiente = Math.max(siguiente, Number(cfg.FACTURA_INICIO_NUMERO) || 1);
  }
  return siguiente;
}

async function documentoNuevo(cfg, tipo, campos) {
  const hoy = diaLocal();
  const anio = Number(hoy.slice(0, 4));
  const serie = (cfg[tipo + '_SERIE'] || '').trim() || SERIES[tipo];
  const numero = await siguienteNumero(tipo, serie, anio, cfg);
  const codigo = serie + '-' + anio + '-' + String(numero).padStart(4, '0');

  const ivaPct = Number(campos.ivaPct === undefined ? cfg.IVA || 0 : campos.ivaPct);
  const irpfPct = Number(campos.irpfPct === undefined ? cfg.IRPF || 0 : campos.irpfPct);
  const base = redondear(campos.lineas.reduce((s, l) => s + Number(l.importe || 0), 0));
  const ivaImporte = redondear(base * ivaPct / 100);
  const irpfImporte = redondear(base * irpfPct / 100);

  const notas = [];
  if (campos.nota) notas.push(campos.nota);
  if (tipo !== 'PROFORMA' && cfg.FACTURA_MENCION.trim()) notas.push(cfg.FACTURA_MENCION.trim());

  const datos = {
    moneda: cfg.MONEDA || '€',
    emisor: campos.emisor || emisorDe(cfg),
    cliente: campos.clienteFiscal,
    pago: { iban: cfg.EMISOR_IBAN.trim(), condiciones: cfg.PAGO_CONDICIONES.trim() },
    pie: cfg.DOC_PIE.trim(),
    nota: notas.join('\n'),
    lineas: campos.lineas
  };

  const resultado = await consulta(
    `INSERT INTO ha_documento (tipo, codigo, serie, anio, numero, fecha_emision, cliente_id, cliente_nombre,
                               periodo_desde, periodo_hasta, base, iva_pct, iva_importe, irpf_pct, irpf_importe,
                               total, estado, origen_id, datos_json, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [tipo, codigo, serie, anio, numero, hoy, campos.clienteId, campos.clienteNombre, campos.desde, campos.hasta,
      base, ivaPct, ivaImporte, irpfPct, irpfImporte, redondear(base + ivaImporte - irpfImporte),
      { PROFORMA: 'PENDIENTE', RESUMEN: 'INFORMATIVO' }[tipo] || 'EMITIDA', campos.origenId || null,
      JSON.stringify(datos)]
  );

  return publico(await documento(resultado.insertId));
}

// Línea congelada de un documento a partir de un trabajo.
function lineaDe(l, conDetalle) {
  const horas = Number(l.horas || 0);
  const esUnico = l.tipo === 'UNICO';
  return {
    id: l.id,
    codigo: l.codigo,
    incidenciaId: l.incidenciaId || null,
    fecha: diaCorto(l.dia),
    servicio: l.concepto || 'Servicio',
    detalle: conDetalle ? String(l.detalle || '').trim() : '',
    minutos: Number(l.minutos || 0),
    horas: esUnico ? 0 : horas,
    horasTexto: esUnico ? '-' : horas,
    tarifa: esUnico || horas <= 0 ? 0 : redondear(Number(l.importe) / horas),
    importe: redondear(l.importe)
  };
}

function conDetalle(datos) {
  return datos.detalle === true || datos.detalle === 'true';
}

// Resumen de servicios: documento informativo, sin valor de factura, con todo
// el trabajo cerrado de un periodo, esté cobrado o no. No bloquea nada.
async function resumenCrear(datos) {
  validarPeriodo(datos);

  return enSerie(async () => {
    const cliente = await clientePorId(datos.clienteId);
    const filas = await consulta(
      `SELECT id, codigo, incidencia_id AS incidenciaId, concepto, detalle, dia, minutos, horas, tarifa, importe, tipo
         FROM ha_trabajo
        WHERE cliente_id = ? AND estado = 'CERRADA' AND dia BETWEEN ? AND ?
        ORDER BY dia, id`,
      [cliente.id, datos.desde, datos.hasta]
    );
    if (!filas.length) throw new ErrorUsuario('No hay trabajos cerrados en ese periodo.');

    return documentoNuevo(await config(), 'RESUMEN', {
      clienteId: cliente.id,
      clienteNombre: cliente.nombre,
      clienteFiscal: clienteFiscal(cliente),
      desde: datos.desde,
      hasta: datos.hasta,
      lineas: filas.map(l => lineaDe(l, conDetalle(datos)))
    });
  });
}

async function proformaCrear(datos) {
  return enSerie(async () => {
    const resumen = await pendiente(datos);
    const cliente = await clientePorId(resumen.cliente.id);

    const lineas = resumen.lineas
      .filter(l => !l.documento)
      .map(l => lineaDe(l, conDetalle(datos)));

    if (!lineas.length) {
      throw new ErrorUsuario('No hay trabajos pendientes en ese periodo que no estén ya en una proforma o factura.');
    }

    return documentoNuevo(await config(), 'PROFORMA', {
      clienteId: cliente.id,
      clienteNombre: cliente.nombre,
      clienteFiscal: clienteFiscal(cliente),
      desde: datos.desde,
      hasta: datos.hasta,
      lineas: lineas,
      nota: 'Documento informativo sin validez como factura. Servicios pendientes de confirmación.'
    });
  });
}

async function proformaAnular(id) {
  return enSerie(async () => {
    const doc = await documento(id);
    if (doc.tipo !== 'PROFORMA' || doc.estado !== 'PENDIENTE') {
      throw new ErrorUsuario('Solo se puede anular una proforma pendiente.');
    }
    await consulta("UPDATE ha_documento SET estado = 'ANULADA' WHERE id = ?", [doc.id]);
    return publico(await documento(doc.id));
  });
}

// La factura copia las líneas, el periodo y los tipos de la proforma sin
// recalcular nada. Los datos fiscales sí se toman al día, por si se
// completaron después de crear la proforma.
async function facturaEmitir(proformaId) {
  return enSerie(async () => {
    const proforma = await documento(proformaId);
    if (proforma.tipo !== 'PROFORMA' || proforma.estado !== 'PENDIENTE') {
      throw new ErrorUsuario('Solo se puede facturar una proforma pendiente.');
    }

    const cfg = await config();
    const emisor = emisorDe(cfg);
    const cliente = await clientePorId(proforma.cliente_id);
    const faltan = [];

    if (!emisor.nombre) faltan.push('nombre del emisor');
    if (!emisor.nif) faltan.push('NIF del emisor');
    if (!emisor.direccion) faltan.push('dirección del emisor');
    if (!cliente.nif) faltan.push('NIF del cliente');
    if (!cliente.direccion) faltan.push('dirección fiscal del cliente');

    if (faltan.length) {
      throw new ErrorUsuario('Faltan datos obligatorios para emitir la factura (complétalos en Ajustes): ' + faltan.join(', ') + '.');
    }

    const factura = await documentoNuevo(cfg, 'FACTURA', {
      clienteId: cliente.id,
      clienteNombre: cliente.nombre,
      clienteFiscal: clienteFiscal(cliente),
      desde: proforma.periodo_desde,
      hasta: proforma.periodo_hasta,
      lineas: datosDe(proforma).lineas || [],
      ivaPct: Number(proforma.iva_pct),
      irpfPct: Number(proforma.irpf_pct),
      origenId: proforma.id,
      emisor: emisor
    });

    await consulta("UPDATE ha_documento SET estado = 'FACTURADA' WHERE id = ?", [proforma.id]);
    return factura;
  });
}

// Anula una factura emitida con una rectificativa por el importe total en
// negativo. La factura original se conserva y sus trabajos quedan libres.
async function facturaRectificar(facturaId, motivo) {
  motivo = texto(motivo, 1000);
  if (!motivo) throw new ErrorUsuario('Indica el motivo de la rectificación.');

  return enSerie(async () => {
    const factura = await documento(facturaId);
    if (factura.tipo !== 'FACTURA' || factura.estado !== 'EMITIDA') {
      throw new ErrorUsuario('Solo se puede rectificar una factura emitida y sin cobro registrado.');
    }

    const datos = datosDe(factura);
    const lineas = (datos.lineas || []).map(l => ({
      ...l,
      horas: -Number(l.horas || 0),
      horasTexto: l.horasTexto === '-' ? '-' : -Number(l.horas || 0),
      minutos: -Number(l.minutos || 0),
      importe: -Number(l.importe || 0)
    }));

    const rectificativa = await documentoNuevo(await config(), 'RECTIFICATIVA', {
      clienteId: factura.cliente_id,
      clienteNombre: factura.cliente_nombre,
      clienteFiscal: datos.cliente,
      desde: factura.periodo_desde,
      hasta: factura.periodo_hasta,
      lineas: lineas,
      ivaPct: Number(factura.iva_pct),
      irpfPct: Number(factura.irpf_pct),
      origenId: factura.id,
      emisor: datos.emisor,
      nota: 'Factura rectificativa de la factura ' + factura.codigo + ' de fecha ' +
        diaCorto(factura.fecha_emision) + '. Motivo: ' + motivo
    });

    await consulta("UPDATE ha_documento SET estado = 'RECTIFICADA' WHERE id = ?", [factura.id]);
    return rectificativa;
  });
}

// Registra el cobro de una factura: crea el pago y marca como cobrados los
// trabajos que incluye.
async function facturaCobrar(facturaId) {
  return enSerie(async () => {
    const factura = await documento(facturaId);
    if (factura.tipo !== 'FACTURA' || factura.estado !== 'EMITIDA') {
      throw new ErrorUsuario('Solo se puede registrar el cobro de una factura emitida.');
    }

    const ids = (datosDe(factura).lineas || []).map(l => Number(l.id));
    const pagoId = await pagoCrear({
      clienteId: factura.cliente_id,
      fechaPago: diaLocal(),
      desde: factura.periodo_desde,
      hasta: factura.periodo_hasta,
      importe: Number(factura.base),
      concepto: 'Cobro factura ' + factura.codigo,
      observaciones: 'Registrado desde Facturas.'
    });

    if (ids.length) {
      await consulta('UPDATE ha_trabajo SET pago_id = ? WHERE id IN (?) AND pago_id IS NULL', [pagoId, ids]);
    }
    await consulta("UPDATE ha_documento SET estado = 'COBRADA', pago_id = ? WHERE id = ?", [pagoId, factura.id]);
    return publico(await documento(factura.id));
  });
}

module.exports = {
  TITULOS, datosDe,
  config, configGuardar,
  clientes, clientePorId, clienteGuardar, trabajosOcupados,
  trabajoDeTiempo, gastoCrear, trabajos, trabajoEstado,
  pendiente, cobrarPeriodo, pagos,
  documentos, documento, documentoDetalle, documentoPdf, resumenCrear, proformaCrear, proformaAnular, facturaEmitir, facturaRectificar, facturaCobrar
};
