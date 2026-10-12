// Resumen mensual por correo: qué hay abierto, qué queda por cobrar y cuánto
// se trabajó el mes anterior. Se envía solo el día 1 a partir de las 8:00
// (hora de España) y también se puede pedir a mano desde Ajustes.

const { consulta } = require('./db');
const mantis = require('./mantis');
const fact = require('./facturacion');
const correo = require('./correo');
const { diaLocal, diaCorto, redondear } = require('./util');

const CLAVE_ULTIMO = 'RESUMEN_ULTIMO_ENVIO';
const HORA_ENVIO = 8;

function dinero(valor, moneda) {
  const partes = Number(valor || 0).toFixed(2).split('.');
  return partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + partes[1] + ' ' + (moneda || '€');
}

// Primer y último día del mes anterior al día dado ('AAAA-MM-DD').
function mesAnterior(hoy) {
  const [anio, mes] = hoy.split('-').map(Number);
  const a = mes === 1 ? anio - 1 : anio;
  const m = mes === 1 ? 12 : mes - 1;
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return {
    desde: a + '-' + mm + '-01',
    hasta: a + '-' + mm + '-' + String(ultimo).padStart(2, '0'),
    nombre: new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(a, m - 1, 1)))
  };
}

async function datos() {
  const hoy = diaLocal();
  const mes = mesAnterior(hoy);
  const cfg = await fact.config();

  // Si el motor de incidencias no responde, el resumen sale igual con los cobros.
  let incidencias = null;
  try {
    incidencias = await mantis.listar();
  } catch (e) {
    incidencias = null;
  }

  const abiertas = incidencias ? incidencias.filter(i => i.abierta) : [];
  const pendientes = await fact.trabajos({ cobro: 'PENDIENTE' });
  const delMes = (await fact.trabajos({ desde: mes.desde, hasta: mes.hasta })).filter(t => t.estado !== 'NO_COBRAR');
  const documentos = await fact.documentos();

  return {
    hoy: hoy,
    mes: mes,
    moneda: cfg.MONEDA || '€',
    incidenciasDisponibles: Boolean(incidencias),
    abiertas: abiertas.length,
    esperando: abiertas.filter(i => i.estado === 'feedback').length,
    vencidas: abiertas.filter(i => i.limite && i.limite < hoy),
    urgentes: abiertas.filter(i => ['high', 'urgent', 'immediate'].includes(i.prioridad)),
    pendiente: {
      registros: pendientes.length,
      importe: redondear(pendientes.reduce((s, t) => s + Number(t.importe), 0)),
      horas: pendientes.reduce((s, t) => s + Number(t.horas), 0),
      desde: pendientes.length ? pendientes[pendientes.length - 1].dia : ''
    },
    trabajado: {
      registros: delMes.length,
      minutos: delMes.reduce((s, t) => s + Number(t.minutos), 0),
      horas: delMes.reduce((s, t) => s + Number(t.horas), 0),
      importe: redondear(delMes.reduce((s, t) => s + Number(t.importe), 0))
    },
    proformasPendientes: documentos.filter(d => d.tipo === 'PROFORMA' && d.estado === 'PENDIENTE'),
    facturasSinCobrar: documentos.filter(d => d.tipo === 'FACTURA' && d.estado === 'EMITIDA')
  };
}

