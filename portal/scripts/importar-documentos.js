// Importa los PDF de "Resumen de servicios" que el Gestor de peticiones guardó
// en Google Drive. Cada uno queda como documento histórico con su PDF original
// dentro de la base de datos. Se puede repetir: lo ya importado se salta.
//
// Espera en la carpeta un indice.json con { id, nombre, creado, desde, hasta,
// horas, base } por documento y un fichero <id>.pdf junto a él.
//
//   docker compose exec portal node scripts/importar-documentos.js /migracion/documentos

const fs = require('fs');
const path = require('path');
const { consulta, migrar, pool } = require('../src/db');
const { diaLocal } = require('../src/util');

const carpeta = process.argv[2] || '/migracion/documentos';
const SERIE = 'RS';

async function main() {
  await migrar();

  const indice = JSON.parse(fs.readFileSync(path.join(carpeta, 'indice.json'), 'utf8'))
    .sort((a, b) => a.creado.localeCompare(b.creado));
  const [cliente] = await consulta('SELECT id, nombre FROM ha_cliente WHERE activo = 1 ORDER BY id LIMIT 1');
  if (!cliente) throw new Error('No hay ningún cliente: ejecuta antes migrar-hoja.js.');

  let importados = 0;
  let saltados = 0;

  for (const doc of indice) {
    const ya = await consulta('SELECT 1 FROM ha_documento_pdf WHERE nombre = ?', [doc.id + '.pdf']);
    if (ya.length) { saltados++; continue; }

    const contenido = fs.readFileSync(path.join(carpeta, doc.id + '.pdf'));
    const emision = diaLocal(new Date(doc.creado));
    const anio = Number(emision.slice(0, 4));
    const [{ maximo }] = await consulta(
      "SELECT COALESCE(MAX(numero), 0) AS maximo FROM ha_documento WHERE tipo = 'RESUMEN' AND serie = ? AND anio = ?",
      [SERIE, anio]
    );
    const numero = Number(maximo) + 1;

    const resultado = await consulta(
      `INSERT INTO ha_documento (tipo, codigo, serie, anio, numero, fecha_emision, cliente_id, cliente_nombre,
                                 periodo_desde, periodo_hasta, base, iva_pct, iva_importe, irpf_pct, irpf_importe,
                                 total, estado, datos_json, creado_en)
       VALUES ('RESUMEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, 'HISTORICO', ?, ?)`,
      [SERIE + '-' + anio + '-' + String(numero).padStart(4, '0'), SERIE, anio, numero, emision, cliente.id,
        cliente.nombre, doc.desde, doc.hasta, doc.base, doc.base,
        JSON.stringify({ moneda: '€', lineas: [], horas: doc.horas, nombrePdf: doc.nombre, driveId: doc.id }),
        new Date(doc.creado)]
    );

    await consulta('INSERT INTO ha_documento_pdf (documento_id, nombre, contenido) VALUES (?, ?, ?)',
      [resultado.insertId, doc.id + '.pdf', contenido]);
    importados++;
  }

  console.log('Documentos importados: ' + importados + ', ya estaban: ' + saltados);
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
