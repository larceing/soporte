// Gestor de tareas: cada incidencia abierta tiene su tarea allí, sola. Usa la API normal de Tareas
// (cabecera X-API-Key, con una llave creada en Tareas → Configuración → API):
//   - incidencia abierta sin tarea → se crea la tarea en el proyecto elegido;
//   - cambian título, prioridad o fecha límite → se cambian en la tarea;
//   - se resuelve o se cierra → la tarea pasa a la columna de hechas; si se reabre, vuelve a la primera.
// Las horas se siguen apuntando aquí: son las que llegan a Sindri.
//
// Dónde está Tareas, su llave y el proyecto: TAREAS_URL, TAREAS_LLAVE y TAREAS_PROYECTO en el
// entorno o, si no están, en Ajustes → Tareas (la llave se guarda en ha_config y no vuelve al navegador).

const crypto = require('crypto');
const { consulta } = require('./db');
const { CERRADAS } = require('./incidencias');
const { URL_PORTAL } = require('./correo');

const ESPERA = 5000;
const CADA = 10 * 60 * 1000;

let ultima = null;
let enCurso = null;
let pendienteOtra = false;
let temporizador = null;

// La dirección de la app (o de su API): se guarda sin /api ni barras finales.
const base = s => String(s || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');

async function conexion() {
  if (process.env.TAREAS_URL && process.env.TAREAS_LLAVE) {
    return { url: base(process.env.TAREAS_URL), llave: process.env.TAREAS_LLAVE.trim(), proyecto: (process.env.TAREAS_PROYECTO || '').trim(), desde: 'entorno' };
  }
  const filas = await consulta("SELECT clave, valor FROM ha_config WHERE clave IN ('TAREAS_URL', 'TAREAS_LLAVE', 'TAREAS_PROYECTO')");
  const v = Object.fromEntries(filas.map(f => [f.clave, f.valor]));
  return { url: base(v.TAREAS_URL), llave: v.TAREAS_LLAVE || '', proyecto: v.TAREAS_PROYECTO || '', desde: v.TAREAS_URL && v.TAREAS_LLAVE ? 'ajustes' : null };
}

async function guardarConexion({ url, llave, proyecto, quitar }) {
  const poner = (clave, valor) => consulta(
    'INSERT INTO ha_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [clave, valor]
  );
  if (quitar) {
    await consulta("DELETE FROM ha_config WHERE clave = 'TAREAS_LLAVE'");
    ultima = null;
    return estado();
  }
  if (url !== undefined) {
    const u = base(url);
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) {
      const e = new Error('La dirección de Tareas debe empezar por http:// o https://');
      e.status = 400;
      throw e;
    }
    // Una llave guardada no viaja a otra dirección: si cambia la URL y no llega llave nueva,
    // se borra la de antes y hay que escribirla otra vez.
    const antes = (await consulta("SELECT clave, valor FROM ha_config WHERE clave IN ('TAREAS_URL')")).find(f => f.clave === 'TAREAS_URL');
    const nueva = u.slice(0, 500);
    if (antes && antes.valor && base(antes.valor) !== nueva && !(llave && String(llave).trim())) {
      await consulta("DELETE FROM ha_config WHERE clave = 'TAREAS_LLAVE'");
    }
    await poner('TAREAS_URL', nueva);
  }
  if (proyecto !== undefined) await poner('TAREAS_PROYECTO', String(proyecto).trim().slice(0, 100));
  if (llave && String(llave).trim()) await poner('TAREAS_LLAVE', String(llave).trim().slice(0, 200));
  ultima = null;
  programar();
  return estado();
}

