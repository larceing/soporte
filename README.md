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

## Servidor DEV/PRO

El portal es una app del servidor común ([larceing/servidor](https://github.com/larceing/servidor)).
`servidor.json`, en la raíz, la describe: ruta `/soporte/`, grupo `Soporte`, tipo `servidor`.
GitHub construye su imagen en cada push a `main` (`.github/workflows/imagen.yml` →
`ghcr.io/larceing/soporte:sha-xxxxxxx`) y el servidor la despliega desde Ajustes: **Añadir una
aplicación** `larceing/soporte`, **Poner** la versión en DEV, probar en `dev.<dominio>/soporte/`,
**Pasar a PRO** y, en PRO, **Poner en su dominio** (`soporte.luiscontacto03.com`). Sin scripts ni
claves de SSH: el servidor mira `/version/` y, si una versión no responde, vuelve a la anterior.

MantisBT y la base de datos no los despliega el servidor: siguen en su carpeta, una instalación por
entorno, con `docker-compose.server.yml` y `scripts/instalar-servidor.sh`. Están en la red
`proxy_default` para que el portal (`soporte-dev`, `soporte-pro`) llegue a ellos por su nombre.

| Entorno | Carpeta | `.env` | Contenedores |
|---|---|---|---|
| PRO | `/opt/apps/incidencias` (la de siempre) | sin `NOMBRE` | `incidencias-mantis`, `incidencias-db` |
| DEV | `/opt/apps/incidencias-dev` (`git clone` de este repositorio) | `NOMBRE=incidencias-dev` | `incidencias-dev-mantis`, `incidencias-dev-db` |

```
cd /opt/apps/incidencias-dev && NOMBRE=incidencias-dev SIN_PORTAL=1 bash scripts/instalar-servidor.sh
```

El script deja en `app.env.portal` lo que el portal necesita de esa instalación (base de datos,
MantisBT y su token, correo). Se añade a mano a `/opt/apps/servidor/apps/soporte/<entorno>/app.env`
(el servidor conserva esas variables al desplegar): es lo único que todavía no hace Ajustes.
`PORTAL_PROXIES=2` porque delante del portal van Nginx Proxy Manager y la entrada del entorno.

Para cambiar MantisBT, su plugin o su configuración en un entorno: `git pull` en su carpeta y
`bash scripts/instalar-servidor.sh` (reconstruye y reinicia; en DEV, con `SIN_PORTAL=1`). El correo
de MantisBT está desactivado en el servidor: los avisos los envía el portal.

**Paso a PRO del portal nuevo.** El portal de antes (`incidencias-web`, el que hoy sirve
`soporte.luiscontacto03.com`) sigue hasta que `soporte-pro` funcione contra `incidencias-mantis` e
`incidencias-db` (misma base de datos: no hay nada que migrar). Entonces, **Poner en su dominio**
desde Ajustes (apunta el host del proxy al nuevo y guarda a dónde iba, para poder volver) y parar el
de antes: `docker compose -p incidencias -f docker-compose.server.yml rm -s -f incidencias-web`.

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
