/* Horas (sesiones de trabajo y gastos) y ajustes. Usa api(), esc(), coreMensaje() y coreConfirmar()
   de app.js. Lo que se factura pasa a Sindri: aquí solo se cuenta. */

let moneda = '€';
let monedaLeida = false;
let sesionesTodas = [];

const sesFiltros = { cobro: '', desde: '', hasta: '', q: '', clienteId: '' };
let sesClientesLeidos = false;

function fmtDinero(valor) {
  return Number(valor || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + moneda;
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
  const clase = { COBRADO: 'badge-ok', FACTURADO: 'badge-run', PENDIENTE: 'badge-pend', NO_COBRAR: 'badge-neutral', SINDRI: 'badge-run' }[situacion.clave];
  return '<span class="badge ' + (clase || 'badge-neutral') + '">' + esc(situacion.texto) + '</span>';
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
    await sesionesCargar();
  } catch (err) {
    coreMensaje('mensajeGasto', err.message, 'error');
  }
}

/* Sesiones */

async function sesionesCargar() {
  if (!document.getElementById('gastoDia').value) document.getElementById('gastoDia').value = hoyIso();
  if (!monedaLeida) {
    monedaLeida = true;
    moneda = (await api('GET', '/config')).MONEDA || '€';
  }
  sesFiltros.desde = document.getElementById('sesDesde').value;
  sesFiltros.hasta = document.getElementById('sesHasta').value;
  sesFiltros.q = document.getElementById('sesBuscar').value.trim();
  if (!sesClientesLeidos) {
    sesClientesLeidos = true;
    const clientes = await api('GET', '/clientes').catch(function() { return []; });
    document.getElementById('sesCliente').innerHTML = '<option value="">Todos</option>' + clientes.map(function(c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.nombre) + '</option>';
    }).join('');
  }
  sesFiltros.clienteId = document.getElementById('sesCliente').value;

  const partes = [];
  ['cobro', 'desde', 'hasta', 'q', 'clienteId'].forEach(function(clave) {
    if (sesFiltros[clave] && !(clave === 'cobro' && sesFiltros.cobro === 'RESUMEN')) partes.push(clave + '=' + encodeURIComponent(sesFiltros[clave]));
  });
  const consulta = partes.length ? '?' + partes.join('&') : '';

  if (sesFiltros.cobro === 'RESUMEN') {
    resumenPintar(await api('GET', '/resumen' + consulta));
    return;
  }
  sesionesTodas = await api('GET', '/trabajos' + consulta);
  sesionesPintar();
}

// Cuánto se ha cobrado: por mes y cada cobro. Lo cobrado cuenta por la fecha del cobro (también lo
// cobrado fuera de Sindri); lo que está en Sindri y lo pendiente, por el día del trabajo.
function fmtMes(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(mes || '');
  if (!m) return mes || '';
  const nombre = new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}

