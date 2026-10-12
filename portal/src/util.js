const ZONA = 'Europe/Madrid';

class ErrorUsuario extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.status = status || 400;
  }
}

// Día del calendario en España ('AAAA-MM-DD') de un instante.
function diaLocal(fecha) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA }).format(fecha || new Date());
}

// 'AAAAMMDD-HHMMSS' en hora de España, para los códigos legibles.
function selloLocal(fecha) {
  const p = {};
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(fecha || new Date()).forEach(x => { p[x.type] = x.value; });
  return p.year + p.month + p.day + '-' + p.hour + p.minute + p.second;
}

function esDia(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''));
}

// 'AAAA-MM-DD' -> 'DD/MM/AAAA'
function diaCorto(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dia || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(dia || '');
}

// Redondeo a céntimos simétrico: una rectificativa debe dar exactamente el
// importe de su factura en negativo.
function redondear(n) {
  const valor = Number(n || 0);
  return Math.sign(valor) * Math.round((Math.abs(valor) + Number.EPSILON) * 100) / 100;
}

function texto(valor, max) {
  return String(valor == null ? '' : valor).trim().slice(0, max);
}

// Ejecuta las acciones de una en una: evita que dos documentos pidan el mismo
// número a la vez (el LockService del gestor antiguo).
let cola = Promise.resolve();
function enSerie(accion) {
  const resultado = cola.then(accion);
  cola = resultado.catch(() => {});
  return resultado;
}

// Express 4 no recoge los errores de funciones async: este envoltorio los
// pasa al manejador de errores común.
function ruta(fn) {
  return (req, res, next) => fn(req, res).catch(next);
}

module.exports = { ErrorUsuario, diaLocal, selloLocal, esDia, diaCorto, redondear, texto, enSerie, ruta };
