# Registro de infraestructura y cambios

Qué hay montado, dónde está cada cosa y qué se ha ido cambiando. Aquí no se escribe ninguna
contraseña ni clave: solo dónde se guarda cada una.

## Mapa

| Pieza | Dónde | Notas |
|---|---|---|
| Aplicación (portal) | https://soporte.luiscontacto03.com | Contenedor `incidencias-web`, Node.js |
| Motor de incidencias | Solo red interna del servidor | Contenedor `incidencias-mantis`, MantisBT 2.28.4 sin modificar |
| Base de datos | Solo red interna del servidor | Contenedor `incidencias-db`, MariaDB 11.4. Tablas `mantis_*` (MantisBT) y `ha_*` (portal) |
| Servidor | `178.104.121.47`, Ubuntu 24.04, 2 CPU, 3,7 GB RAM | Carpeta `/opt/apps/incidencias`. Comparte máquina con citas, krearte y app_spsil |
| Proxy y HTTPS | Nginx Proxy Manager en `/opt/apps/proxy` | Host `soporte.luiscontacto03.com` → `incidencias-web:80`, certificado Let's Encrypt |
| Dominio | Registrado en WordPress.com, DNS en Cloudflare | Los registros se cambian en Cloudflare |
| Envío de correo | Resend, región Irlanda | Remitente `soporte@luiscontacto03.com` |
| Recepción de correo | Cloudflare Email Routing | `soporte@luiscontacto03.com` → Gmail personal |
| Web portafolio | https://luiscontacto03.com | Contenedor `portafolio-web` (nginx), carpeta `/opt/apps/portafolio`. Código en `DESARROLLO\web-portafolio`, repositorio aparte |
| Entorno local | http://localhost:8090 (portal), :8080 (MantisBT), :8025 (correo de pruebas) | `docker compose up -d` en esta carpeta |

## Dónde está cada credencial

| Credencial | Lugar |
|---|---|
| Usuario y contraseña inicial del portal y de MantisBT en producción | `/opt/apps/incidencias/credenciales-iniciales.txt` en el servidor |
| Contraseñas de base de datos, token de MantisBT y clave de Resend en producción | `/opt/apps/incidencias/.env` en el servidor |
| Las mismas en local | `.env` de esta carpeta (no se versiona) |
| Acceso al servidor | `ssh servidor` (alias en `~/.ssh/config`, clave `~/.ssh/id_ed25519_servidor`) |
| Panel de Nginx Proxy Manager | `http://178.104.121.47:81`, usuario propio |
| Resend, Cloudflare, WordPress.com | Cuentas con el Gmail personal |

El `.env` del servidor lo lee también un script de shell: los valores con espacios o con `<` `>`
van entre comillas dobles.

## Registros DNS de `luiscontacto03.com` (en Cloudflare)

| Tipo | Nombre | Valor | Para qué |
|---|---|---|---|
| A | `@` (raíz) | `178.104.121.47` (solo DNS) | El portafolio. Antes eran dos registros de WordPress.com: `192.0.78.207` y `192.0.78.176`, con proxy |
| CNAME | `www` | `luiscontacto03.com` (solo DNS) | Redirige a la raíz |
| A | `soporte` | `178.104.121.47` (solo DNS, nube gris) | El portal |
| A | `citas`, `krearte`, `stock` | `178.104.121.47` | Otras aplicaciones |
| MX | `@` | `route1`, `route2`, `route3.mx.cloudflare.net` | Recibir correo (Cloudflare Email Routing) |
| TXT | `@` | `v=spf1 include:_spf.mx.cloudflare.net include:_spf.wpcloud.com ~all` | SPF: autoriza a Cloudflare y a WordPress. Solo puede haber un registro SPF |
| TXT | `cf2024-1._domainkey` | Firma DKIM de Cloudflare | Reenvío de correo |
| TXT | `resend._domainkey` | Firma DKIM de Resend | Envío desde el portal |
| CNAME | `send` | `send.forge.rmta.net` | Resend (ruta de retorno) |
| CNAME | `rsend` | `rsend-euw1.forge.rmta.net` | Resend |
| TXT | `_dmarc` | `v=DMARC1;p=none;` | Política DMARC, sin cambios |

## Operaciones habituales

Subir cambios a producción, desde un cmd en esta carpeta (los comandos completos están en el README):

1. Copia de la base de datos en el servidor, en `/opt/apps/incidencias/backups/`.
2. Subir la carpeta con `tar` por `ssh`.
3. `bash scripts/instalar-servidor.sh` en el servidor: reconstruye y reinicia.

Restaurar una copia en el servidor:

```
ssh servidor
cd /opt/apps/incidencias
docker exec -i incidencias-db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" mantisbt' < backups/FICHERO.sql
docker restart incidencias-web
```