function resumenPintar(r) {
  document.querySelectorAll('[data-ses]').forEach(function(chip) {
    chip.classList.toggle('is-active', chip.dataset.ses === sesFiltros.cobro);
  });
  document.getElementById('sesResumen').innerHTML =
    '<div class="stats">' +
      '<div class="stat"><div class="stat-label">Cobrado</div><div class="stat-value">' + fmtDinero(r.totales.cobrado) + '</div></div>' +
      '<div class="stat"><div class="stat-label">En Sindri o facturado</div><div class="stat-value">' + fmtDinero(r.totales.enSindri) + '</div></div>' +
      '<div class="stat"><div class="stat-label">Pendiente</div><div class="stat-value">' + fmtDinero(r.totales.pendiente) + '</div></div>' +
    '</div>' +
    '<p class="muted" style="margin:-4px 0 12px">Lo cobrado va por la fecha del cobro, también lo que se cobró fuera de Sindri. Lo que está en Sindri y lo pendiente, por el día del trabajo. Aquí solo se consulta: se factura y se cobra en Sindri.</p>';

  if (!r.meses.length) {
    document.getElementById('sesLista').innerHTML = '<div class="empty">No hay nada con estos filtros.</div>';
    return;
  }

  const meses = '<div class="panel"><h3>Por mes</h3><div class="cobro-tabla-wrap"><table class="cobro-tabla">' +
    '<thead><tr><th>Mes</th><th>Cobrado</th><th>En Sindri o facturado</th><th>Pendiente</th><th>Horas trabajadas</th></tr></thead><tbody>' +
    r.meses.map(function(m) {
      return '<tr><td>' + esc(fmtMes(m.mes)) + '</td><td>' + fmtDinero(m.cobrado) + (m.cobros ? ' <span class="muted">(' + m.cobros + ')</span>' : '') +
        '</td><td>' + fmtDinero(m.enSindri) + '</td><td>' + fmtDinero(m.pendiente) + '</td><td>' + esc(m.horas) + ' h</td></tr>';
    }).join('') + '</tbody></table></div></div>';

  const cobros = r.cobros.length
    ? '<div class="panel"><h3>Cobros</h3><div class="cobro-tabla-wrap"><table class="cobro-tabla">' +
      '<thead><tr><th>Fecha</th><th>Cliente</th><th>Concepto</th><th>Sesiones</th><th>Importe</th></tr></thead><tbody>' +
      r.cobros.map(function(c) {
        return '<tr><td>' + fmtDia(c.fecha) + '</td><td>' + esc(c.cliente) + '</td><td>' + esc(c.concepto) +
          ' <span class="muted">' + esc(c.codigo) + '</span></td><td>' + c.sesiones + ' · ' + esc(c.horas) + ' h</td><td>' + fmtDinero(c.importe) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>'
    : '<div class="empty">No hay cobros en estas fechas.</div>';

  document.getElementById('sesLista').innerHTML = meses + cobros;
}

function sesionesFiltrar(cobro) {
  sesFiltros.cobro = cobro;
  sesionesCargar().catch(coreError);
}

function sesionesLimpiar() {
  ['sesDesde', 'sesHasta', 'sesBuscar', 'sesCliente'].forEach(function(id) { document.getElementById(id).value = ''; });
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

  const cobrables = cobrablesDe(lista);
  if (cobrables.length) {
    document.getElementById('sesResumen').innerHTML +=
      '<div class="actions" style="margin:-4px 0 12px"><button type="button" class="btn btn-secondary btn-sm" onclick="cobroAbrir()">' +
      'Marcar como cobradas (' + cobrables.length + ')</button></div>';
  }

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
    if (t.cobroDeshacible && !t.deOtro) {
      acciones.push('<button type="button" class="btn btn-secondary btn-sm" onclick="cobroDeshacer(' + t.pagoId + ', \'' + esc(t.pagoCodigo) + '\')">Deshacer cobro</button>');
    }
    if (sesionEditable(t)) {
      acciones.push('<button type="button" class="btn btn-secondary btn-sm" onclick="sesionAbrir(' + t.id + ', sesionesTodas)">Corregir horas</button>');
    }
    if (libre && !t.deOtro) {
      acciones.push('<button type="button" class="btn btn-secondary btn-sm" onclick="sesionEstado(' + t.id + ', \'' +
        (t.estado === 'NO_COBRAR' ? 'CERRADA' : 'NO_COBRAR') + '\')">' + (t.estado === 'NO_COBRAR' ? 'Volver a facturar' : 'No facturar') + '</button>');
    }

    return '<div class="doc' + (t.estado === 'NO_COBRAR' ? ' doc-off' : '') + '">' +
      '<div class="doc-head">' +
        '<span class="doc-code">' + fmtDia(t.dia) + '</span>' +
        badgeSituacion(t.situacion) +
        '<span class="doc-total">' + fmtDinero(t.importe) + '</span>' +
      '</div>' +
      '<div class="doc-title">' + esc(t.concepto) + '</div>' +
      '<div class="doc-sub">' + esc(t.codigo) + (t.deOtro ? ' · de ' + esc(t.autor || 'general') : '') + ' · ' +
        (t.tipo === 'UNICO' ? 'Gasto suelto' : (t.inicio && t.fin ? esc(fmtTramo(t.inicio, t.fin)) + ' · ' : '') +
          fmtDuracion(t.minutos) + ' reales · ' + esc(t.horas) + ' h a ' + fmtDinero(t.tarifa)) + '</div>' +
      (acciones.length ? '<div class="doc-actions">' + acciones.join('') + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}

/* Cobros hechos fuera de Sindri: se apuntan aquí para que esas sesiones no se vuelvan a facturar */

// Las de la lista que se pueden marcar: tuyas, sin cobrar y que se facturan.
function cobrablesDe(lista) {
  return lista.filter(function(t) { return !t.deOtro && !t.pagoId && t.estado !== 'NO_COBRAR'; });
}

function cobroAbrir() {
  const lista = cobrablesDe(sesionesTodas);
  const clientes = Array.from(new Set(lista.map(function(t) { return t.cliente; })));
  const dias = lista.map(function(t) { return t.dia; }).sort();
  const importe = lista.reduce(function(s, t) { return s + Number(t.importe); }, 0);
  const enSindri = lista.filter(function(t) { return t.sindriPedido; }).length;
  document.getElementById('cobroAyuda').textContent =
    lista.length + (lista.length === 1 ? ' sesión' : ' sesiones') + ' de ' + clientes.join(', ') + ', del ' + fmtDia(dias[0]) +
    ' al ' + fmtDia(dias[dias.length - 1]) + ', por ' + fmtDinero(importe) + '. Usa los filtros para elegir solo las que se cobraron.' +
    (enSindri ? ' ' + enSindri + ' están en un pedido de Sindri: anúlalo allí si era un duplicado.' : '');
  document.getElementById('cobroFecha').value = hoyIso();
  document.getElementById('cobroConcepto').value = '';
  document.getElementById('cobroNota').value = '';
  coreMensaje('mensajeCobro', '');
  document.getElementById('dialogoCobro').classList.remove('hidden');
}

function cobroCerrar() {
  document.getElementById('dialogoCobro').classList.add('hidden');
}

async function cobroGuardar() {
  const boton = document.getElementById('cobroBoton');
  boton.disabled = true;
  try {
    const r = await api('POST', '/cobros', {
      ids: cobrablesDe(sesionesTodas).map(function(t) { return t.id; }),
      fecha: document.getElementById('cobroFecha').value,
      concepto: document.getElementById('cobroConcepto').value,
      nota: document.getElementById('cobroNota').value
    });
    cobroCerrar();
    await sesionesCargar();
    coreMensaje('mensajeGlobal', 'Cobro ' + r.codigo + ' apuntado: ' + r.sesiones + ' sesiones, ' + fmtDinero(r.importe) + '.', 'ok');
  } catch (err) {
    coreMensaje('mensajeCobro', err.message, 'error');
  }
  boton.disabled = false;
}

async function cobroDeshacer(pagoId, codigo) {
  const si = await coreConfirmar('Deshacer cobro', 'Las sesiones del cobro ' + codigo + ' vuelven a quedar sin cobrar.', 'Deshacer');
  if (!si) return;
  try {
    await api('POST', '/cobros/' + pagoId + '/deshacer', {});
    await sesionesCargar();
  } catch (err) {
    coreError(err);
  }
}

async function sesionEstado(id, estado) {
  try {
    await api('POST', '/trabajos/' + id + '/estado', { estado: estado });
    await sesionesCargar();
  } catch (err) {
    coreError(err);
  }
}

/* Ajustes */

async function ajustesCargar() {
  const resultados = await Promise.all([api('GET', '/config'), api('GET', '/clientes'), api('GET', '/cuenta')]);
  const cfg = resultados[0];
  // Tu cliente: el primero tuyo; los que te comparten no se cambian aquí.
  const cliente = resultados[1].find(function(c) { return !c.deOtro; }) || {};
  const cuenta = resultados[2];

  document.getElementById('cuentaEmail').value = cuenta.email || '';
  ['claveCampos', 'claveBoton'].forEach(function(id) {
    document.getElementById(id).classList.toggle('hidden', !!cuenta.keycloak);
  });
  document.getElementById('claveKeycloak').classList.toggle('hidden', !cuenta.keycloak);
  document.getElementById('cuentaCorreoEstado').textContent = cuenta.correoActivo
    ? 'Se usa para recuperar la contraseña, avisarte de cada inicio de sesión y enviarte el resumen el día 1 de cada mes.'
    : 'El envío de correo no está configurado en este servidor: no se enviará nada.';

  sindriCargar();
  horasPermisosCargar();
  tareasCargar();

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

/* Sindri */

const sindriFecha = function(iso) { return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }); };

// Cómo fue un envío, en una frase.
function sindriResumen(u) {
  const fecha = sindriFecha;
  let t;
  if (!u.ok) return 'Último intento, ' + fecha(u.cuando) + ': ' + u.error;
  // Lo que ya está en un pedido de Sindri está facturado allí: no se cuenta como pendiente.
  t = 'Último envío a ' + (u.empresa || 'Sindri') + ', ' + fecha(u.cuando) + ': ' + (u.pendientes - u.en_pedido) + ' por facturar (' +
    u.creado + ' nuevos, ' + u.actualizado + ' al día, ' + u.retirados + ' retirados)' +
    (u.en_pedido ? '; ' + u.en_pedido + ' ya están en un pedido de Sindri' : '') + '.';
  const a = u.altas || {};
  if (a.clientes || a.servicios) t += ' Dados de alta en Sindri: ' + [a.clientes ? a.clientes + ' cliente' + (a.clientes > 1 ? 's' : '') : '', a.servicios ? a.servicios + ' servicio' + (a.servicios > 1 ? 's' : '') : ''].filter(Boolean).join(' y ') + '.';
  if (u.errores.length) t += ' No han entrado ' + u.errores.length + ': ' + u.errores.slice(0, 3).map(function(x) { return x.ref + ' (' + x.error + ')'; }).join('; ') + (u.errores.length > 3 ? '…' : '') + '.';
  if (u.aviso) t += ' ' + u.aviso;
  return t;
}

function sindriPintar(e) {
  // Quien trabaja para su propia empresa no toca la conexión general ni ve cómo le va.
  const desdeEntorno = e.desde === 'entorno' || e.independiente;
  document.getElementById('sindriCampos').classList.toggle('hidden', desdeEntorno);
  document.getElementById('sindriGuardarBtn').classList.toggle('hidden', desdeEntorno);
  document.getElementById('sindriQuitarBtn').classList.toggle('hidden', desdeEntorno || !e.configurado);
  document.getElementById('sindriUrl').value = e.url || '';
  document.getElementById('sindriLlave').value = '';
  document.getElementById('sindriLlave').placeholder = e.configurado ? 'Guardada (escribe otra para cambiarla)' : 'sdi_…';
  const u = e.ultima;
  let t;
  if (!e.configurado) t = 'Sin llave general: solo se envía lo de quien tiene llave propia.';
  else if (!u) t = 'Conectado' + (desdeEntorno ? ' (lo pone el servidor)' : '') + '. El primer envío sale en unos segundos.';
  else t = sindriResumen(u);
  if (e.independiente) t = 'La conexión general la lleva quien administra el gestor. Lo tuyo va con tu llave, abajo.';
  if (e.personas && e.personas.length) t += ' Con su propia empresa: ' + e.personas.join(', ') + '.';
  document.getElementById('sindriEstado').textContent = t;

  const m = e.mia || {};
  document.getElementById('sindriMiaLlave').value = '';
  document.getElementById('sindriMiaLlave').placeholder = m.configurada ? 'Guardada (escribe otra para cambiarla)' : 'sdi_…';
  document.getElementById('sindriMiaQuitarBtn').classList.toggle('hidden', !m.configurada);
  document.getElementById('sindriMiaEstado').textContent = m.enEspera
    ? 'Sin llave: lo que apuntas espera y no se envía a ninguna empresa.'
    : !m.configurada ? 'Sin llave propia: lo que apuntas va a la empresa de arriba.'
    : m.ultima ? sindriResumen(m.ultima) : 'Guardada. El primer envío a tu empresa sale en unos segundos.';
}

const QUE_TEXTO = { horas: 'horas y cobros', clientes: 'clientes', incidencias: 'incidencias' };

function horasPermisosPintar(p) {
  const agrupar = function(lista, quien) {
    const por = {};
    lista.forEach(function(x) { (por[x[quien]] = por[x[quien]] || []).push(QUE_TEXTO[x.que] || x.que); });
    return Object.keys(por).map(function(k) { return k + ' (' + por[k].join(', ') + ')'; }).join('; ');
  };
  const partes = [];
  partes.push(p.dejo.length ? 'Compartes con: ' + agrupar(p.dejo, 'usuario') + '.' : 'No compartes nada con nadie.');
  if (p.meDejan.length) partes.push('Te comparten: ' + agrupar(p.meDejan, 'de') + '.');
  document.getElementById('horasPermisosEstado').textContent = partes.join(' ');
}

async function horasPermisosCargar() {
  try { horasPermisosPintar(await api('GET', '/compartir')); } catch (err) { coreMensaje('mensajeHorasPermisos', err.message, 'error'); }
  try { tarifaPintar(await api('GET', '/horas/tarifa')); } catch (err) { coreMensaje('mensajeTarifa', err.message, 'error'); }
}

async function horasPermiso(ver) {
  try {
    horasPermisosPintar(await api('PUT', '/compartir', {
      usuario: document.getElementById('horasPermisoUsuario').value,
      que: document.getElementById('horasPermisoQue').value,
      ver: ver
    }));
    document.getElementById('horasPermisoUsuario').value = '';
    coreMensaje('mensajeHorasPermisos', ver ? 'Compartido.' : 'Ya no lo compartes.', 'ok');
  } catch (err) {
    coreMensaje('mensajeHorasPermisos', err.message, 'error');
  }
}

function tarifaPintar(t) {
  document.getElementById('tarifaPropia').value = t.tarifa == null ? '' : t.tarifa;
  document.getElementById('tarifaPropia').placeholder = 'Por defecto ' + t.porDefecto;
  document.getElementById('tarifaEstado').textContent = 'La de tus sesiones nuevas: ' + fmtDinero(t.seAplica) + ' por hora' +
    (t.tarifa == null ? ' (por defecto; pon la tuya)' : '') +
    (t.independiente ? '.' : '. Si el cliente tiene su propia tarifa, manda la del cliente.');
}

async function tarifaGuardar() {
  try {
    tarifaPintar(await api('PUT', '/horas/tarifa', { tarifa: document.getElementById('tarifaPropia').value }));
    coreMensaje('mensajeTarifa', 'Tarifa guardada.', 'ok');
  } catch (err) {
    coreMensaje('mensajeTarifa', err.message, 'error');
  }
}

async function sindriMiaGuardar() {
  try {
    sindriPintar(await api('PUT', '/sindri/mia', { llave: document.getElementById('sindriMiaLlave').value }));
    coreMensaje('mensajeSindriMia', 'Guardada: tus horas irán a tu empresa.', 'ok');
  } catch (err) {
    coreMensaje('mensajeSindriMia', err.message, 'error');
  }
}

async function sindriMiaQuitar() {
  try {
    sindriPintar(await api('PUT', '/sindri/mia', { quitar: true }));
    coreMensaje('mensajeSindriMia', 'Llave quitada: lo tuyo espera hasta que pongas otra.', 'ok');
  } catch (err) {
    coreMensaje('mensajeSindriMia', err.message, 'error');
  }
}

async function sindriCargar() {
  try { sindriPintar(await api('GET', '/sindri')); } catch (err) { coreMensaje('mensajeSindri', err.message, 'error'); }
}

async function sindriGuardar() {
  try {
    sindriPintar(await api('PUT', '/sindri', { url: document.getElementById('sindriUrl').value, llave: document.getElementById('sindriLlave').value }));
    coreMensaje('mensajeSindri', 'Guardado. El envío sale en unos segundos.', 'ok');
  } catch (err) {
    coreMensaje('mensajeSindri', err.message, 'error');
  }
}

async function sindriEnviar() {
  coreMensaje('mensajeSindri', 'Enviando...', 'info');
  try {
    sindriPintar(await api('POST', '/sindri/enviar', {}));
    document.getElementById('mensajeSindri').classList.add('hidden');
  } catch (err) {
    coreMensaje('mensajeSindri', err.message, 'error');
  }
}

async function sindriQuitar() {
  try {
    sindriPintar(await api('PUT', '/sindri', { quitar: true }));
    coreMensaje('mensajeSindri', 'Llave quitada: ya no se envía nada.', 'ok');
  } catch (err) {
    coreMensaje('mensajeSindri', err.message, 'error');
  }
}

/* Tareas */

function tareasPintar(e) {
  const fecha = function(iso) { return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }); };
  // Quien trabaja para su propia empresa no toca la conexión general ni ve cómo le va.
  const desdeEntorno = e.desde === 'entorno' || e.independiente;
  document.getElementById('tareasCampos').classList.toggle('hidden', desdeEntorno);
  document.getElementById('tareasGuardarBtn').classList.toggle('hidden', desdeEntorno);
  document.getElementById('tareasQuitarBtn').classList.toggle('hidden', desdeEntorno || !e.configurado);
  document.getElementById('tareasUrl').value = e.url || '';
  document.getElementById('tareasProyecto').value = e.proyecto || '';
  document.getElementById('tareasLlave').value = '';
  document.getElementById('tareasLlave').placeholder = e.configurado ? 'Guardada (escribe otra para cambiarla)' : '';
  const u = e.ultima;
  let t;
  if (!e.configurado) t = 'Sin conectar: no se crea ninguna tarea.';
  else if (!u) t = 'Conectado' + (desdeEntorno ? ' (lo pone el servidor)' : '') + '. El primer envío sale en unos segundos.';
  else if (!u.ok) t = 'Último intento, ' + fecha(u.cuando) + ': ' + u.error;
  else {
    t = 'Último envío a ' + u.proyecto + ', ' + fecha(u.cuando) + ': ' + u.creadas + ' creadas, ' + u.cambiadas + ' cambiadas, ' +
      u.cerradas + ' a hechas, ' + u.reabiertas + ' reabiertas.';
    if (u.errores.length) t += ' Fallaron ' + u.errores.length + ': ' + u.errores.slice(0, 3).map(function(x) { return x.ref + ' (' + x.error + ')'; }).join('; ') + (u.errores.length > 3 ? '…' : '') + '.';
  }
  document.getElementById('tareasEstado').textContent = t;
}

