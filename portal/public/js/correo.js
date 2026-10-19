/* Redacción de correo con el formato de la marca. Usa api(), esc() y coreMensaje() de app.js. */

let correoIncidencia = null;
let correoTemporizador = null;

function correoDatos() {
  return {
    para: document.getElementById('correoPara').value,
    asunto: document.getElementById('correoAsunto').value,
    mensaje: document.getElementById('correoMensaje').value,
    botonTexto: document.getElementById('correoBotonTexto').value,
    botonUrl: document.getElementById('correoBotonUrl').value,
    incidenciaId: correoIncidencia ? correoIncidencia.id : null
  };
}

// Abre la pantalla. Con una incidencia, prepara el asunto y deja el correo
// ligado a ella: al enviarlo queda anotado en su documentación.
function correoAbrir(incidencia) {
  correoIncidencia = incidencia || null;

  if (correoIncidencia) {
    document.getElementById('correoAsunto').value = '[' + correoIncidencia.codigo + ' #' + correoIncidencia.id + '] ' + correoIncidencia.titulo;
  }

  coreMostrarVista('correo');
}

async function correoCargar() {
  const aviso = document.getElementById('correoAviso');
  if (correoIncidencia) {
    aviso.innerHTML = 'Este correo quedará anotado en la incidencia <strong>#' + correoIncidencia.id + ' ' + esc(correoIncidencia.titulo) +
      '</strong>. <button type="button" class="link-btn" onclick="correoDesligar()">Quitar el vínculo</button>';
    aviso.className = 'message info';
  } else {
    aviso.className = 'message info hidden';
  }

  // Por defecto, el correo del cliente.
  const para = document.getElementById('correoPara');
  if (!para.value) {
    const clientes = await api('GET', '/clientes');
    if (clientes[0] && clientes[0].email) para.value = clientes[0].email;
  }

  await Promise.all([correoVista(), correoEnviados()]);
}

function correoDesligar() {
  correoIncidencia = null;
  correoCargar().catch(coreError);
}

// La vista previa la genera el servidor con la misma plantilla que se envía.
function correoVistaPronto() {
  clearTimeout(correoTemporizador);
  correoTemporizador = setTimeout(function() { correoVista().catch(function() {}); }, 400);
}

async function correoVista() {
  const r = await api('POST', '/correo/vista', correoDatos());
  document.getElementById('correoVista').srcdoc = r.html;
}

function correoLimpiar() {
  ['correoAsunto', 'correoMensaje', 'correoBotonTexto', 'correoBotonUrl'].forEach(function(id) { document.getElementById(id).value = ''; });
  coreMensaje('mensajeCorreo', '');
  correoVista().catch(function() {});
}

async function correoEnviar() {
  const datos = correoDatos();
  const destinos = datos.para.split(/[,;\s]+/).filter(function(p) { return p; });

  const si = await coreConfirmar('Enviar correo',
    'Se enviará a ' + (destinos.join(', ') || '(sin destinatario)') + ' desde soporte@luiscontacto03.com' +
      '. Un correo enviado no se puede retirar.', 'Enviar');
  if (!si) return;

  const boton = document.getElementById('correoBoton');
  boton.disabled = true;
  coreMensaje('mensajeCorreo', 'Enviando...', 'info');

  try {
    const r = await api('POST', '/correo/enviar', datos);
    document.getElementById('correoAviso').className = correoIncidencia ? 'message info' : 'message info hidden';
    correoLimpiar();
    coreMensaje('mensajeCorreo', 'Enviado a ' + r.para.join(', ') + '.' +
      (datos.incidenciaId ? (r.anotado ? ' Anotado en la incidencia.' : ' No se ha podido anotar en la incidencia.') : ''), 'ok');
    await correoEnviados();
  } catch (err) {
    coreMensaje('mensajeCorreo', err.message, 'error');
  }
  boton.disabled = false;
}

async function correoEnviados() {
  const caja = document.getElementById('correoEnviados');
  const lista = await api('GET', '/correo/enviados');

  if (!lista.length) {
    caja.innerHTML = '<div class="empty">Todavía no has enviado ningún correo desde aquí.</div>';
    return;
  }

  caja.innerHTML = '<div class="pet-list">' + lista.map(function(c) {
    return '<details class="doc">' +
      '<summary class="doc-head" style="cursor:pointer">' +
        '<span class="doc-title" style="margin:0">' + esc(c.asunto) + '</span>' +
        '<span class="doc-total" style="font-size:13px">' + fmtFechaHora(c.enviadoEn) + '</span>' +
      '</summary>' +
      '<div class="doc-sub">Para: ' + esc(c.para) + (c.incidenciaId ? ' · incidencia #' + c.incidenciaId : '') +
        (c.adjunto ? ' · adjunto ' + esc(c.adjunto) : '') + '</div>' +
      '<p class="det-desc" style="margin-top:10px">' + esc(c.mensaje) + '</p>' +
      (c.incidenciaId ? '<div class="doc-actions"><button type="button" class="btn btn-secondary btn-sm" onclick="detalleTab=\'notas\'; detalleAbrir(' + c.incidenciaId + ')">Ver incidencia</button></div>' : '') +
    '</details>';
  }).join('') + '</div>';
}
