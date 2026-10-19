/* Horas (sesiones de trabajo y gastos) y ajustes. Usa api(), esc(), coreMensaje() y coreConfirmar()
   de app.js. Lo que se factura pasa a Sindri: aquí solo se cuenta. */

let moneda = '€';
let monedaLeida = false;
let sesionesTodas = [];

const sesFiltros = { cobro: '', desde: '', hasta: '', q: '' };

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
        (t.estado === 'NO_COBRAR' ? 'CERRADA' : 'NO_COBRAR') + '\')">' + (t.estado === 'NO_COBRAR' ? 'Volver a facturar' : 'No facturar') + '</button>');
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

  sindriCargar();

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

function sindriPintar(e) {
  const fecha = function(iso) { return new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }); };
  const desdeEntorno = e.desde === 'entorno';
  document.getElementById('sindriCampos').classList.toggle('hidden', desdeEntorno);
  document.getElementById('sindriGuardarBtn').classList.toggle('hidden', desdeEntorno);
  document.getElementById('sindriQuitarBtn').classList.toggle('hidden', desdeEntorno || !e.configurado);
  document.getElementById('sindriUrl').value = e.url || '';
  document.getElementById('sindriLlave').value = '';
  document.getElementById('sindriLlave').placeholder = e.configurado ? 'Guardada (escribe otra para cambiarla)' : 'sdi_…';
  const u = e.ultima;
  let t;
  if (!e.configurado) t = 'Sin conectar: no se envía nada.';
  else if (!u) t = 'Conectado' + (desdeEntorno ? ' (lo pone el servidor)' : '') + '. El primer envío sale en unos segundos.';
  else if (!u.ok) t = 'Último intento, ' + fecha(u.cuando) + ': ' + u.error;
  else {
    t = 'Último envío a ' + (u.empresa || 'Sindri') + ', ' + fecha(u.cuando) + ': ' + u.pendientes + ' pendientes (' +
      u.creado + ' nuevos, ' + u.actualizado + ' al día, ' + u.en_pedido + ' ya en pedido, ' + u.retirados + ' retirados).';
    if (u.errores.length) t += ' No han entrado ' + u.errores.length + ': ' + u.errores.slice(0, 3).map(function(x) { return x.ref + ' (' + x.error + ')'; }).join('; ') + (u.errores.length > 3 ? '…' : '') + '.';
    if (u.aviso) t += ' ' + u.aviso;
  }
  document.getElementById('sindriEstado').textContent = t;
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