Entrar a MantisBT en producción (no es público): con un túnel SSH,
`ssh -L 8081:$(ssh servidor "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' incidencias-mantis" | cut -d' ' -f1):80 servidor`
y abrir http://localhost:8081.

## Historial

### 2026-10-12

**Decisiones**

- MantisBT se usa solo como motor de incidencias, sin modificar y sin copiar su código. El portal
  le habla por su API REST. Así el código propio no queda bajo GPL y MantisBT se actualiza aparte.
- Lo facturable es la sesión de trabajo, no la incidencia. Reabrir una incidencia cobrada es
  válido; las sesiones ya cobradas no cambian.
- NiFi no se instala en este servidor: necesita más memoria de la que hay libre.

**Servidor**

- Actualizado el sistema (38 paquetes) y reiniciado.
- Autorizada una clave SSH sin frase de paso para este PC y creado el alias `servidor`.
- Desplegado el gestor en `/opt/apps/incidencias`.
- Alta del host `soporte.luiscontacto03.com` en Nginx Proxy Manager con certificado.

**Aplicación**

- Entorno local con Docker: MantisBT oficial verificado por SHA-256, MariaDB y Mailpit.
- Plugin de marca para MantisBT (`plugins/HenryArce`) con los logotipos de `MARCA_PERSONAL`.
- Portal propio con el aspecto del Gestor de peticiones: acceso con usuario y cookie, incidencias
  con estados, prioridad, fecha límite e historial, ficha en pestañas, cronómetro, notas, ficheros.
- Cobros: pendiente por periodo, sesiones, gastos sueltos, proformas, facturas, rectificativas,
  resúmenes de servicios y página imprimible.
- Migrada la hoja de Google: 56 incidencias, 2 gastos, 3 cobros (720 €, 628 €, 540 €), cliente y
  configuración. Importados los 14 PDF de Drive como resúmenes históricos RS-2026-0001 a 0014.
- Correo por Resend: recuperación de contraseña, aviso de inicio de sesión, aviso de contraseña
  cambiada y resumen mensual el día 1.
- Batería de pruebas de casuística: 181 comprobaciones.
- Pantalla **Correo**: escribir desde `soporte@` con la plantilla de la marca, vista previa, botón
  opcional y lista de enviados (tabla `ha_correo`). Desde la ficha de una incidencia, el correo
  queda anotado en su documentación.
- Logotipo en la cabecera de todos los correos: `portal/public/img/monograma.png`, generado desde
  `monograma.svg` (los programas de correo no admiten SVG). Se sirve desde producción, así que
  debe existir allí para que se vea. Otra imagen: variable `CORREO_LOGO_URL`.

**Dominio y correo**

- Creado el registro `soporte` en Cloudflare.
- Dominio verificado en Resend (registros `resend._domainkey`, `send` y `rsend`).
- Activado Cloudflare Email Routing: `soporte@` → Gmail. Añadidos tres MX y la firma DKIM.
- SPF combinado para no perder el de WordPress (antes solo `include:_spf.wpcloud.com`).
- Comprobado de extremo a extremo: un correo enviado a `soporte@` llegó al Gmail.
- La foto redonda del remitente en Gmail no se puede poner desde la aplicación: Gmail solo la
  muestra con BIMI (exige DMARC estricto y un certificado de marca de pago) o si la dirección es
  una cuenta de Google con foto.

**Web portafolio**

- Creada en `DESARROLLO\web-portafolio` y publicada en la raíz del dominio con certificado. En
  Nginx Proxy Manager: host `luiscontacto03.com` + `www.luiscontacto03.com` → `portafolio-web:80`.
- El sitio de WordPress.com "Panel de Trabajos" ya no se ve en el dominio; sigue existiendo en la
  cuenta de WordPress. Para volver atrás basta con recrear sus dos registros A.
- Actualizar: subir la carpeta con `tar` por `ssh` a `/opt/apps/portafolio` y ejecutar allí
  `docker compose -f docker-compose.server.yml up -d --build`.

## Pendiente

- Cambiar la contraseña inicial del portal en producción.
- Ajustes: horas mínimas por sesión está en 5 (venía así de la hoja; el historial usa 1).
  Confirmar IVA 10 % e IRPF 7 %.
- Generar una clave nueva de Resend y borrar `EXAMPLE_RESENDER.TXT`, que tiene la actual en claro.
- Cerrar al exterior el puerto 81 del panel del proxy (Docker se salta el cortafuegos).
- Copias de seguridad automáticas de la base de datos del servidor.
- Quitar el acceso público a la hoja de Google y a la carpeta de PDF de Drive.
- Portafolio: crear `info@luiscontacto03.com` en Cloudflare Email Routing (es el correo de contacto
  publicado) y añadir una foto propia.
- Veri\*Factu: confirmar requisitos con el gestor antes de emitir facturas reales desde el portal.
- El correo de avisos de MantisBT está desactivado en producción (el portal envía los suyos).
