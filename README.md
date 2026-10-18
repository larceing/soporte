# Gestor de incidencias

Sistema propio de incidencias, documentación y horas: el **portal** (`portal/`), con el aspecto
del Gestor de peticiones. Node.js + Express, sin framework en el navegador, y MariaDB.

Todo se guarda en tablas `ha_*`: incidencias, notas, adjuntos e historial
(`portal/src/incidencias.js`), además de usuarios, cronómetro y cobros. Hasta ahora las incidencias
vivían en **MantisBT 2.28.4**, que el portal usaba solo como almacén por su API REST. Ver
[Adiós a MantisBT](#adiós-a-mantisbt): lo que queda de MantisBT en este repositorio se quitará
cuando DEV y PRO hayan copiado sus incidencias.

## Adiós a MantisBT

Al arrancar, el portal copia una sola vez las incidencias de MantisBT a sus tablas
(`portal/src/migrar-mantis.js`): las lee por la API, con la misma traducción que mostraba hasta
ahora, y las guarda todas en una transacción, con sus números de incidencia, nota y adjunto
(las sesiones de trabajo y los correos apuntan a ellos). Deja la marca
`incidencias_copiadas_de_mantis` en `ha_config` y no lo repite. Las tablas `mantis_*` no se tocan:
quedan como respaldo. El historial de «Resolución» de MantisBT no se copia: lo dice el estado.

Para la copia hacen falta `MANTIS_URL` y `MANTIS_API_TOKEN` en el `app.env`, que ya están. Si falla,
el portal arranca igual (Cobros, Correo…) y la pantalla de incidencias dice el motivo; se arregla y
se vuelve a poner la versión. En una base de datos sin MantisBT no hay nada que copiar.

Antes de poner esta versión en un entorno, copia de la base de datos:

```
docker exec incidencias-db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" mantisbt' > antes-sin-mantis.sql
```

Volver a la versión anterior del portal sigue funcionando (MantisBT sigue ahí), pero lo creado
mientras tanto en el portal nuevo no estaría en MantisBT. Las notas nuevas se firman con el usuario
que las escribe, no con «administrator».

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
`proxy_default` para que el portal (`soporte-dev`, `soporte-pro`) llegue a ellos por su nombre de
contenedor. Los servicios del compose se llaman `mantis` y `bd`, no como los contenedores: Docker da
a cada contenedor el nombre de su servicio en todas sus redes, y si se llamaran `incidencias-db`,
ese nombre apuntaría también a la base de datos de DEV y PRO fallaría a ratos.

| Entorno | Carpeta | `.env` | Contenedores |
|---|---|---|---|
| PRO | `/opt/apps/incidencias` (la de siempre) | sin `NOMBRE` | `incidencias-mantis`, `incidencias-db` |
| DEV | `/opt/apps/incidencias-dev` (`git clone` de este repositorio) | `NOMBRE=incidencias-dev` | `incidencias-dev-mantis`, `incidencias-dev-db` |

```
cd /opt/apps/incidencias-dev && NOMBRE=incidencias-dev bash scripts/instalar-servidor.sh
```

El script deja en `app.env.portal` lo que el portal necesita de esa instalación (base de datos,
MantisBT y su token, correo). Se añade a mano a `/opt/apps/servidor/apps/soporte/<entorno>/app.env`
(el servidor conserva esas variables al desplegar): es lo único que todavía no hace Ajustes.
`PORTAL_PROXIES=2` porque delante del portal van Nginx Proxy Manager y la entrada del entorno.

Para cambiar MantisBT, su plugin o su configuración en un entorno: `git pull` en su carpeta y
`bash scripts/instalar-servidor.sh` (reconstruye y reinicia). El correo
de MantisBT está desactivado en el servidor: los avisos los envía el portal.

El portal de antes (`incidencias-web`) ya no está en el compose: `soporte.luiscontacto03.com` va al
portal nuevo desde **Poner en su dominio**, y `instalar-servidor.sh` quita el contenedor viejo
(`--remove-orphans`).

### Correo

El portal no envía correo por su cuenta: se lo pide a **Mail** (`larceing/mail`), la app de correo
del servidor, que le pone la marca, lo envía por Resend y lo anota. En el `app.env` de cada entorno:

```
MAIL_URL=http://mail-<entorno>:3000
MAIL_LLAVE=ml_…        # en Mail → Llaves, app «soporte»
```

Sin esas dos el portal funciona igual pero no envía nada (ni la vista previa de Correo).

**Documentos por correo.** En Cobros → Documentos, «Enviar por correo» abre Correo con el
destinatario (el correo del cliente), el asunto y el mensaje escritos y el PDF del documento
adjunto. Los documentos históricos llevan su PDF original; los demás, la misma página de
«Ver / PDF» impresa por Chromium dentro de la imagen (`portal/src/pdf.js`). Hace falta una
versión de Mail con adjuntos: si Mail es anterior, el correo sale sin el PDF y el portal lo
avisa. Fuera de la imagen, `CHROMIUM_RUTA` dice dónde está Chromium.

### Entrada con Keycloak

En el servidor DEV/PRO el portal entra con Keycloak (realm `general`), como las demás apps:
el servidor le pone en su `app.env` `AUTH_MODO=sso` y su cliente (`soporte-dev`,
`soporte-pro`). `/login` manda a la pantalla de Keycloak y vuelve a `/sso`
(`portal/src/sso.js`). Entra quien administra la app: el grupo `/IT` o
`/<ENTORNO>/Soporte/Admin`. El grupo `/<ENTORNO>/Soporte` sin `Admin` todavía no entra,
porque el portal aún no tiene vista de cliente. Con Keycloak no hay contraseñas del
portal: la entrada con usuario y contraseña, la recuperación y el cambio de contraseña
quedan cerrados. Sin `AUTH_MODO=sso` (entorno local) todo sigue como antes.

La primera vez que alguien entra se crea su usuario del portal. `PORTAL_ADMIN_SSO=henry`
en el `app.env` hace que ese usuario de Keycloak herede el usuario local de antes
(`PORTAL_ADMIN_USER`, normalmente `admin`) con todo lo suyo, en vez de empezar de cero.

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
BASE=http://localhost:8090 USUARIO=admin CLAVE=... node portal/tests/casuistica.js
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
