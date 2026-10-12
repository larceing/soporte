// Migración única desde la hoja de Google del Gestor de peticiones.
//
// Lee los CSV exportados de las hojas MacroData, Clientes, Pagos y Peticiones
// y los carga en el portal. Cada petición con tiempo pasa a ser una incidencia
// resuelta en MantisBT con una sesión de trabajo. Se puede repetir: lo que ya
// está migrado (por su código PET-/COB-/PAG-) se salta.
//
//   docker compose exec portal node scripts/migrar-hoja.js /migracion

const fs = require('fs');
const path = require('path');
const { consulta, migrar, pool } = require('../src/db');
const mantis = require('../src/mantis');
const fact = require('../src/facturacion');

const carpeta = process.argv[2] || '/migracion';
const ZONA = 'Europe/Madrid';

function leerCsv(nombre) {
  const texto = fs.readFileSync(path.join(carpeta, nombre + '.csv'), 'utf8').replace(/^﻿/, '');
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];

    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }

  const cabecera = filas.shift().map(h => h.trim());
  return filas
    .filter(f => f.some(v => v !== ''))
    .map(f => Object.fromEntries(cabecera.map((h, i) => [h, (f[i] || '').trim()])));
}

// Desfase de España respecto a UTC, en milisegundos, en un instante dado.
function desfase(instante) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: ZONA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(instante)).forEach(x => { p[x.type] = Number(x.value); });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instante;
}

// 'D/MM/AAAA' o 'D/MM/AAAA H:MM:SS' en hora de España -> { dia, instante }.
// Sin hora se toma el mediodía.
function fecha(valor) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(valor || '');
  if (!m) return null;

  const [d, mes, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const local = Date.UTC(a, mes - 1, d, m[4] === undefined ? 12 : Number(m[4]), Number(m[5] || 0), Number(m[6] || 0));

  return {
    dia: a + '-' + String(mes).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
    instante: local - desfase(local)
  };
}

function numero(valor) {
  return Number(String(valor || '0').replace(',', '.')) || 0;
}

async function existe(tabla, codigo) {
  return (await consulta('SELECT id FROM ' + tabla + ' WHERE codigo = ?', [codigo]))[0];
}

// MantisBT fecha todo con el momento de la llamada. Para que el historial
// conserve las fechas reales se corrigen aquí, una sola vez, en sus tablas.
async function fechar(incidenciaId, notaId, inicio, fin) {
  const [ti, tf] = [Math.floor(inicio / 1000), Math.floor(fin / 1000)];
  await consulta('UPDATE mantis_bug_table SET date_submitted = ?, last_updated = ? WHERE id = ?', [ti, tf, incidenciaId]);
  await consulta('UPDATE mantis_bugnote_table SET date_submitted = ?, last_modified = ? WHERE id = ?', [tf, tf, notaId]);
  await consulta('UPDATE mantis_bug_history_table SET date_modified = ? WHERE bug_id = ?', [tf, incidenciaId]);
  await consulta("UPDATE mantis_bug_history_table SET date_modified = ? WHERE bug_id = ? AND type = 1", [ti, incidenciaId]);
}

