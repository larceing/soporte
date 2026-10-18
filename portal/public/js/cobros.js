/* Cobros, sesiones, documentos y ajustes. Usa api(), esc(), coreMensaje() y coreConfirmar() de app.js. */

let cobroMoneda = '€';
let accionPendiente = null;
let documentosTodos = [];
let sesionesTodas = [];

const docFiltros = { tipo: '', estado: '', anio: '', q: '' };
const sesFiltros = { cobro: '', desde: '', hasta: '', q: '' };

function fmtDinero(valor) {
  return Number(valor || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + cobroMoneda;
}

function fmtDia(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dia || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
}

function hoyIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function badgeSituacion(situacion) {
  const clase = { COBRADO: 'badge-ok', FACTURADO: 'badge-run', PROFORMA: 'badge-pend', PENDIENTE: 'badge-pend', NO_COBRAR: 'badge-neutral' }[situacion.clave];
  return '<span class="badge ' + (clase || 'badge-neutral') + '">' + esc(situacion.texto) + '</span>';
}

// Las cuatro pantallas de Cobros comparten las mismas pestañas.
function cobrosPintarPestanas() {
  const pestanas = [['cobros', 'Pendiente'], ['sesiones', 'Sesiones'], ['pagos', 'Cobrado'], ['documentos', 'Documentos']];
  document.querySelectorAll('.cobros-seg').forEach(function(caja) {
    caja.innerHTML = pestanas.map(function(p) {
      return '<button type="button" data-nav="' + p[0] + (p[0] === 'documentos' ? ' documento' : '') +
        '" onclick="coreMostrarVista(\'' + p[0] + '\')">' + p[1] + '</button>';
    }).join('');
  });
}

/* Pendiente */

async function cobrosPreparar() {
  const desde = document.getElementById('cobroDesde');
  const hasta = document.getElementById('cobroHasta');

  if (!hasta.value) hasta.value = hoyIso();
  if (!document.getElementById('gastoDia').value) document.getElementById('gastoDia').value = hoyIso();

  // Por defecto, desde el trabajo pendiente más antiguo.
  if (!desde.value) {
    const pendientes = await api('GET', '/trabajos?cobro=PENDIENTE');
    desde.value = pendientes.length ? pendientes[pendientes.length - 1].dia : hoyIso();
  }

  await cobroCalcular();
}

function cobroPeriodo() {
  return {
    desde: document.getElementById('cobroDesde').value,
    hasta: document.getElementById('cobroHasta').value,
    detalle: document.getElementById('cobroDetalle').checked
  };
}

async function cobroCalcular() {
  coreMensaje('mensajeCobro', '');
  const caja = document.getElementById('cobroResultado');
  const p = cobroPeriodo();

  try {
    const r = await api('GET', '/cobros/pendiente?desde=' + encodeURIComponent(p.desde) + '&hasta=' + encodeURIComponent(p.hasta));
    cobroMoneda = r.moneda || '€';

    const libres = r.lineas.filter(function(l) { return !l.documento; });
    const filas = r.lineas.map(function(l) {
      const concepto = l.incidenciaId
        ? '<button type="button" class="link-btn link-fila" onclick="detalleTab=\'sesiones\'; detalleAbrir(' + l.incidenciaId + ')">' + esc(l.concepto) + '</button>'
        : esc(l.concepto);
      return '<tr>' +
        '<td>' + fmtDia(l.dia) + '</td>' +
        '<td>' + concepto + (l.documento ? ' <span class="badge badge-pend">En ' + esc(l.documento) + '</span>' : '') + '</td>' +
        '<td>' + (l.tipo === 'UNICO' ? '–' : fmtDuracion(l.minutos)) + '</td>' +
        '<td>' + (l.tipo === 'UNICO' ? '–' : esc(l.horas) + ' h') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + fmtDinero(l.importe) + '</td>' +
      '</tr>';
    }).join('');

    caja.innerHTML =
      '<div class="cobro-line">Pendiente de cobro · ' + esc(r.cliente.nombre) + ' · ' + fmtDia(r.desde) + ' – ' + fmtDia(r.hasta) + '</div>' +
      '<div class="cobro-total">' + fmtDinero(r.total) + '</div>' +
      '<div class="cobro-summary">' +
        '<div><span>Registros</span><strong>' + r.registros + '</strong></div>' +
        '<div><span>Horas facturables</span><strong>' + r.horas + ' h</strong></div>' +
      '</div>' +
      '<div class="det-actions">' +
        (libres.length ? '<button type="button" class="btn btn-primary" onclick="accionAbrir(\'proforma\')">Crear proforma</button>' : '') +
        '<button type="button" class="btn btn-secondary" onclick="accionAbrir(\'resumen\')">Resumen de servicios</button>' +
        (libres.length && libres.length === r.lineas.length
          ? '<button type="button" class="btn btn-secondary" onclick="accionAbrir(\'cobrarPeriodo\')">Marcar todo como cobrado</button>' : '') +
      '</div>' +
      (r.registros
        ? '<div class="cobro-tabla-wrap"><table class="cobro-tabla">' +
            '<thead><tr><th>Fecha</th><th>Concepto</th><th>Tiempo real</th><th>Facturable</th><th style="text-align:right">Importe</th></tr></thead>' +
            '<tbody>' + filas + '</tbody>' +
          '</table></div>'
        : '<div class="empty">No hay nada pendiente en este periodo.</div>');

    caja.classList.remove('hidden');
  } catch (err) {
    caja.classList.add('hidden');
    coreMensaje('mensajeCobro', err.message, 'error');
  }
}

async function gastoGuardar() {
  try {
    await api('POST', '/trabajos/gasto', {
      concepto: document.getElementById('gastoConcepto').value,
      importe: document.getElementById('gastoImporte').value,
      dia: document.getElementById('gastoDia').value,
      detalle: document.getElementById('gastoDetalle').value
    });

    ['gastoConcepto', 'gastoImporte', 'gastoDetalle'].forEach(function(id) { document.getElementById(id).value = ''; });
    coreMensaje('mensajeGasto', 'Gasto guardado.', 'ok');
    await cobroCalcular();
  } catch (err) {
    coreMensaje('mensajeGasto', err.message, 'error');
  }
}

/* Sesiones */

async function sesionesCargar() {
  sesFiltros.desde = document.getElementById('sesDesde').value;
  sesFiltros.hasta = document.getElementById('sesHasta').value;
  sesFiltros.q = document.getElementById('sesBuscar').value.trim();

  const partes = [];
  ['cobro', 'desde', 'hasta', 'q'].forEach(function(clave) {
    if (sesFiltros[clave]) partes.push(clave + '=' + encodeURIComponent(sesFiltros[clave]));
  });

  sesionesTodas = await api('GET', '/trabajos' + (partes.length ? '?' + partes.join('&') : ''));
  sesionesPintar();
}

function sesionesFiltrar(cobro) {
  sesFiltros.cobro = cobro;
  sesionesCargar().catch(coreError);
}

function sesionesLimpiar() {
  ['sesDesde', 'sesHasta', 'sesBuscar'].forEach(function(id) { document.getElementById(id).value = ''; });
  sesionesFiltrar('');
}

function sesionesPintar() {
  document.querySelectorAll('[data-ses]').forEach(function(chip) {
    chip.classList.toggle('is-active', chip.dataset.ses === sesFiltros.cobro);
  });

  const lista = sesionesTodas;
  const importe = lista.reduce(function(s, t) { return s + (t.estado === 'NO_COBRAR' ? 0 : Number(t.importe)); }, 0);
  const minutos = lista.reduce(function(s, t) { return s + Number(t.minutos); }, 0);
  const horas = lista.reduce(function(s, t) { return s + Number(t.horas); }, 0);

  document.getElementById('sesResumen').innerHTML =
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Registros</div><div class="stat-value">' + lista.length + '</div></div>' +
      '<div class="stat"><div class="stat-label">Tiempo real / facturable</div><div class="stat-value">' + Math.round(minutos / 6) / 10 + ' / ' + horas + ' h</div></div>' +
      '<div class="stat"><div class="stat-label">Importe</div><div class="stat-value">' + fmtDinero(importe) + '</div></div>' +
    '</div>';

  if (!lista.length) {
    document.getElementById('sesLista').innerHTML = '<div class="empty">No hay sesiones con estos filtros.</div>';
    return;
  }

  document.getElementById('sesLista').innerHTML = '<div class="pet-list">' + lista.map(function(t) {
    const libre = t.situacion.clave === 'PENDIENTE' || t.situacion.clave === 'NO_COBRAR';
    const acciones = [];
    if (t.incidenciaId) {
      acciones.push('<button type="button" class="btn btn-secondary btn-sm" onclick="detalleTab=\'sesiones\'; detalleAbrir(' + t.incidenciaId + ')">Ver incidencia</button>');
    }
    if (libre) {
      acciones.push('<button type="button" class="btn btn-secondary btn-sm" onclick="sesionEstado(' + t.id + ', \'' +
        (t.estado === 'NO_COBRAR' ? 'CERRADA' : 'NO_COBRAR') + '\')">' + (t.estado === 'NO_COBRAR' ? 'Volver a cobrar' : 'No cobrar') + '</button>');
    }

    return '<div class="doc' + (t.estado === 'NO_COBRAR' ? ' doc-off' : '') + '">' +
      '<div class="doc-head">' +
        '<span class="doc-code">' + fmtDia(t.dia) + '</span>' +
        badgeSituacion(t.situacion) +
        '<span class="doc-total">' + fmtDinero(t.importe) + '</span>' +
      '</div>' +
      '<div class="doc-title">' + esc(t.concepto) + '</div>' +
      '<div class="doc-sub">' + esc(t.codigo) + ' · ' +
        (t.tipo === 'UNICO' ? 'Gasto suelto' : fmtDuracion(t.minutos) + ' reales · ' + esc(t.horas) + ' h a ' + fmtDinero(t.tarifa)) + '</div>' +
      (acciones.length ? '<div class="doc-actions">' + acciones.join('') + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}

async function sesionEstado(id, estado) {
  try {
    await api('POST', '/trabajos/' + id + '/estado', { estado: estado });
    await sesionesCargar();
  } catch (err) {
    coreError(err);
  }
}

/* Cobrado */

async function pagosCargar() {
  const caja = document.getElementById('pagosListado');
  const lista = await api('GET', '/pagos');

  if (!lista.length) {
    caja.innerHTML = '<div class="empty">Todavía no hay cobros registrados.</div>';
    return;
  }

  const total = lista.reduce(function(s, p) { return s + Number(p.importe); }, 0);

  caja.innerHTML =
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Cobros</div><div class="stat-value">' + lista.length + '</div></div>' +
      '<div class="stat"><div class="stat-label">Total cobrado</div><div class="stat-value">' + fmtDinero(total) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Último cobro</div><div class="stat-value">' + fmtDia(lista[0].fechaPago) + '</div></div>' +
    '</div>' +
    '<div class="pet-list">' + lista.map(function(p) {
      return '<div class="doc">' +
        '<div class="doc-head">' +
          '<span class="doc-code">' + esc(p.codigo) + '</span>' +
          '<span class="badge badge-ok">Cobrado el ' + fmtDia(p.fechaPago) + '</span>' +
          '<span class="doc-total">' + fmtDinero(p.importe) + '</span>' +
        '</div>' +
        '<div class="doc-sub">' + esc(p.cliente) + ' · periodo ' + fmtDia(p.desde) + ' – ' + fmtDia(p.hasta) +
          ' · ' + esc(p.concepto) + (p.metodo && p.metodo !== 'No indicado' ? ' · ' + esc(p.metodo) : '') + '</div>' +
      '</div>';
    }).join('') + '</div>';
}

/* Documentos */

const DOC_TIPOS = { PROFORMA: 'Proforma', FACTURA: 'Factura', RECTIFICATIVA: 'Rectificativa', RESUMEN: 'Resumen' };

const DOC_ESTADOS = {
  PENDIENTE: { texto: 'Pendiente de confirmar', clase: 'badge-pend' },
  FACTURADA: { texto: 'Facturada', clase: 'badge-neutral' },
  ANULADA: { texto: 'Anulada', clase: 'badge-neutral' },
  EMITIDA: { texto: 'Emitida', clase: 'badge-run' },
  COBRADA: { texto: 'Cobrada', clase: 'badge-ok' },
  RECTIFICADA: { texto: 'Rectificada', clase: 'badge-neutral' },
  INFORMATIVO: { texto: 'Informativo', clase: 'badge-neutral' },
  HISTORICO: { texto: 'PDF original', clase: 'badge-neutral' }
};

// Textos del diálogo de confirmación por acción.
const ACCIONES = {
  proforma: {
    titulo: 'Crear proforma',
    texto: 'Se creará una proforma con todo lo pendiente del periodo que no esté ya en otra proforma o factura.',
    boton: 'Crear proforma',
    hecho: 'Proforma creada: '
  },
  resumen: {
    titulo: 'Resumen de servicios',
    texto: 'Se creará un documento informativo con todo el trabajo del periodo, esté cobrado o no. No es una factura y no bloquea nada.',
    boton: 'Crear resumen',
    hecho: 'Resumen creado: '
  },
  cobrarPeriodo: {
    titulo: 'Marcar como cobrado',
    texto: 'Se registrará un cobro por el total pendiente del periodo, sin factura, y esos trabajos quedarán como cobrados. No se puede deshacer.',
    boton: 'Registrar cobro',
    hecho: 'Cobro registrado.'
  },
  facturar: {
    titulo: 'Emitir factura',
    texto: 'Se asignará el siguiente número de factura a {codigo}. Una factura emitida no se puede editar ni borrar; solo se corrige con una rectificativa.',
    boton: 'Emitir factura',
    hecho: 'Factura emitida: '
  },
  anular: {
    titulo: 'Anular proforma',
    texto: 'La proforma {codigo} quedará anulada y sus trabajos volverán a estar disponibles.',
    boton: 'Anular proforma',
    hecho: 'Proforma anulada.'
  },
  cobrar: {
    titulo: 'Registrar cobro',
    texto: 'Se registrará el cobro de {codigo} y sus trabajos quedarán marcados como cobrados. No se puede deshacer.',
    boton: 'Registrar cobro',
    hecho: 'Cobro registrado.'
  },
  rectificar: {
    titulo: 'Rectificar factura',
    texto: 'Se emitirá una factura rectificativa que anula {codigo} por su importe total. Sus trabajos volverán a estar disponibles.',
    boton: 'Emitir rectificativa',
    hecho: 'Rectificativa emitida: '
  }
};

async function documentosCargar() {
  documentosTodos = await api('GET', '/documentos');

  const anios = [];
  documentosTodos.forEach(function(d) {
    const a = String(d.fecha).slice(0, 4);
    if (anios.indexOf(a) === -1) anios.push(a);
  });
  const selector = document.getElementById('docAnio');
  selector.innerHTML = '<option value="">Todos los años</option>' + anios.map(function(a) {
    return '<option' + (a === docFiltros.anio ? ' selected' : '') + '>' + a + '</option>';
  }).join('');

  documentosPintar();
}

function documentosFiltrar(tipo) {
  docFiltros.tipo = tipo;
  documentosPintar();
}

function documentosLeerFiltros() {
  docFiltros.estado = document.getElementById('docEstado').value;
  docFiltros.anio = document.getElementById('docAnio').value;
  docFiltros.q = document.getElementById('docBuscar').value.trim().toLowerCase();
  documentosPintar();
}

function documentosPintar() {
  document.querySelectorAll('[data-doc-tipo]').forEach(function(chip) {
    chip.classList.toggle('is-active', chip.dataset.docTipo === docFiltros.tipo);
  });

  const lista = documentosTodos.filter(function(d) {
    if (docFiltros.tipo && d.tipo !== docFiltros.tipo) return false;
    if (docFiltros.estado && d.estado !== docFiltros.estado) return false;
    if (docFiltros.anio && String(d.fecha).slice(0, 4) !== docFiltros.anio) return false;
    if (docFiltros.q && (d.codigo + ' ' + d.cliente).toLowerCase().indexOf(docFiltros.q) === -1) return false;
    return true;
  });

  // Solo las facturas en vigor cuentan como facturado.
  const enVigor = documentosTodos.filter(function(d) { return d.tipo === 'FACTURA' && (d.estado === 'EMITIDA' || d.estado === 'COBRADA'); });
  const suma = function(docs) { return docs.reduce(function(s, d) { return s + d.total; }, 0); };

  document.getElementById('docResumen').innerHTML =
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Facturado</div><div class="stat-value">' + fmtDinero(suma(enVigor)) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Facturas sin cobrar</div><div class="stat-value">' +
        fmtDinero(suma(enVigor.filter(function(d) { return d.estado === 'EMITIDA'; }))) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Proformas pendientes</div><div class="stat-value">' +
        documentosTodos.filter(function(d) { return d.tipo === 'PROFORMA' && d.estado === 'PENDIENTE'; }).length + '</div></div>' +
    '</div>';

  document.getElementById('documentosListado').innerHTML = lista.length
    ? '<div class="pet-list">' + lista.map(documentoHtml).join('') + '</div>'
    : '<div class="empty">' + (documentosTodos.length ? 'No hay documentos con estos filtros.' : 'Todavía no hay documentos.') + '</div>';
}

function documentoAcciones(doc) {
  const codigo = esc(doc.codigo);
  const boton = function(clase, accion, textoBoton) {
    return '<button type="button" class="btn ' + clase + ' btn-sm" onclick="accionAbrir(\'' + accion + '\', ' +
      doc.id + ', \'' + codigo + '\')">' + textoBoton + '</button>';
  };

  const acciones = ['<a class="btn btn-secondary btn-sm" href="api/documentos/' + doc.id + '/imprimir" target="_blank" rel="noopener">' +
    (doc.estado === 'HISTORICO' ? 'Abrir PDF original' : 'Ver / PDF') + '</a>'];

  if (doc.estado !== 'ANULADA') {
    acciones.push('<button type="button" class="btn btn-secondary btn-sm" onclick="correoAbrirDocumento(' + doc.id +
      ').catch(coreError)">Enviar por correo</button>');
  }

  if (doc.tipo === 'PROFORMA' && doc.estado === 'PENDIENTE') {
    acciones.push(boton('btn-primary', 'facturar', 'Emitir factura'));
    acciones.push(boton('btn-secondary', 'anular', 'Anular'));
  }
  if (doc.tipo === 'FACTURA' && doc.estado === 'EMITIDA') {
    acciones.push(boton('btn-primary', 'cobrar', 'Registrar cobro'));
    acciones.push(boton('btn-danger', 'rectificar', 'Rectificar'));
  }
  return acciones;
}

function documentoHtml(doc) {
  const estado = DOC_ESTADOS[doc.estado] || { texto: doc.estado, clase: 'badge-neutral' };

  return '<div class="doc">' +
    '<div class="doc-head">' +
      '<button type="button" class="doc-code link-btn" onclick="documentoAbrir(' + doc.id + ')">' + esc(doc.codigo) + '</button>' +
      '<span class="badge ' + estado.clase + '">' + esc((DOC_TIPOS[doc.tipo] || doc.tipo) + ' · ' + estado.texto) + '</span>' +
      '<span class="doc-total">' + fmtDinero(doc.estado === 'HISTORICO' ? doc.base : doc.total) + '</span>' +
    '</div>' +
    '<div class="doc-sub">' + esc(doc.cliente) + ' · emitido el ' + fmtDia(doc.fecha) +
      ' · periodo ' + fmtDia(doc.desde) + ' – ' + fmtDia(doc.hasta) +
      (doc.estado === 'HISTORICO' ? ' · base imponible' : ' · ' + doc.servicios + (doc.servicios === 1 ? ' servicio' : ' servicios') + ' · base ' + fmtDinero(doc.base)) + '</div>' +
    '<div class="doc-actions">' +
      '<button type="button" class="btn btn-secondary btn-sm" onclick="documentoAbrir(' + doc.id + ')">Revisar</button>' +
      documentoAcciones(doc).join('') +
    '</div>' +
  '</div>';
}

// Revisión de un documento: partes, líneas, totales y documentos relacionados.
async function documentoAbrir(id) {
  coreMostrarVista('documento');
  const caja = document.getElementById('documentoContenido');
  caja.innerHTML = '<div class="empty">Cargando...</div>';

  try {
    const doc = await api('GET', '/documentos/' + id);
    cobroMoneda = doc.moneda || cobroMoneda;
    const estado = DOC_ESTADOS[doc.estado] || { texto: doc.estado, clase: 'badge-neutral' };
    const historico = doc.estado === 'HISTORICO';

    const parte = function(titulo, p, nombre) {
      return '<div><span>' + titulo + '</span><strong>' + esc(nombre || '—') + '</strong>' +
        (p.nif ? '<div class="doc-sub">NIF ' + esc(p.nif) + '</div>' : '') +
        (p.direccion ? '<div class="doc-sub" style="white-space:pre-line">' + esc(p.direccion) + '</div>' : '') + '</div>';
    };

    const filas = doc.lineas.map(function(l) {
      const servicio = l.incidenciaId
        ? '<button type="button" class="link-btn link-fila" onclick="detalleTab=\'sesiones\'; detalleAbrir(' + l.incidenciaId + ')">' + esc(l.servicio) + '</button>'
        : esc(l.servicio);
      return '<tr>' +
        '<td>' + esc(l.fecha) + '</td>' +
        '<td>' + servicio + (l.codigo ? '<div class="doc-sub">' + esc(l.codigo) + '</div>' : '') +
          (l.detalle ? '<div class="doc-sub" style="white-space:pre-line">' + esc(l.detalle) + '</div>' : '') + '</td>' +
        '<td>' + (l.horasTexto === '-' ? '–' : (l.minutos ? fmtDuracion(l.minutos) : '—')) + '</td>' +
        '<td>' + (l.horasTexto === '-' ? '–' : esc(l.horasTexto) + ' h') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + fmtDinero(l.importe) + '</td>' +
      '</tr>';
    }).join('');

    const relacionados = doc.relacionados.map(function(r) {
      return '<button type="button" class="btn btn-secondary btn-sm" onclick="documentoAbrir(' + r.id + ')">' +
        esc((DOC_TIPOS[r.tipo] || r.tipo) + ' ' + r.codigo) + '</button>';
    }).join('');

    caja.innerHTML =
      '<header class="view-head">' +
        '<div class="det-head">' +
          '<button type="button" class="link-btn" onclick="coreMostrarVista(\'documentos\')">← Documentos</button>' +
          '<span class="badge ' + estado.clase + '">' + esc(estado.texto) + '</span>' +
        '</div>' +
        '<h2>' + esc(doc.titulo + ' ' + doc.codigo) + '</h2>' +
        '<p>' + esc(doc.cliente) + ' · emitido el ' + fmtDia(doc.fecha) + ' · periodo ' + fmtDia(doc.desde) + ' – ' + fmtDia(doc.hasta) + '</p>' +
      '</header>' +

      '<div class="det-actions">' + documentoAcciones(doc).join('') + '</div>' +
      '<div id="mensajeDocumento" class="message hidden"></div>' +

      (historico
        ? '<div class="panel"><p class="det-desc">Documento emitido con el Gestor de peticiones antes de existir esta aplicación. ' +
            'Se conserva el PDF original (' + esc(doc.nombrePdf) + '); los impuestos y el total exacto son los del PDF.</p>' +
            '<div class="cobro-summary" style="margin-top:14px"><div><span>Base imponible</span><strong>' + fmtDinero(doc.base) + '</strong></div></div></div>'
        : '<div class="panel"><div class="cobro-summary">' +
            parte('De', doc.emisor, doc.emisor.nombre) +
            parte('Para', doc.clienteFiscal, doc.clienteFiscal.razonSocial || doc.clienteFiscal.empresa || doc.cliente) +
          '</div></div>' +

          '<div class="panel"><h3>Servicios (' + doc.lineas.length + ')</h3>' +
            '<div class="cobro-tabla-wrap"><table class="cobro-tabla">' +
              '<thead><tr><th>Fecha</th><th>Servicio</th><th>Tiempo real</th><th>Facturable</th><th style="text-align:right">Importe</th></tr></thead>' +
              '<tbody>' + filas + '</tbody>' +
            '</table></div>' +
            '<div class="fact-total-box">' +
              '<div>Base imponible: ' + fmtDinero(doc.base) + '</div>' +
              (doc.ivaPct || doc.tipo === 'FACTURA' || doc.tipo === 'RECTIFICATIVA' ? '<div>IVA ' + doc.ivaPct + ' %: ' + fmtDinero(doc.ivaImporte) + '</div>' : '') +
              (doc.irpfPct ? '<div>Retención IRPF ' + doc.irpfPct + ' %: − ' + fmtDinero(doc.irpfImporte) + '</div>' : '') +
              '<div>Total: ' + fmtDinero(doc.total) + '</div>' +
            '</div>' +
          '</div>') +

      (doc.nota ? '<div class="panel"><h3>Menciones</h3><p class="det-desc">' + esc(doc.nota) + '</p></div>' : '') +
      (doc.pago ? '<div class="panel"><h3>Cobro</h3><p class="det-desc">' + esc(doc.pago.codigo) + ' · ' + fmtDia(doc.pago.fechaPago) + ' · ' + fmtDinero(doc.pago.importe) + '</p></div>' : '') +
      (relacionados ? '<div class="panel"><h3>Documentos relacionados</h3><div class="doc-actions" style="margin:0">' + relacionados + '</div></div>' : '');
  } catch (err) {
    caja.innerHTML = '<div class="empty">No se ha podido abrir el documento.</div>';
    coreError(err);
  }
}

function accionAbrir(accion, id, codigo) {
  const cfg = ACCIONES[accion];
  accionPendiente = { accion: accion, id: id };

  document.getElementById('dialogoAccionTitulo').textContent = cfg.titulo;
  document.getElementById('dialogoAccionTexto').textContent = cfg.texto.replace('{codigo}', codigo || '');
  document.getElementById('dialogoAccionConfirmar').textContent = cfg.boton;
  document.getElementById('dialogoAccionConfirmar').disabled = false;
  document.getElementById('accionMotivo').value = '';
  document.getElementById('dialogoAccionMotivo').classList.toggle('hidden', accion !== 'rectificar');
  coreMensaje('mensajeDialogoAccion', '');
  document.getElementById('dialogoAccion').classList.remove('hidden');
}

function accionCerrar() {
  accionPendiente = null;
  document.getElementById('dialogoAccion').classList.add('hidden');
}

async function accionConfirmar() {
  if (!accionPendiente) return;

  const p = accionPendiente;
  const boton = document.getElementById('dialogoAccionConfirmar');
  boton.disabled = true;

  try {
    let resultado;
    if (p.accion === 'proforma' || p.accion === 'resumen') {
      resultado = await api('POST', '/documentos/' + p.accion, cobroPeriodo());
    } else if (p.accion === 'cobrarPeriodo') {
      resultado = await api('POST', '/cobros/cobrar', cobroPeriodo());
    } else {
      resultado = await api('POST', '/documentos/' + p.id + '/' + p.accion, {
        motivo: document.getElementById('accionMotivo').value
      });
    }

    accionCerrar();

    const hecho = ACCIONES[p.accion].hecho;
    const conCodigo = hecho.slice(-2) === ': ';
    if (p.accion === 'cobrarPeriodo') {
      await cobroCalcular();
      coreMensaje('mensajeCobro', hecho, 'ok');
    } else {
      // Lleva al documento resultante para revisarlo.
      await documentoAbrir(resultado.id);
      coreMensaje('mensajeDocumento', hecho + (conCodigo ? resultado.codigo : ''), 'ok');
    }
  } catch (err) {
    boton.disabled = false;
    coreMensaje('mensajeDialogoAccion', err.message, 'error');
  }
}

/* Ajustes */

async function ajustesCargar() {
  const resultados = await Promise.all([api('GET', '/config'), api('GET', '/clientes'), api('GET', '/cuenta')]);
  const cfg = resultados[0];
  const cliente = resultados[1][0] || {};
  const cuenta = resultados[2];

  document.getElementById('cuentaEmail').value = cuenta.email || '';
  ['claveCampos', 'claveBoton'].forEach(function(id) {
    document.getElementById(id).classList.toggle('hidden', !!cuenta.keycloak);
  });
  document.getElementById('claveKeycloak').classList.toggle('hidden', !cuenta.keycloak);
  document.getElementById('cuentaCorreoEstado').textContent = cuenta.correoActivo
    ? 'Se usa para recuperar la contraseña, avisarte de cada inicio de sesión y enviarte el resumen el día 1 de cada mes.'
    : 'El envío de correo no está configurado en este servidor: no se enviará nada.';

  Object.keys(cfg).forEach(function(clave) {
    const campo = document.getElementById('cfg_' + clave);
    if (campo) campo.value = cfg[clave];
  });

  ['id', 'nombre', 'tarifa_hora', 'razon_social', 'nif', 'direccion', 'contacto', 'email', 'telefono', 'notas']
    .forEach(function(campo) {
      document.getElementById('cli_' + campo).value = cliente[campo] == null ? '' : cliente[campo];
    });
}

async function ajustesGuardar() {
  const datos = {};
  document.querySelectorAll('[id^="cfg_"]').forEach(function(campo) {
    datos[campo.id.slice(4)] = campo.value;
  });

  try {
    await api('PUT', '/config', datos);
    coreMensaje('mensajeAjustes', 'Ajustes guardados.', 'ok');
  } catch (err) {
    coreMensaje('mensajeAjustes', err.message, 'error');
  }
  window.scrollTo(0, 0);
}

async function clienteGuardar() {
  const datos = {};
  document.querySelectorAll('[id^="cli_"]').forEach(function(campo) {
    datos[campo.id.slice(4)] = campo.value;
  });

  try {
    await api('POST', '/clientes', datos);
    await ajustesCargar();
    coreMensaje('mensajeAjustes', 'Cliente guardado.', 'ok');
  } catch (err) {
    coreMensaje('mensajeAjustes', err.message, 'error');
  }
  window.scrollTo(0, 0);
}

async function cuentaGuardarEmail() {
  try {
    await api('PUT', '/cuenta/email', { email: document.getElementById('cuentaEmail').value });
    coreMensaje('mensajeCuenta', 'Correo guardado.', 'ok');
  } catch (err) {
    coreMensaje('mensajeCuenta', err.message, 'error');
  }
}

async function cuentaEnviar(que) {
  coreMensaje('mensajeCuenta', 'Enviando...', 'info');
  try {
    const r = await api('POST', '/cuenta/' + que, {});
    coreMensaje('mensajeCuenta', 'Enviado a ' + r.para + '. Si no lo ves, mira en la carpeta de spam.', 'ok');
  } catch (err) {
    coreMensaje('mensajeCuenta', err.message, 'error');
  }
}

async function claveCambiar() {
  try {
    await api('POST', '/cuenta/clave', {
      actual: document.getElementById('claveActual').value,
      nueva: document.getElementById('claveNueva').value
    });
    document.getElementById('claveActual').value = '';
    document.getElementById('claveNueva').value = '';
    coreMensaje('mensajeClave', 'Contraseña cambiada.', 'ok');
  } catch (err) {
    coreMensaje('mensajeClave', err.message, 'error');
  }
}
