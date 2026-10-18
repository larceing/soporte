// El portal puede vivir bajo una ruta (dev.<dominio>/soporte/) o en la raíz de
// su propio dominio. La entrada del servidor DEV/PRO quita el prefijo antes de
// pasarle la petición y lo manda en X-Forwarded-Prefix; sin esa cabecera
// (dominio propio, entorno local) el prefijo es vacío. Las páginas usan
// direcciones relativas, así que el prefijo solo hace falta en lo que escribe
// el servidor: redirecciones, cookie y el logotipo de los documentos.

const PREFIJO_VALIDO = /^(\/[A-Za-z0-9._-]+)*$/;

function prefijoDe(req) {
  const valor = String(req.headers['x-forwarded-prefix'] || '').trim().replace(/\/+$/, '');
  return PREFIJO_VALIDO.test(valor) ? valor : '';
}

// Antepone el prefijo a una dirección local absoluta ('/login' -> '/soporte/login').
function conPrefijo(prefijo, url) {
  if (!prefijo || typeof url !== 'string') return url;
  if (url.startsWith('/') && !url.startsWith('//') && url !== prefijo && !url.startsWith(prefijo + '/')) {
    return prefijo + url;
  }
  return url;
}

module.exports = { prefijoDe, conPrefijo };
