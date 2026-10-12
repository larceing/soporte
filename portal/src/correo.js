// Envío de correo por Resend (API HTTP). Sin RESEND_API_KEY el portal funciona
// igual y simplemente no envía nada.

const CLAVE = process.env.RESEND_API_KEY || '';
const REMITENTE = process.env.CORREO_REMITENTE || 'Henry Arce · Soporte <soporte@luiscontacto03.com>';
const URL_PORTAL = (process.env.PORTAL_URL || '').replace(/\/+$/, '');

function activo() {
  return Boolean(CLAVE);
}

function esc(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Plantilla común con la marca. "parrafos" son textos ya escapados o HTML propio.
function plantilla(titulo, parrafos, boton) {
  return '<!DOCTYPE html><html lang="es"><body style="margin:0;background:#F3F5F7;font-family:Arial,Helvetica,sans-serif;color:#15202B;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F7;padding:24px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:14px;overflow:hidden;">' +
      '<tr><td style="background:#0E1B33;padding:18px 24px;">' +
        '<div style="color:#FFFFFF;font-size:17px;font-weight:bold;letter-spacing:1px;">HENRY ARCE</div>' +
        '<div style="color:#35D6C0;font-size:10px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;padding-top:3px;">Business Applications &amp; Data</div>' +
      '</td></tr>' +
      '<tr><td style="height:4px;background:#35D6C0;font-size:1px;line-height:1px;">&nbsp;</td></tr>' +
      '<tr><td style="padding:26px 24px 8px;">' +
        '<h1 style="margin:0 0 14px;font-size:20px;">' + esc(titulo) + '</h1>' +
        parrafos.map(p => '<p style="margin:0 0 14px;font-size:15px;line-height:1.5;">' + p + '</p>').join('') +
        (boton
          ? '<p style="margin:22px 0;"><a href="' + esc(boton.url) + '" style="display:inline-block;background:#1D4F7A;color:#FFFFFF;' +
            'text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px;">' + esc(boton.texto) + '</a></p>' +
            '<p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#5B6877;">Si el botón no funciona, copia esta dirección en el navegador:<br>' + esc(boton.url) + '</p>'
          : '') +
      '</td></tr>' +
      '<tr><td style="padding:14px 24px 22px;border-top:1px solid #DDE3EA;font-size:12px;color:#5B6877;">Gestor de incidencias · mensaje automático, no hace falta responder.</td></tr>' +
    '</table></td></tr></table></body></html>';
}

async function enviar({ para, asunto, html, texto }) {
  if (!activo()) return { enviado: false, motivo: 'Correo sin configurar.' };
  if (!para) return { enviado: false, motivo: 'Sin destinatario.' };

  try {
    const respuesta = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + CLAVE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: REMITENTE, to: [para], subject: asunto, html: html, text: texto })
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text();
      console.error('Correo rechazado (' + respuesta.status + '): ' + detalle.slice(0, 300));
      return { enviado: false, motivo: 'El servicio de correo ha rechazado el envío (' + respuesta.status + ').' };
    }
    return { enviado: true };
  } catch (e) {
    console.error('No se ha podido enviar el correo: ' + e.message);
    return { enviado: false, motivo: 'No se ha podido conectar con el servicio de correo.' };
  }
}

function recuperacion(para, usuario, token, minutos) {
  const url = URL_PORTAL + '/restablecer?token=' + token;
  return enviar({
    para: para,
    asunto: 'Restablecer tu contraseña',
    texto: 'Has pedido restablecer la contraseña de ' + usuario + '. Abre este enlace (caduca en ' + minutos + ' minutos): ' + url +
      '\n\nSi no has sido tú, ignora este mensaje: tu contraseña no cambia.',
    html: plantilla('Restablecer tu contraseña', [
      'Has pedido restablecer la contraseña del usuario <strong>' + esc(usuario) + '</strong>.',
      'El enlace caduca en ' + minutos + ' minutos y solo se puede usar una vez.',
      'Si no has sido tú, ignora este mensaje: tu contraseña no cambia.'
    ], { url: url, texto: 'Elegir una contraseña nueva' })
  });
}

function avisoAcceso(para, usuario, datos) {
  const cuando = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return enviar({
    para: para,
    asunto: 'Nuevo inicio de sesión en el Gestor de incidencias',
    texto: 'Se ha iniciado sesión como ' + usuario + ' el ' + cuando + ' desde ' + datos.ip + ' (' + datos.navegador + ').' +
      '\n\nSi no has sido tú, cambia la contraseña en Ajustes cuanto antes.',
    html: plantilla('Nuevo inicio de sesión', [
      'Se ha iniciado sesión como <strong>' + esc(usuario) + '</strong>.',
      '<strong>Cuándo:</strong> ' + esc(cuando) + '<br><strong>Desde:</strong> ' + esc(datos.ip) + '<br><strong>Navegador:</strong> ' + esc(datos.navegador),
      'Si has sido tú, no tienes que hacer nada. Si no, cambia la contraseña en Ajustes cuanto antes: al hacerlo se cierran las demás sesiones.'
    ], URL_PORTAL ? { url: URL_PORTAL, texto: 'Abrir el gestor' } : null)
  });
}

function claveCambiada(para, usuario) {
  return enviar({
    para: para,
    asunto: 'Tu contraseña se ha cambiado',
    texto: 'La contraseña de ' + usuario + ' se acaba de cambiar. Si no has sido tú, usa "He olvidado la contraseña" en la pantalla de entrada.',
    html: plantilla('Tu contraseña se ha cambiado', [
      'La contraseña del usuario <strong>' + esc(usuario) + '</strong> se acaba de cambiar y se han cerrado las demás sesiones.',
      'Si no has sido tú, entra en la pantalla de inicio y usa «He olvidado la contraseña» para recuperarla.'
    ], URL_PORTAL ? { url: URL_PORTAL + '/login', texto: 'Ir a la pantalla de entrada' } : null)
  });
}

function prueba(para) {
  return enviar({
    para: para,
    asunto: 'Prueba de correo del Gestor de incidencias',
    texto: 'Si lees esto, el correo del gestor funciona.',
    html: plantilla('El correo funciona', ['Este es un mensaje de prueba enviado desde el Gestor de incidencias.'])
  });
}

module.exports = { activo, enviar, plantilla, esc, URL_PORTAL, recuperacion, avisoAcceso, claveCambiada, prueba };