async function llamar(c, metodo, ruta, cuerpo) {
  const r = await fetch(c.url + '/api' + ruta, {
    method: metodo,
    headers: { 'X-API-Key': c.llave, Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(r.status === 401 ? 'Tareas no acepta la llave (no es válida o está revocada).' : (datos.detail || datos.error || 'Tareas ha respondido ' + r.status + '.'));
    e.status = r.status;
    throw e;
  }
  return datos;
}

const PRIORIDAD = { immediate: 'Alta', urgent: 'Alta', high: 'Alta', low: 'Baja' };
const dia = d => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : '');

// Lo que la tarea dice de su incidencia. Si cambia, se manda otra vez.
function datosTarea(i) {
  return {
    titulo: (i.codigo ? i.codigo + ' · ' : '') + i.titulo,
    prioridad: PRIORIDAD[i.prioridad] || 'Normal',
    fecha_fin: dia(i.limite)
  };
}
const huella = d => crypto.createHash('sha1').update(JSON.stringify([d.titulo, d.prioridad, d.fecha_fin])).digest('hex');

async function enviar() {
  const c = await conexion();
  if (!c.url || !c.llave) return null;
  const inicio = new Date();
  const cuenta = { creadas: 0, cambiadas: 0, cerradas: 0, reabiertas: 0 };
  const errores = [];
  try {
    if (!c.proyecto) throw Object.assign(new Error('Falta elegir el proyecto de Tareas donde caen las incidencias.'), { status: 400 });
    const dims = await llamar(c, 'GET', '/dimensiones/');
    const proyecto = (dims.proyectos || []).find(p => p.id === c.proyecto || p.nombre === c.proyecto);
    if (!proyecto) {
      throw Object.assign(new Error('Tareas no tiene el proyecto «' + c.proyecto + '». Hay: ' +
        (dims.proyectos || []).map(p => p.id).join(', ') + '.'), { status: 400 });
    }
    const columnas = proyecto.columnas || [];
    const hecha = (proyecto.hechas && proyecto.hechas[0]) || columnas[columnas.length - 1];
    const primera = columnas.find(x => x !== hecha) || columnas[0];

    const filas = await consulta(
      `SELECT id, codigo, tipo, titulo, descripcion, estado, prioridad, limite, tarea_id, tarea_estado, tarea_huella
         FROM ha_incidencia WHERE dueno = '' AND (tarea_id IS NOT NULL OR estado NOT IN (?)) ORDER BY id`,
      [CERRADAS]
    );
    for (const i of filas) {
      const abierta = !CERRADAS.includes(i.estado);
      const d = datosTarea(i);
      try {
        if (!i.tarea_id) {
          const enlace = URL_PORTAL ? '\n\nIncidencia: ' + URL_PORTAL + '/#incidencia-' + i.id : '';
          const r = await llamar(c, 'POST', '/tareas/', {
            proyecto_id: proyecto.id, ...d, fecha_fin: d.fecha_fin || undefined,
            descripcion: String(i.descripcion || '').slice(0, 20000) + enlace
          });
          await consulta('UPDATE ha_incidencia SET tarea_id = ?, tarea_estado = ?, tarea_huella = ? WHERE id = ?', [String(r.id), 'abierta', huella(d), i.id]);
          cuenta.creadas++;
          continue;
        }
        if (i.tarea_estado === 'borrada') continue;
        if (abierta && huella(d) !== i.tarea_huella) {
          await llamar(c, 'POST', '/tareas/' + encodeURIComponent(i.tarea_id) + '/', { ...d, fecha_fin: d.fecha_fin || null });
          await consulta('UPDATE ha_incidencia SET tarea_huella = ? WHERE id = ?', [huella(d), i.id]);
          cuenta.cambiadas++;
        }
        if (!abierta && i.tarea_estado !== 'cerrada' && hecha) {
          await llamar(c, 'POST', '/tareas/' + encodeURIComponent(i.tarea_id) + '/mover/', { status: hecha });
          await consulta('UPDATE ha_incidencia SET tarea_estado = ? WHERE id = ?', ['cerrada', i.id]);
          cuenta.cerradas++;
        } else if (abierta && i.tarea_estado === 'cerrada' && primera) {
          await llamar(c, 'POST', '/tareas/' + encodeURIComponent(i.tarea_id) + '/mover/', { status: primera });
          await consulta('UPDATE ha_incidencia SET tarea_estado = ? WHERE id = ?', ['abierta', i.id]);
          cuenta.reabiertas++;
        }
      } catch (e) {
        // Una tarea borrada en Tareas no se vuelve a crear ni se toca.
        if (e.status === 404 && i.tarea_id) {
          await consulta('UPDATE ha_incidencia SET tarea_estado = ? WHERE id = ?', ['borrada', i.id]);
        } else if (e.status && e.status !== 401) {
          errores.push({ ref: i.codigo || String(i.id), error: e.message });
        } else {
          throw e;
        }
      }
    }
    ultima = { ok: true, cuando: inicio.toISOString(), proyecto: proyecto.nombre || proyecto.id, ...cuenta, errores: errores.slice(0, 50) };
  } catch (e) {
    ultima = { ok: false, cuando: inicio.toISOString(), error: e.name === 'TimeoutError' ? 'Tareas no responde.' : (e.cause ? 'No se puede conectar con Tareas en ' + c.url + '.' : e.message) };
    if (!e.status) console.error('Tareas: ' + (e.cause ? e.cause.message : e.message));
  }
  return ultima;
}

// Un envío cada vez; si llega un cambio mientras tanto, se repite al terminar.
async function sincronizar() {
  if (enCurso) { pendienteOtra = true; return enCurso; }
  enCurso = enviar().finally(() => {
    enCurso = null;
    if (pendienteOtra) { pendienteOtra = false; programar(); }
  });
  return enCurso;
}

function programar() {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => sincronizar().catch(() => {}), ESPERA);
  temporizador.unref?.();
}

function arrancar() {
  programar();
  setInterval(() => sincronizar().catch(() => {}), CADA).unref?.();
}

async function estado() {
  const c = await conexion();
  return { configurado: Boolean(c.url && c.llave), url: c.url || '', proyecto: c.proyecto || '', desde: c.desde, ultima };
}

module.exports = { arrancar, programar, sincronizar, estado, guardarConexion };