async function main() {
  await migrar();
  const resumen = { config: 0, clientes: 0, pagos: 0, incidencias: 0, gastos: 0, saltados: 0, descartados: 0 };

  // Configuración
  // Solo los ajustes que aún no existan: repetir la migración nunca pisa lo
  // que se haya cambiado después en Ajustes.
  const guardados = new Set((await consulta('SELECT clave FROM ha_config')).map(f => f.clave));
  const config = {};
  leerCsv('MacroData').forEach(f => { if (!guardados.has(f.clave)) config[f.clave] = f.valor; });
  const admitidos = await fact.config();
  await fact.configGuardar(config);
  resumen.config = Object.keys(admitidos).filter(k => config[k] !== undefined).length;

  // Clientes
  const clientes = {};
  for (const f of leerCsv('Clientes')) {
    if (!f.empresa) continue;
    const [previo] = await consulta('SELECT id, nif, direccion, razon_social FROM ha_cliente WHERE nombre = ?', [f.empresa]);

    if (!previo) {
      await fact.clienteGuardar({
        nombre: f.empresa, tarifa_hora: f.tarifa_hora, telefono: f.telefono_whatsapp,
        email: f.email, contacto: f.contacto, notas: f.notas,
        nif: f.nif, direccion: f.direccion_fiscal, razon_social: f.razon_social
      });
      resumen.clientes++;
    } else {
      // Completa los datos fiscales que falten, sin pisar lo ya escrito.
      await consulta(
        'UPDATE ha_cliente SET nif = ?, direccion = ?, razon_social = ? WHERE id = ?',
        [previo.nif || f.nif || '', previo.direccion || f.direccion_fiscal || '',
          previo.razon_social || f.razon_social || '', previo.id]
      );
    }
  }
  (await consulta('SELECT id, nombre FROM ha_cliente')).forEach(c => { clientes[c.nombre.toLowerCase()] = c.id; });

  // Cobros
  const pagos = {};
  for (const f of leerCsv('Pagos')) {
    let pago = await existe('ha_pago', f.id);
    if (!pago) {
      const resultado = await consulta(
        `INSERT INTO ha_pago (codigo, cliente_id, fecha_pago, periodo_desde, periodo_hasta, importe,
                              metodo, concepto, observaciones, creado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.id, clientes[f.empresa.toLowerCase()], fecha(f.fecha_pago).dia, fecha(f.periodo_desde).dia,
          fecha(f.periodo_hasta).dia, numero(f.importe), f.metodo, f.concepto, f.observaciones,
          new Date(fecha(f.creado_en).instante)]
      );
      pago = { id: resultado.insertId };
      resumen.pagos++;
    }
    pagos[f.id] = pago.id;
  }

  // Peticiones
  for (const f of leerCsv('Peticiones')) {
    if (f.estado === 'ELIMINADA' || f.estado === 'EN_CURSO') { resumen.descartados++; continue; }
    if (await existe('ha_trabajo', f.id)) { resumen.saltados++; continue; }

    const clienteId = clientes[f.empresa.toLowerCase()];
    const inicio = fecha(f.inicio);
    if (!clienteId || !inicio) { resumen.descartados++; console.warn('Sin cliente o fecha: ' + f.id); continue; }

    const minutos = Math.round(numero(f.minutos_reales));
    const esGasto = f.tipo === 'UNICO';
    let incidenciaId = null;
    let notaId = null;

    if (!esGasto) {
      const incidencia = await mantis.crear({
        tipo: 'Petición',
        titulo: f.peticion.slice(0, 120) || 'Petición',
        descripcion: f.observaciones || f.peticion
      });
      const nota = await mantis.anadirNota(incidencia.id, {
        texto: 'Sesión migrada del Gestor de peticiones (' + f.id + ').',
        minutos: Math.max(1, minutos)
      });
      await mantis.actualizar(incidencia.id, { estado: 'resolved' });

      incidenciaId = incidencia.id;
      notaId = nota.notaId;
      await fechar(incidenciaId, notaId, inicio.instante, inicio.instante + Math.max(1, minutos) * 60000);
      resumen.incidencias++;
    } else {
      resumen.gastos++;
    }

    await consulta(
      `INSERT INTO ha_trabajo (codigo, cliente_id, incidencia_id, nota_id, concepto, detalle, dia, minutos,
                               horas, tarifa, importe, tipo, estado, pago_id, creado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, clienteId, incidenciaId, notaId, f.peticion.slice(0, 255), f.observaciones, inicio.dia, minutos,
        numero(f.horas_facturadas), numero(f.tarifa_hora), numero(f.importe), esGasto ? 'UNICO' : 'TIEMPO',
        f.estado === 'NO_COBRAR' ? 'NO_COBRAR' : 'CERRADA', pagos[f.pago_id] || null,
        new Date((fecha(f.creado_en) || inicio).instante)]
    );
    process.stdout.write('.');
  }

  console.log('\nMigración terminada:', JSON.stringify(resumen));
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
