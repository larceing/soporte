# Odin (gestor de incidencias)

Sistema propio de incidencias, documentación y horas: el **portal** (`portal/`), con el aspecto
del Gestor de peticiones. Node.js + Express, sin framework en el navegador, y MariaDB.

Todo se guarda en tablas `ha_*`: incidencias, notas, adjuntos e historial
(`portal/src/incidencias.js`), además de usuarios, cronómetro y horas. El gestor no cobra ni
factura: las horas pendientes llegan a Sindri ([Llevar los datos a Sindri](#llevar-los-datos-a-sindri)),
donde se pasan a un pedido y se facturan. Hasta ahora las incidencias
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

Los cobros, pagos y documentos de antes (tablas `ha_pago`, `ha_documento`, `ha_documento_pdf`) se
conservan en la base de datos pero el portal ya no los enseña: se cobra y se factura en Sindri. Una
sesión cobrada o metida en una factura de entonces no vuelve a facturarse.

## Llevar los datos a Sindri

En **Ajustes**, «Descargar para Sindri» da un `.json` con:

- el emisor y los clientes (con su contacto y su **tarifa por hora**, que en Sindri queda como tarifa
  propia del cliente; el descuento se pone en su ficha de Sindri);
- los **servicios como artículos**: el catálogo de `portal/src/servicios.js` (Power BI, gateway,
  recargas, IA, Azure, CI/CD, Microsoft 365, migración de ERP…), todos por horas con la tarifa
  general, y `SOP-CARGO` para los cobros sueltos. Cada trabajo va al primer servicio cuyas palabras
  salen en el título de su incidencia o en su concepto; si ninguno encaja, a desarrollos
  (peticiones) o resolución de incidencias;
- lo **pendiente de cobrar** (cerrado, sin cobro y fuera de proformas y facturas): cada trabajo con
  sus horas como cantidad y la tarifa del momento como precio. En Sindri queda en **Pedidos → Por
  facturar**. Lo cobrado, lo facturado y lo marcado «No se cobra» no viaja.

En Sindri se importa en **Empresa → Llevar y traer datos**: primero enseña qué haría, con la tabla de
lo que queda por facturar, y no guarda nada hasta pulsar «Importar». No borra nada y, si se repite,
actualiza en vez de duplicar (clientes por NIF, artículos por referencia, trabajos por su código).
Las incidencias y los documentos siguen en el gestor.

En la ficha de cada incidencia, «Servicio para Sindri» fija el artículo con que se facturan sus
sesiones (los servicios por horas de Sindri, o el catálogo propio si Sindri no está conectado). Si
se deja en «Automático», se usa el que se deduce del título.

### Envío automático

Con la conexión puesta, lo pendiente de cobrar llega solo a **Por facturar** de Sindri, unos
segundos después de cada cambio en el portal y cada 10 minutos (`portal/src/sindri.js`). Cada envío
manda todo lo pendiente: Sindri actualiza lo que sigue pendiente allí y no toca lo que ya está en un
pedido. Lo que aquí deja de estar pendiente (reabierto, «No se cobra», cobrado) se retira de Sindri
si allí sigue pendiente. No crea pedidos ni facturas: eso se hace en Sindri, juntando lo pendiente
en un pedido. Cada envío anota en el gestor en qué pedido de Sindri está cada sesión («En pedido
Sindri …» en Horas y en la ficha) y entonces ya no se puede marcar como «No se factura».

1. En Sindri, **Empresa → Integraciones**: crear una llave llamada `incidencias` (el mismo origen que
   el fichero, para que lo importado y lo enviado sean lo mismo).
2. En el portal, **Ajustes → Sindri**: la dirección de Sindri (por dentro, `http://sindri-<entorno>:8000`)
   y la llave. La llave no vuelve nunca al navegador. También pueden ir como `SINDRI_URL` y
   `SINDRI_LLAVE` en el `app.env`, y entonces mandan esas.

Si a Sindri le falta el cliente (se busca por NIF y por nombre) o el servicio (por su código), el
envío lo da de alta allí con los datos de aquí: nombre, NIF, correo, teléfono y dirección del
cliente; nombre, unidad, tarifa e IVA del servicio. Lo que Sindri ya tiene no se toca. Si un alta
no entra (p. ej. un NIF mal escrito), ese trabajo se queda fuera y Ajustes → Sindri dice por qué.
Con un Sindri que aún no admite altas, hay que importar antes una vez el fichero.

## Gestor de tareas

Cada incidencia abierta tiene su tarea en el gestor de tareas, sin hacer nada (`portal/src/tareas.js`,
con la API normal de Tareas):

- incidencia abierta sin tarea → se crea en el proyecto elegido, con su prioridad, su fecha límite,
  la descripción y un enlace a la ficha;
- cambian el título, la prioridad o la fecha límite → se cambian en la tarea;
- se resuelve o se cierra → la tarea pasa a la última columna del tablero (la de hechas); si se
  reabre, vuelve a la primera;
- una tarea borrada en Tareas no se vuelve a crear.

Va unos segundos después de cada cambio en el portal y cada 10 minutos. Las horas se siguen
apuntando aquí, que es quien las lleva a Sindri.

1. En Tareas, **Configuración → API**: crear un token (la tarea la firma su dueño).
2. En el portal, **Ajustes → Tareas**: la dirección de Tareas (por dentro, `http://tareas-<entorno>:8000`),
   la llave y el id del proyecto donde caen. También pueden ir como `TAREAS_URL`, `TAREAS_LLAVE` y
   `TAREAS_PROYECTO` en el `app.env`, y entonces mandan esas.

El enlace a la ficha usa `PORTAL_URL` (o `APP_URL_PUBLICA`, que pone el servidor).

## Corregir una sesión de trabajo

Cada sesión guarda su hora de inicio y de fin (`ha_trabajo.inicio` y `fin`; las de antes se deducen
de su nota: acabó al guardarla y duró sus minutos). Si el cronómetro se quedó en marcha o el tiempo
no es el bueno:

- **Corregir** (pestaña Sesiones de la incidencia, o «Corregir horas» en Horas): se cambian el inicio,
  el fin y lo que se hizo. El tiempo, las horas facturables, el importe (con la tarifa que ya tenía),
  el día y la nota de la incidencia se recalculan solos, y el historial apunta el cambio («Sesión»).
- **Añadir sesión con horas**: apunta una sesión con su inicio y su fin, por ejemplo la mañana que
  se trabajó sin cronómetro. Se guarda también como nota.

Una sesión dura de 1 minuto a 24 horas, no acaba en el futuro y cuenta en el día en que empezó.
Solo se corrige la propia, y no si ya está cobrada, facturada o en un pedido de Sindri. Lo pendiente
se pone al día en Sindri unos segundos después. Pruebas: `node portal/tests/sesiones.js`.

## Pruebas de casuística

`portal/tests/casuistica.js` recorre los grafos de estados (incidencia, cronómetro y trabajo) y
comprueba cada transición, permitida o prohibida, además de accesos, validaciones y
operaciones simultáneas. Crea datos, así que solo se ejecuta en desarrollo, con copia previa:

```
docker compose exec -T db sh -c "mariadb-dump -uroot -p$MARIADB_ROOT_PASSWORD mantisbt" > backups/antes-pruebas.sql
BASE=http://localhost:8090 USUARIO=admin CLAVE=... node portal/tests/casuistica.js
docker compose exec -T db sh -c "mariadb -uroot -p$MARIADB_ROOT_PASSWORD mantisbt" < backups/antes-pruebas.sql
```

Reglas que fijan esas pruebas:

- Lo que se factura es la sesión de trabajo, no la incidencia. Reabrir una incidencia ya facturada
  es válido: sus sesiones no cambian y el tiempo nuevo queda pendiente.
- Solo se registra tiempo en incidencias abiertas; no se resuelve una con su cronómetro en marcha.
- Una sesión en un pedido de Sindri, o cobrada antes en el gestor, no se puede modificar.

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
