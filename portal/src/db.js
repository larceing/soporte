const mysql = require('mysql2/promise');

// El portal guarda lo suyo en la misma base de datos que MantisBT, en tablas
// con prefijo ha_. Las tablas mantis_* no se tocan nunca desde aquí: las
// incidencias se leen y escriben solo por la API de MantisBT.
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
  // Lo facturable: una fila por sesión de trabajo (ligada a una nota con tiempo
  // de MantisBT) o por gasto suelto. Guarda el precio del momento, que MantisBT
  // no conoce.
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
  // PDF originales de documentos emitidos antes de existir el portal.
  `CREATE TABLE IF NOT EXISTS ha_documento_pdf (
     documento_id INT UNSIGNED PRIMARY KEY,
     nombre VARCHAR(255) NOT NULL,
     contenido LONGBLOB NOT NULL
   )`
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