function html(d) {
  const e = correo.esc;
  const eur = v => e(dinero(v, d.moneda));
  const fila = (nombre, valor) => '<tr><td style="padding:7px 0;color:#5B6877;">' + nombre + '</td>' +
    '<td style="padding:7px 0;text-align:right;font-weight:bold;white-space:nowrap;">' + valor + '</td></tr>';
  const tabla = filas => '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;border-top:1px solid #DDE3EA;">' + filas.join('') + '</table>';
  const titulo = t => '<strong style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#1D4F7A;">' + t + '</strong>';
  const lista = (items, texto) => items.slice(0, 8).map(texto).join('<br>') + (items.length > 8 ? '<br>… y ' + (items.length - 8) + ' más' : '');

  const bloques = [
    titulo('Pendiente de cobro') + tabla([
      fila('Importe pendiente', eur(d.pendiente.importe)),
      fila('Registros', d.pendiente.registros + (d.pendiente.desde ? ' (desde el ' + e(diaCorto(d.pendiente.desde)) + ')' : '')),
      fila('Horas facturables', d.pendiente.horas + ' h'),
      fila('Proformas sin confirmar', d.proformasPendientes.length),
      fila('Facturas emitidas sin cobrar', d.facturasSinCobrar.length +
        (d.facturasSinCobrar.length ? ' · ' + eur(d.facturasSinCobrar.reduce((s, f) => s + f.total, 0)) : ''))
    ]),

    titulo('Trabajo de ' + e(d.mes.nombre)) + tabla([
      fila('Sesiones y gastos', d.trabajado.registros),
      fila('Tiempo real', Math.round(d.trabajado.minutos / 6) / 10 + ' h'),
      fila('Horas facturables', d.trabajado.horas + ' h'),
      fila('Importe', eur(d.trabajado.importe))
    ])
  ];

  if (d.incidenciasDisponibles) {
    bloques.push(titulo('Incidencias') + tabla([
      fila('Abiertas', d.abiertas),
      fila('Esperando al cliente', d.esperando),
      fila('Vencidas', d.vencidas.length),
      fila('Prioridad alta o urgente', d.urgentes.length)
    ]));

    if (d.vencidas.length) {
      bloques.push(titulo('Vencidas') + '<br>' + lista(d.vencidas, i => e('#' + i.id + ' ' + i.titulo) + ' <span style="color:#9C2B24;">(límite ' + e(diaCorto(i.limite)) + ')</span>'));
    }
    if (d.urgentes.length) {
      bloques.push(titulo('Con prioridad alta') + '<br>' + lista(d.urgentes, i => e('#' + i.id + ' ' + i.titulo) + ' · ' + e(i.estadoTexto)));
    }
  } else {
    bloques.push('No se han podido consultar las incidencias en este momento; los datos de cobro sí son correctos.');
  }

  return correo.plantilla('Resumen del ' + diaCorto(d.hoy), bloques,
    correo.URL_PORTAL ? { url: correo.URL_PORTAL, texto: 'Abrir el gestor' } : null);
}

function texto(d) {
  return [
    'Resumen del ' + diaCorto(d.hoy),
    'Pendiente de cobro: ' + dinero(d.pendiente.importe, d.moneda) + ' en ' + d.pendiente.registros + ' registros (' + d.pendiente.horas + ' h).',
    'Proformas sin confirmar: ' + d.proformasPendientes.length + '. Facturas sin cobrar: ' + d.facturasSinCobrar.length + '.',
    'Trabajo de ' + d.mes.nombre + ': ' + d.trabajado.horas + ' h facturables, ' + dinero(d.trabajado.importe, d.moneda) + '.',
    d.incidenciasDisponibles
      ? 'Incidencias abiertas: ' + d.abiertas + ' (esperando al cliente ' + d.esperando + ', vencidas ' + d.vencidas.length + ').'
      : 'No se han podido consultar las incidencias.'
  ].join('\n');
}

async function enviar(para) {
  const d = await datos();
  return correo.enviar({
    para: para,
    asunto: 'Resumen mensual · ' + dinero(d.pendiente.importe, d.moneda) + ' pendientes de cobro',
    html: html(d),
    texto: texto(d)
  });
}

// Comprueba si toca el envío automático. Guarda el mes enviado para no
// repetirlo aunque el servidor se reinicie.
async function comprobar() {
  if (!correo.activo()) return;

  const ahora = new Date();
  const hoy = diaLocal(ahora);
  const hora = Number(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(ahora));
  if (hoy.slice(8) !== '01' || hora < HORA_ENVIO) return;

  const mes = hoy.slice(0, 7);
  const [ultimo] = await consulta('SELECT valor FROM ha_config WHERE clave = ?', [CLAVE_ULTIMO]);
  if (ultimo && ultimo.valor === mes) return;

  const destinatarios = await consulta("SELECT email FROM ha_usuario WHERE email <> ''");
  if (!destinatarios.length) return;

  // Se marca antes de enviar: es preferible perder un resumen que mandarlo en bucle.
  await consulta('INSERT INTO ha_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [CLAVE_ULTIMO, mes]);
  for (const d of destinatarios) {
    const r = await enviar(d.email);
    console.log('Resumen mensual a ' + d.email + ': ' + (r.enviado ? 'enviado' : r.motivo));
  }
}

function programar() {
  const revisar = () => comprobar().catch(e => console.error('Resumen mensual: ' + e.message));
  setTimeout(revisar, 60 * 1000);
  setInterval(revisar, 15 * 60 * 1000);
}

module.exports = { datos, enviar, programar };
