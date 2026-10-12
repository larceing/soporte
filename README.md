# Gestor de incidencias

Sistema propio de incidencias, documentación y horas. Tiene dos piezas:

- **Portal** (`portal/`): la aplicación de trabajo, con el aspecto del Gestor de peticiones.
  Node.js + Express, sin framework en el navegador. Entrada con usuario y cookie de sesión.
- **MantisBT 2.28.4** (GPL v2 o posterior), sin modificar: el motor de incidencias. El portal
  lo usa solo por su API REST (`portal/src/mantis.js`) y no copia su código.

Los datos propios del portal (usuarios, sesiones, cronómetro) van en tablas `ha_*` de la misma
base de datos; las tablas `mantis_*` solo las toca MantisBT.

## Entorno de desarrollo

Requiere Docker Desktop.

```
copy .env.example .env
docker compose up -d --build
```

| Servicio | Dirección |
|---|---|
| Portal | http://localhost:8090 (usuario y contraseña: `PORTAL_ADMIN_*` de `.env`) |
| MantisBT | http://localhost:8080 |
| Correo capturado (Mailpit) | http://localhost:8025 |
| MariaDB | localhost:3306 |

### Primera instalación

La primera vez, http://localhost:8080 redirige al instalador. Valores:

| Campo | Valor |
|---|---|
| Type of Database | MySQL Improved |
| Hostname | `db` |
| Username / Password | `DB_USER` / `DB_PASSWORD` de `.env` |
| Database name | `DB_NAME` de `.env` |
| Admin Username / Password | `root` / `DB_ROOT_PASSWORD` de `.env` |
| Default Time Zone | Europe/Madrid |

El instalador crea `config/config_inc.php`. Añadir al final el bloque de correo y el
`require_once` que aparecen en `config/config_inc.php.example`.

Usuario inicial: `administrator` / `root` (MantisBT obliga a cambiar la contraseña).

Después, crear el proyecto SPSIL, las categorías Incidencia y Petición y el usuario de
pruebas `cliente.prueba` / `cliente_dev` (informador):

```
docker compose exec web php /var/www/scripts/seed.php
```

Por último, crear el token con el que el portal habla con MantisBT y guardarlo en `.env`
como `MANTIS_API_TOKEN`, y reiniciar el portal:

```
docker compose exec web php /var/www/scripts/crear-token.php
docker compose up -d portal
```

El script se puede repetir sin duplicar nada. El usuario de pruebas solo se crea si la
variable `SEED_DEV_USERS` está definida, como ocurre en este entorno.

## Personalización

| Qué | Dónde |
|---|---|
| Idioma, fechas, formulario de alta, tiempo dedicado, título | `config/ha_config_inc.php` |
| Credenciales, URL y correo de cada entorno | `config/config_inc.php` (no versionado) |
| Colores, logotipo e icono | `plugins/HenryArce/files/` |

El plugin HenryArce se instala solo (`$g_plugins_force_installed`). Los cambios en
`ha.css` se ven al recargar la página.

### Operaciones habituales

```
docker compose stop                 # parar, conservando los datos
docker compose down -v              # borrar todo, incluida la base de datos
docker compose logs -f web          # registro de Apache y PHP
docker compose exec db mariadb-dump -uroot -p mantisbt > backups/mantisbt.sql
```

### Actualizar MantisBT

Cambiar `MANTIS_VERSION` y `MANTIS_SHA256` en `docker/web/Dockerfile` (la suma está en el
fichero `.tar.gz.digests` de la versión en SourceForge), reconstruir con
`docker compose up -d --build` y abrir `/admin/install.php` para aplicar los cambios de esquema.

## Producción

En el servidor vive en `/opt/apps/incidencias` y se publica en https://soporte.luiscontacto03.com
a través de Nginx Proxy Manager, que apunta al contenedor `incidencias-web` (el portal). MantisBT
(`incidencias-mantis`) y la base de datos quedan en la red interna, sin acceso desde fuera.

Subir cambios y aplicarlos, desde un cmd en esta carpeta:

```
tar -czf - --exclude=.git --exclude=.env --exclude=backups --exclude=gestor_peticiones --exclude=node_modules --exclude=EXAMPLE_* --exclude=config/config_inc.php . | ssh servidor "tar -xzf - -C /opt/apps/incidencias"
ssh servidor "bash /opt/apps/incidencias/scripts/instalar-servidor.sh"
```

La primera ejecución instala todo, migra la hoja si existe `migracion/` y deja las claves en
`credenciales-iniciales.txt`; las siguientes solo reconstruyen y reinician. El correo de MantisBT
está desactivado en producción.

## Migración de la hoja de Google

`portal/scripts/migrar-hoja.js` carga los CSV de `migracion/` (hojas MacroData, Clientes, Pagos y
Peticiones). Cada petición con tiempo pasa a ser una incidencia resuelta con su sesión de trabajo
y su fecha original; los cobros y los gastos sueltos se conservan con sus códigos. Se puede repetir
sin duplicar.

```
docker compose exec portal node scripts/migrar-hoja.js /migracion
```

Los PDF que el gestor antiguo guardó en Drive se importan con
`portal/scripts/importar-documentos.js` desde `migracion/documentos/` (un `indice.json` y un
`<id>.pdf` por documento). Quedan como resúmenes históricos con su PDF original.

## Pruebas de casuística

`portal/tests/casuistica.js` recorre los grafos de estados (incidencia, cronómetro, trabajo y
documento) y comprueba cada transición, permitida o prohibida, además de accesos, validaciones y
operaciones simultáneas. Crea datos, así que solo se ejecuta en desarrollo, con copia previa:

```
docker compose exec -T db sh -c "mariadb-dump -uroot -p$MARIADB_ROOT_PASSWORD mantisbt" > backups/antes-pruebas.sql
BASE=http://localhost:8090 USUARIO=admin CLAVE=... MANTIS=http://localhost:8080 MANTIS_TOKEN=... node portal/tests/casuistica.js
docker compose exec -T db sh -c "mariadb -uroot -p$MARIADB_ROOT_PASSWORD mantisbt" < backups/antes-pruebas.sql
```

Reglas que fijan esas pruebas:

- Lo que se factura es la sesión de trabajo, no la incidencia. Reabrir una incidencia cobrada es
  válido: sus sesiones cobradas no cambian y el tiempo nuevo queda pendiente.
- Solo se registra tiempo en incidencias abiertas; no se resuelve una con su cronómetro en marcha.
- Una sesión en una proforma, en una factura o cobrada no se puede modificar.
- Una factura emitida no se edita ni se borra: se cobra o se rectifica.

## Estructura

```
portal/              aplicación propia (servidor en src/, pantallas en public/)
gestor_peticiones/   copia de referencia del Gestor de peticiones (Apps Script)
config/              configuración de MantisBT (montada en el contenedor)
plugins/HenryArce/   plugin de imagen propia (montado en el contenedor)
scripts/seed.php     datos iniciales: proyecto, categorías y usuario de pruebas
docker/web/          imagen PHP 8.3 + Apache con el núcleo oficial
docker-compose.yml   web, base de datos y correo de pruebas
```