async function tareasCargar() {
  try { tareasPintar(await api('GET', '/tareas')); } catch (err) { coreMensaje('mensajeTareas', err.message, 'error'); }
}

async function tareasGuardar() {
  try {
    tareasPintar(await api('PUT', '/tareas', {
      url: document.getElementById('tareasUrl').value,
      llave: document.getElementById('tareasLlave').value,
      proyecto: document.getElementById('tareasProyecto').value
    }));
    coreMensaje('mensajeTareas', 'Guardado. El envío sale en unos segundos.', 'ok');
  } catch (err) {
    coreMensaje('mensajeTareas', err.message, 'error');
  }
}

async function tareasEnviar() {
  coreMensaje('mensajeTareas', 'Enviando...', 'info');
  try {
    tareasPintar(await api('POST', '/tareas/enviar', {}));
    document.getElementById('mensajeTareas').classList.add('hidden');
  } catch (err) {
    coreMensaje('mensajeTareas', err.message, 'error');
  }
}

async function tareasQuitar() {
  try {
    tareasPintar(await api('PUT', '/tareas', { quitar: true }));
    coreMensaje('mensajeTareas', 'Llave quitada: ya no se crea ninguna tarea.', 'ok');
  } catch (err) {
    coreMensaje('mensajeTareas', err.message, 'error');
  }
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
