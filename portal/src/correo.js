// El correo del portal sale por Mail, la app de correo del servidor DEV/PRO
// (larceing/mail): el portal dice qué contar en bloques y Mail le pone la marca,
// lo envía por Resend y lo anota. Hacen falta MAIL_URL (por dentro,
// http://mail-<entorno>:3000) y MAIL_LLAVE (la llave de Soporte, creada en Mail).
// Sin ellas el portal funciona igual y simplemente no envía nada.

const MAIL_URL = () => String(process.env.MAIL_URL || '').replace(/\/+$/, '');
const LLAVE = () => process.env.MAIL_LLAVE || '';
// Dirección pública del portal, para los enlaces de los correos. En el servidor
// DEV/PRO la pone el propio servidor (APP_URL_PUBLICA).
const URL_PORTAL = (process.env.PORTAL_URL || process.env.APP_URL_PUBLICA || '').replace(/\/+$/, '');

const PIE_AUTOMATICO = 'Gestor de incidencias · mensaje automático, no hace falta responder.';
const PIE_PERSONAL = 'Henry Arce · Business Applications & Data · Puedes responder a este correo.';

function activo() {
  return Boolean(MAIL_URL() && LLAVE());
}

function emailValido(email) {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email) && email.length <= 200;
}

// Lo que se escribe en negrita en los bloques de texto de Mail.
const negrita = (t) => '**' + String(t).replace(/\*/g, '') + '**';

async function llamar(ruta, cuerpo) {
  const r = await fetch(MAIL_URL() + '/api/' + ruta, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + LLAVE(), 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(cuerpo.adjuntos ? 60000 : 20000)
  });
  const datos = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, datos };
}

// { para, asunto, bloques, pie? } -> { enviado } o { enviado: false, motivo }
async function enviar(correo) {
  const para = (Array.isArray(correo.para) ? correo.para : [correo.para]).filter(p => p);
  if (!activo()) return { enviado: false, motivo: 'Correo sin configurar.' };
  if (!para.length) return { enviado: false, motivo: 'Sin destinatario.' };

  try {
    const r = await llamar('enviar', { ...correo, para, pie: correo.pie || PIE_AUTOMATICO });
    // Un Mail anterior a los adjuntos envía el correo sin ellos y no lo dice.
    const pedidos = (correo.adjuntos || []).length;
    if (r.ok) return pedidos && r.datos.adjuntos !== pedidos ? { enviado: true, sinAdjuntos: true } : { enviado: true };
    console.error('Mail no ha enviado (' + r.status + '): ' + (r.datos.error || ''));
    return { enviado: false, motivo: r.datos.error || 'El servicio de correo no lo ha enviado (' + r.status + ').' };
  } catch (e) {
    console.error('No se ha podido llamar a Mail: ' + e.message);
    return { enviado: false, motivo: 'No se ha podido conectar con el servicio de correo.' };
  }
}

// Correo escrito a mano desde el portal.
function bloquesPersonales({ mensaje, boton }) {
  const b = [{ tipo: 'texto', texto: mensaje }];
  if (boton && boton.url) b.push({ tipo: 'boton', texto: boton.texto || 'Abrir', url: boton.url });
  return b;
}

// adjuntos: [{ nombre, contenido (base64) }], como los recibe Mail.
function personal({ para, asunto, mensaje, boton, adjuntos }) {
  return enviar({
    para, asunto, bloques: [{ tipo: 'titulo', texto: asunto }, ...bloquesPersonales({ mensaje, boton })], pie: PIE_PERSONAL,
    ...(adjuntos && adjuntos.length ? { adjuntos } : {})
  });
}

// La vista previa de la pantalla Correo: la misma que hará Mail al enviar.
async function htmlPersonal({ asunto, mensaje, boton }) {
  if (!activo()) {
    return '<p style="font-family:sans-serif;color:#5B6877;padding:20px;">El envío de correo no está configurado (MAIL_URL y MAIL_LLAVE): no hay vista previa.</p>';
  }
  const r = await llamar('vista', { asunto, bloques: [{ tipo: 'titulo', texto: asunto }, ...bloquesPersonales({ mensaje, boton })], pie: PIE_PERSONAL });
  if (!r.ok) {
    const e = new Error(r.datos.error || 'El servicio de correo no ha dado la vista previa.');
    e.status = r.status === 400 ? 400 : 502;
    throw e;
  }
  return r.datos.html;
}

const abrirGestor = (ruta, texto) => URL_PORTAL ? [{ tipo: 'boton', texto, url: URL_PORTAL + (ruta || '') }] : [];

function recuperacion(para, usuario, token, minutos) {
  return enviar({
    para,
    asunto: 'Restablecer tu contraseña',
    bloques: [
      { tipo: 'titulo', texto: 'Restablecer tu contraseña' },
      { tipo: 'texto', texto: 'Has pedido restablecer la contraseña del usuario ' + negrita(usuario) + '.\n\nEl enlace caduca en ' + minutos +
        ' minutos y solo se puede usar una vez.\n\nSi no has sido tú, ignora este mensaje: tu contraseña no cambia.' },
      { tipo: 'boton', texto: 'Elegir una contraseña nueva', url: URL_PORTAL + '/restablecer?token=' + token }
    ]
  });
}

function avisoAcceso(para, usuario, datos) {
  const cuando = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return enviar({
    para,
    asunto: 'Nuevo inicio de sesión en el Gestor de incidencias',
    bloques: [
      { tipo: 'titulo', texto: 'Nuevo inicio de sesión' },
      { tipo: 'texto', texto: 'Se ha iniciado sesión como ' + negrita(usuario) + '.' },
      { tipo: 'tabla', filas: [['Cuándo', cuando], ['Desde', String(datos.ip || '')], ['Navegador', String(datos.navegador || '')]] },
      { tipo: 'texto', texto: 'Si has sido tú, no tienes que hacer nada. Si no, cambia la contraseña en Ajustes cuanto antes: al hacerlo se cierran las demás sesiones.' },
      ...abrirGestor('', 'Abrir el gestor')
    ]
  });
}

function claveCambiada(para, usuario) {
  return enviar({
    para,
    asunto: 'Tu contraseña se ha cambiado',
    bloques: [
      { tipo: 'titulo', texto: 'Tu contraseña se ha cambiado' },
      { tipo: 'texto', texto: 'La contraseña del usuario ' + negrita(usuario) + ' se acaba de cambiar y se han cerrado las demás sesiones.\n\n' +
        'Si no has sido tú, entra en la pantalla de inicio y usa «He olvidado la contraseña» para recuperarla.' },
      ...abrirGestor('/login', 'Ir a la pantalla de entrada')
    ]
  });
}

function prueba(para) {
  return enviar({
    para,
    asunto: 'Prueba de correo del Gestor de incidencias',
    bloques: [
      { tipo: 'titulo', texto: 'El correo funciona' },
      { tipo: 'texto', texto: 'Este es un mensaje de prueba enviado desde el Gestor de incidencias.' }
    ]
  });
}

module.exports = {
  activo, enviar, emailValido, URL_PORTAL, abrirGestor,
  htmlPersonal, personal, recuperacion, avisoAcceso, claveCambiada, prueba
};
