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

// El resumen en bloques de Mail: tablas de cifras y listas.
function bloques(d) {
  const eur = v => dinero(v, d.moneda);
  const lista = (items, texto) => items.slice(0, 8).map(i => '- ' + texto(i)).join('\n') +
    (items.length > 8 ? '\n- … y ' + (items.length - 8) + ' más' : '');

  const b = [
    { tipo: 'titulo', texto: 'Resumen del ' + diaCorto(d.hoy) },
    { tipo: 'tabla', titulo: 'Pendiente de cobro', filas: [
      ['Importe pendiente', eur(d.pendiente.importe)],
      ['Registros', d.pendiente.registros + (d.pendiente.desde ? ' (desde el ' + diaCorto(d.pendiente.desde) + ')' : '')],
      ['Horas facturables', d.pendiente.horas + ' h'],
      ['Proformas sin confirmar', String(d.proformasPendientes.length)],
      ['Facturas emitidas sin cobrar', d.facturasSinCobrar.length +
        (d.facturasSinCobrar.length ? ' · ' + eur(d.facturasSinCobrar.reduce((s, f) => s + f.total, 0)) : '')]
    ] },
    { tipo: 'tabla', titulo: 'Trabajo de ' + d.mes.nombre, filas: [
      ['Sesiones y gastos', String(d.trabajado.registros)],
      ['Tiempo real', Math.round(d.trabajado.minutos / 6) / 10 + ' h'],
      ['Horas facturables', d.trabajado.horas + ' h'],
      ['Importe', eur(d.trabajado.importe)]
    ] }
  ];

  if (d.incidenciasDisponibles) {
    b.push({ tipo: 'tabla', titulo: 'Incidencias', filas: [
      ['Abiertas', String(d.abiertas)],
      ['Esperando al cliente', String(d.esperando)],
      ['Vencidas', String(d.vencidas.length)],
      ['Prioridad alta o urgente', String(d.urgentes.length)]
    ] });
    if (d.vencidas.length) {
      b.push({ tipo: 'texto', texto: '**Vencidas**\n\n' + lista(d.vencidas, i => '#' + i.id + ' ' + i.titulo + ' (límite ' + diaCorto(i.limite) + ')') });
    }
    if (d.urgentes.length) {
      b.push({ tipo: 'texto', texto: '**Con prioridad alta**\n\n' + lista(d.urgentes, i => '#' + i.id + ' ' + i.titulo + ' · ' + i.estadoTexto) });
    }
  } else {
    b.push({ tipo: 'texto', texto: 'No se han podido consultar las incidencias en este momento; los datos de cobro sí son correctos.' });
  }

  return b.concat(correo.abrirGestor('', 'Abrir el gestor'));
}

async function enviar(para) {
  const d = await datos();
  return correo.enviar({
    para: para,
    asunto: 'Resumen mensual · ' + dinero(d.pendiente.importe, d.moneda) + ' pendientes de cobro',
    bloques: bloques(d)
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

module.exports = { datos, enviar, programar, bloques };
