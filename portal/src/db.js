const mysql = require('mysql2/promise');

// El portal guarda todo en tablas con prefijo ha_, en la base de datos que
// antes compartía con MantisBT. Las tablas mantis_* no se tocan nunca desde
// aquí: solo se leen por la API de MantisBT para copiarlas (migrar-mantis.js).
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  timezone: 'Z',
  // Las fechas sin hora (periodos, día de un trabajo) viajan como 'AAAA-MM-DD'.
  dateStrings: ['DATE'],
  decimalNumbers: true
});

const TABLAS = [
  `CREATE TABLE IF NOT EXISTS ha_usuario (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     usuario VARCHAR(64) NOT NULL UNIQUE,
     clave_hash VARCHAR(255) NOT NULL,
     rol VARCHAR(16) NOT NULL DEFAULT 'admin',
     creado_en DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ha_sesion (
     token_hash CHAR(64) PRIMARY KEY,
     usuario_id INT UNSIGNED NOT NULL,
     caduca_en DATETIME NOT NULL,
     creado_en DATETIME NOT NULL,
     INDEX idx_ha_sesion_usuario (usuario_id)
   )`,
  // Un cronómetro en marcha por usuario, como la hoja "Estado" del gestor antiguo.
  `CREATE TABLE IF NOT EXISTS ha_cronometro (
     usuario_id INT UNSIGNED PRIMARY KEY,
     incidencia_id INT UNSIGNED NOT NULL,
     titulo VARCHAR(255) NOT NULL,
     inicio DATETIME NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ha_config (
     clave VARCHAR(64) PRIMARY KEY,
     valor TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ha_cliente (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     nombre VARCHAR(120) NOT NULL UNIQUE,
     razon_social VARCHAR(200) NOT NULL DEFAULT '',
     nif VARCHAR(32) NOT NULL DEFAULT '',
     direccion TEXT NOT NULL,
     tarifa_hora DECIMAL(10,2) NULL,
     telefono VARCHAR(64) NOT NULL DEFAULT '',
     email VARCHAR(200) NOT NULL DEFAULT '',
     contacto VARCHAR(200) NOT NULL DEFAULT '',
     notas TEXT NOT NULL,
     activo TINYINT(1) NOT NULL DEFAULT 1
   )`,
  // Lo facturable: una fila por sesión de trabajo (ligada a una nota con
  // tiempo) o por gasto suelto. Guarda el precio del momento.
  `CREATE TABLE IF NOT EXISTS ha_trabajo (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     codigo VARCHAR(40) NOT NULL UNIQUE,
     cliente_id INT UNSIGNED NOT NULL,
     incidencia_id INT UNSIGNED NULL,
     nota_id INT UNSIGNED NULL,
     concepto VARCHAR(255) NOT NULL,
     detalle TEXT NOT NULL,
     dia DATE NOT NULL,
     minutos INT UNSIGNED NOT NULL DEFAULT 0,
     horas DECIMAL(8,2) NOT NULL DEFAULT 0,
     tarifa DECIMAL(10,2) NOT NULL DEFAULT 0,
     importe DECIMAL(10,2) NOT NULL DEFAULT 0,
     tipo VARCHAR(16) NOT NULL DEFAULT 'TIEMPO',
     estado VARCHAR(16) NOT NULL DEFAULT 'CERRADA',
     pago_id INT UNSIGNED NULL,
     creado_en DATETIME NOT NULL,
     INDEX idx_ha_trabajo_dia (dia),
     INDEX idx_ha_trabajo_incidencia (incidencia_id)
   )`,
  `CREATE TABLE IF NOT EXISTS ha_pago (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     codigo VARCHAR(40) NOT NULL UNIQUE,
     cliente_id INT UNSIGNED NOT NULL,
     fecha_pago DATE NOT NULL,
     periodo_desde DATE NOT NULL,
     periodo_hasta DATE NOT NULL,
     importe DECIMAL(10,2) NOT NULL,
     metodo VARCHAR(64) NOT NULL DEFAULT '',
     concepto VARCHAR(255) NOT NULL DEFAULT '',
     observaciones TEXT NOT NULL,
     creado_en DATETIME NOT NULL
   )`,
  // Proformas, facturas y rectificativas. datos_json congela las líneas y los
  // datos fiscales del momento de la emisión.
  `CREATE TABLE IF NOT EXISTS ha_documento (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     tipo VARCHAR(16) NOT NULL,
     codigo VARCHAR(40) NOT NULL UNIQUE,
     serie VARCHAR(16) NOT NULL,
     anio SMALLINT UNSIGNED NOT NULL,
     numero INT UNSIGNED NOT NULL,
     fecha_emision DATE NOT NULL,
     cliente_id INT UNSIGNED NOT NULL,
     cliente_nombre VARCHAR(200) NOT NULL,
     periodo_desde DATE NOT NULL,
     periodo_hasta DATE NOT NULL,
     base DECIMAL(10,2) NOT NULL,
     iva_pct DECIMAL(5,2) NOT NULL,
     iva_importe DECIMAL(10,2) NOT NULL,
     irpf_pct DECIMAL(5,2) NOT NULL,
     irpf_importe DECIMAL(10,2) NOT NULL,
     total DECIMAL(10,2) NOT NULL,
     estado VARCHAR(16) NOT NULL,
     origen_id INT UNSIGNED NULL,
     pago_id INT UNSIGNED NULL,
     datos_json LONGTEXT NOT NULL,
     creado_en DATETIME NOT NULL,
     UNIQUE KEY uq_ha_documento_numero (tipo, serie, anio, numero)
   )`,
  // Correo del usuario, para recuperar la contraseña y avisar de los accesos.
  `ALTER TABLE ha_usuario ADD COLUMN IF NOT EXISTS email VARCHAR(200) NOT NULL DEFAULT ''`,
  // Enlaces de recuperación de contraseña: un solo uso y caducidad corta.
  `CREATE TABLE IF NOT EXISTS ha_recuperacion (
     token_hash CHAR(64) PRIMARY KEY,
     usuario_id INT UNSIGNED NOT NULL,
     caduca_en DATETIME NOT NULL
   )`,
  // Correos escritos a mano desde el portal, para saber qué se envió y a quién.
  `CREATE TABLE IF NOT EXISTS ha_correo (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     usuario_id INT UNSIGNED NOT NULL,
     incidencia_id INT UNSIGNED NULL,
     para VARCHAR(1000) NOT NULL,
     asunto VARCHAR(255) NOT NULL,
     mensaje MEDIUMTEXT NOT NULL,
     enviado_en DATETIME NOT NULL,
     INDEX idx_ha_correo_incidencia (incidencia_id)
   )`,
  // Correos que llevan el PDF de un documento: cuál y con qué nombre salió.
  `ALTER TABLE ha_correo ADD COLUMN IF NOT EXISTS documento_id INT UNSIGNED NULL`,
  `ALTER TABLE ha_correo ADD COLUMN IF NOT EXISTS adjunto VARCHAR(255) NOT NULL DEFAULT ''`,
  // PDF originales de documentos emitidos antes de existir el portal.
  `CREATE TABLE IF NOT EXISTS ha_documento_pdf (
     documento_id INT UNSIGNED PRIMARY KEY,
     nombre VARCHAR(255) NOT NULL,
     contenido LONGBLOB NOT NULL
   )`,
  // Las incidencias, antes en MantisBT. Los números de incidencia, nota y
  // adjunto se conservan al copiarlas, porque ha_trabajo y ha_correo los usan.
  `CREATE TABLE IF NOT EXISTS ha_incidencia (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     codigo VARCHAR(40) NOT NULL,
     tipo VARCHAR(40) NOT NULL,
     titulo VARCHAR(255) NOT NULL,
     descripcion MEDIUMTEXT NOT NULL,
     estado VARCHAR(16) NOT NULL,
     prioridad VARCHAR(16) NOT NULL,
     limite DATE NULL,
     autor VARCHAR(100) NOT NULL DEFAULT '',
     creada DATETIME NOT NULL,
     actualizada DATETIME NOT NULL,
     INDEX idx_ha_incidencia_actualizada (actualizada)
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ha_nota (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     incidencia_id INT UNSIGNED NOT NULL,
     texto MEDIUMTEXT NOT NULL,
     minutos INT UNSIGNED NOT NULL DEFAULT 0,
     autor VARCHAR(100) NOT NULL DEFAULT '',
     fecha DATETIME NOT NULL,
     INDEX idx_ha_nota_incidencia (incidencia_id)
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS ha_adjunto (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     incidencia_id INT UNSIGNED NOT NULL,
     nombre VARCHAR(255) NOT NULL,
     bytes INT UNSIGNED NOT NULL,
     contenido LONGBLOB NOT NULL,
     autor VARCHAR(100) NOT NULL DEFAULT '',
     fecha DATETIME NOT NULL,
     INDEX idx_ha_adjunto_incidencia (incidencia_id)
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Historial: alta y cada campo cambiado, ya con el texto que se muestra.
  `CREATE TABLE IF NOT EXISTS ha_cambio (
     id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     incidencia_id INT UNSIGNED NOT NULL,
     fecha DATETIME NOT NULL,
     campo VARCHAR(40) NOT NULL,
     antes TEXT NOT NULL,
     despues TEXT NOT NULL,
     INDEX idx_ha_cambio_incidencia (incidencia_id)
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Sindri: el servicio (artículo) con que se factura una incidencia (vacío = el que se deduce
  // del título) y el pedido de Sindri en que está ya cada trabajo.
  `ALTER TABLE ha_incidencia ADD COLUMN IF NOT EXISTS servicio_sku VARCHAR(40) NULL`,
  `ALTER TABLE ha_trabajo ADD COLUMN IF NOT EXISTS sindri_pedido VARCHAR(40) NULL`,
  // Varias personas, cada una con su empresa de Sindri: quién apuntó cada trabajo, en qué empresa
  // está su pedido ('' = la de la llave general) y la llave propia de cada persona (src/sindri.js).
  `ALTER TABLE ha_trabajo ADD COLUMN IF NOT EXISTS autor VARCHAR(100) NULL`,
  `ALTER TABLE ha_trabajo ADD COLUMN IF NOT EXISTS sindri_empresa VARCHAR(100) NULL`,
  `UPDATE ha_trabajo t JOIN ha_nota n ON n.id = t.nota_id SET t.autor = NULLIF(n.autor, '')
    WHERE t.autor IS NULL AND t.nota_id IS NOT NULL`,
  `UPDATE ha_trabajo SET sindri_empresa = '' WHERE sindri_pedido IS NOT NULL AND sindri_empresa IS NULL`,
  `CREATE TABLE IF NOT EXISTS ha_sindri_persona (
     usuario VARCHAR(100) PRIMARY KEY,
     llave VARCHAR(200) NOT NULL,
     actualizada DATETIME NOT NULL
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Tarifa por hora de cada persona (src/facturacion.js, tarifaPara).
  `CREATE TABLE IF NOT EXISTS ha_tarifa_persona (
     usuario VARCHAR(100) PRIMARY KEY,
     tarifa DECIMAL(10,2) NOT NULL,
     actualizada DATETIME NOT NULL
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Varias personas: de quién es cada cliente e incidencia ('' = el grupo general; si no, quien
  // trabaja con su propia empresa) y qué comparte cada uno con quién (src/facturacion.js, vista).
  `ALTER TABLE ha_cliente ADD COLUMN IF NOT EXISTS dueno VARCHAR(100) NOT NULL DEFAULT ''`,
  `ALTER TABLE ha_incidencia ADD COLUMN IF NOT EXISTS dueno VARCHAR(100) NOT NULL DEFAULT ''`,
  // A qué cliente se cobra lo de cada incidencia (vacío: el cliente por defecto de quien trabaja).
  `ALTER TABLE ha_incidencia ADD COLUMN IF NOT EXISTS cliente_id INT UNSIGNED NULL`,
  `CREATE TABLE IF NOT EXISTS ha_compartir (
     dueno VARCHAR(100) NOT NULL,
     usuario VARCHAR(100) NOT NULL,
     que VARCHAR(20) NOT NULL,
     creado_en DATETIME NOT NULL,
     PRIMARY KEY (dueno, usuario, que)
   ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // Tareas: la tarea de cada incidencia, si está abierta, cerrada o borrada allí, y la huella de lo
  // último que se le mandó (src/tareas.js).
  `ALTER TABLE ha_incidencia ADD COLUMN IF NOT EXISTS tarea_id VARCHAR(40) NULL`,
  `ALTER TABLE ha_incidencia ADD COLUMN IF NOT EXISTS tarea_estado VARCHAR(16) NULL`,
  `ALTER TABLE ha_incidencia ADD COLUMN IF NOT EXISTS tarea_huella VARCHAR(40) NULL`,
  // Hora de inicio y fin de cada sesión de trabajo, para poder corregirlas (src/facturacion.js,
  // trabajoEditar). Las de antes se deducen de su nota: acabó al guardarla y duró sus minutos.
  `ALTER TABLE ha_trabajo ADD COLUMN IF NOT EXISTS inicio DATETIME NULL`,
  `ALTER TABLE ha_trabajo ADD COLUMN IF NOT EXISTS fin DATETIME NULL`,
  `UPDATE ha_trabajo t JOIN ha_nota n ON n.id = t.nota_id
      SET t.fin = n.fecha, t.inicio = DATE_SUB(n.fecha, INTERVAL t.minutos MINUTE)
    WHERE t.tipo = 'TIEMPO' AND t.fin IS NULL`,
  // Horas a cobrar puestas a mano al corregir una sesión; NULL: las calcula Odin.
  `ALTER TABLE ha_trabajo ADD COLUMN IF NOT EXISTS horas_manual DECIMAL(8,2) NULL`
];

async function migrar() {
  for (const sql of TABLAS) {
    await pool.query(sql);
  }
}

async function consulta(sql, params) {
  const [filas] = await pool.query(sql, params);
  return filas;
}

module.exports = { migrar, consulta, pool };
