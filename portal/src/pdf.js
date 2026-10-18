// PDF de un documento (proforma, factura, resumen…) para adjuntarlo a un correo
// o descargarlo. Sale de la misma página imprimible que se ve en pantalla
// (documento-html.js), impresa por Chromium sin ventana: un solo diseño.
//
// La imagen trae Chromium (Dockerfile). Fuera de ella, CHROMIUM_RUTA dice dónde está.

const fs = require('fs');
const path = require('path');
const { ErrorUsuario } = require('./util');

const RUTAS = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'];
const CERRAR_TRAS_MS = 5 * 60 * 1000;

let navegador = null;
let arrancando = null;
let temporizador = null;

function rutaChromium() {
  if (process.env.CHROMIUM_RUTA) return process.env.CHROMIUM_RUTA;
  return RUTAS.find(r => fs.existsSync(r)) || '';
}

// El logo va dentro del HTML: la página se imprime sin pedir nada a la red.
let logo = null;
function logoEnLinea() {
  if (logo === null) {
    const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'monograma.svg'));
    logo = 'data:image/svg+xml;base64,' + svg.toString('base64');
  }
  return logo;
}

async function abrir() {
  if (navegador && navegador.connected) return navegador;
  if (arrancando) return arrancando;

  const ruta = rutaChromium();
  if (!ruta) throw new ErrorUsuario('Este servidor no tiene Chromium para generar el PDF.', 503);

  const puppeteer = require('puppeteer-core');
  arrancando = puppeteer.launch({
    executablePath: ruta,
    headless: true,
    // Dentro del contenedor no hay espacio de nombres para su sandbox; lo que
    // imprime es solo HTML propio, sin JavaScript ni red.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--font-render-hinting=none']
  }).then(b => {
    navegador = b;
    b.on('disconnected', () => { if (navegador === b) navegador = null; });
    return b;
  }).finally(() => { arrancando = null; });
  return arrancando;
}

// Se cierra solo si nadie lo usa en un rato: no ocupa memoria sin motivo.
function cerrarLuego() {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    const b = navegador;
    navegador = null;
    if (b) b.close().catch(() => {});
  }, CERRAR_TRAS_MS);
  temporizador.unref();
}

async function deHtml(html) {
  const b = await abrir();
  const pagina = await b.newPage();
  try {
    await pagina.setJavaScriptEnabled(false);
    await pagina.setRequestInterception(true);
    pagina.on('request', r => (r.url().startsWith('data:') ? r.continue() : r.abort()));
    await pagina.setContent(html, { waitUntil: 'load', timeout: 20000 });
    await pagina.emulateMediaType('print');
    return Buffer.from(await pagina.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 20000 }));
  } finally {
    await pagina.close().catch(() => {});
    cerrarLuego();
  }
}

module.exports = { deHtml, logoEnLinea };
