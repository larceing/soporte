// Copia única de las incidencias de MantisBT a las tablas del portal.
//
// Se hace sola al arrancar, una vez por base de datos: lee todo por la API de
// MantisBT con mantis.js (la misma traducción que el portal mostraba hasta
// ahora) y lo guarda de una vez, en una sola transacción. Conserva los números
// de incidencia, nota y adjunto, porque las sesiones de trabajo y los correos
// apuntan a ellos. Las tablas mantis_* no se tocan: quedan como respaldo.
//
// Mientras no esté copiado, las incidencias responden con un aviso (503) en
// lugar de una lista vacía.

const { consulta, pool } = require('./db');
const incidencias = require('./incidencias');

const MARCA = 'incidencias_copiadas_de_mantis';

async function hayTablaMantis() {
  const filas = await consulta(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'mantis_bug_table'"
  );
  return Number(filas[0].n) > 0;
}

// El siguiente número libre tiene que pasar de todo lo que MantisBT llegó a
// usar, también de lo borrado, para que no se repita ninguno.
async function maximoMantis(tabla) {
  const filas = await consulta('SELECT COALESCE(MAX(id), 0) AS n FROM ' + tabla);
  return Number(filas[0].n);
}

// Lee todo de MantisBT antes de escribir nada.
async function leer(mantis) {
  const lista = await mantis.listar();
  const todas = [];
  for (const { id } of lista) {
    const inc = await mantis.obtener(id);
    for (const adj of inc.adjuntos) {
      adj.contenido = (await mantis.adjunto(inc.id, adj.id)).contenido;
    }
    todas.push(inc);
  }
  return todas;
}

const fecha = (texto) => new Date(texto);

async function guardar(todas) {
  const con = await pool.getConnection();
  try {
    await con.beginTransaction();
    for (const i of todas) {
      await con.query(
        `INSERT INTO ha_incidencia (id, codigo, tipo, titulo, descripcion, estado, prioridad, limite, creada, actualizada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [i.id, i.codigo, i.tipo, i.titulo, i.descripcion, i.estado, i.prioridad, i.limite || null, fecha(i.creada), fecha(i.actualizada)]
      );
      for (const n of i.notas) {
        await con.query('INSERT INTO ha_nota (id, incidencia_id, texto, minutos, autor, fecha) VALUES (?, ?, ?, ?, ?, ?)',
          [n.id, i.id, n.texto, n.minutos, n.autor, fecha(n.fecha)]);
      }
      for (const a of i.adjuntos) {
        await con.query('INSERT INTO ha_adjunto (id, incidencia_id, nombre, bytes, contenido, fecha) VALUES (?, ?, ?, ?, ?, ?)',
          [a.id, i.id, a.nombre, a.contenido.length, a.contenido, fecha(a.fecha)]);
      }
      // La resolución era cosa interna de MantisBT: el estado ya lo dice.
      for (const c of i.cambios.filter(c => c.campo !== 'Resolución')) {
        await con.query('INSERT INTO ha_cambio (incidencia_id, fecha, campo, antes, despues) VALUES (?, ?, ?, ?, ?)',
          [i.id, fecha(c.fecha), c.campo, c.antes, c.despues]);
      }
    }
    await con.query('INSERT INTO ha_config (clave, valor) VALUES (?, ?)',
      [MARCA, new Date().toISOString() + ' · ' + todas.length + ' incidencias']);
    await con.commit();
  } catch (e) {
    await con.rollback().catch(() => {});
    throw e;
  } finally {
    con.release();
  }
}

async function siguientes() {
  for (const [nuestra, suya] of [['ha_incidencia', 'mantis_bug_table'], ['ha_nota', 'mantis_bugnote_table'], ['ha_adjunto', 'mantis_bug_file_table']]) {
    const n = Math.max(await maximoMantis(suya), await maximoMantis(nuestra)) + 1;
    await consulta('ALTER TABLE ' + nuestra + ' AUTO_INCREMENT = ' + n);
  }
}

async function copiar() {
  const hecho = await consulta('SELECT valor FROM ha_config WHERE clave = ?', [MARCA]);
  if (hecho.length) return;

  // Instalación nueva, sin MantisBT: no hay nada que copiar.
  if (!(await hayTablaMantis()) || !(await maximoMantis('mantis_bug_table'))) {
    await consulta('INSERT INTO ha_config (clave, valor) VALUES (?, ?)', [MARCA, new Date().toISOString() + ' · sin MantisBT']);
    return;
  }

  if (!process.env.MANTIS_API_TOKEN) {
    throw new Error('Hay incidencias en MantisBT sin copiar y falta MANTIS_API_TOKEN para leerlas.');
  }

  const yaHay = await consulta('SELECT COUNT(*) AS n FROM ha_incidencia');
  if (Number(yaHay[0].n)) throw new Error('ha_incidencia ya tiene filas pero no consta la copia de MantisBT: revisar a mano.');

  const todas = await leer(require('./mantis'));
  await guardar(todas);
  await siguientes();
  console.log('Copiadas ' + todas.length + ' incidencias de MantisBT a las tablas del portal.');
}

// Al arrancar: si la copia falla, el portal sigue en marcha (Cobros, Correo…)
// y las incidencias avisan del motivo hasta que se arregle y se reinicie.
async function alArrancar() {
  try {
    await copiar();
  } catch (e) {
    console.error('No se han podido copiar las incidencias de MantisBT: ' + e.message);
    incidencias.bloquear('Las incidencias no se han podido copiar de MantisBT (' + e.message + '). Avisa a IT.');
  }
}

module.exports = { copiar, alArrancar, MARCA };
