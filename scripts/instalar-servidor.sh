#!/usr/bin/env bash
# Instala o actualiza MantisBT y la base de datos del gestor en el servidor. Se
# ejecuta desde la carpeta de la instalación:
#
#   bash scripts/instalar-servidor.sh                        # PRO: /opt/apps/incidencias
#   NOMBRE=incidencias-dev bash scripts/instalar-servidor.sh # DEV: /opt/apps/incidencias-dev
#
# NOMBRE da nombre a los contenedores (<NOMBRE>-mantis, <NOMBRE>-db) y al
# proyecto de Docker; se guarda en .env la primera vez y después sale de ahí.
# El portal lo despliega el servidor DEV/PRO desde su imagen; lo que necesita
# saber de esta instalación queda en app.env.portal, para añadirlo a
# /opt/apps/servidor/apps/soporte/<entorno>/app.env.
#
# La primera vez genera las contraseñas, instala MantisBT, crea el proyecto y
# el token de la API. Las claves iniciales quedan en credenciales-iniciales.txt.
# Las siguientes veces solo reconstruye y reinicia (y quita contenedores que ya
# no están en el compose, como el portal de antes).
set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
NOMBRE_PEDIDO=${NOMBRE:-}
if [ ! -f .env ]; then
	( umask 077
	  printf 'NOMBRE=%s\nDB_NAME=mantisbt\nDB_USER=mantisbt\nDB_PASSWORD=%s\nDB_ROOT_PASSWORD=%s\nPORTAL_ADMIN_USER=admin\nPORTAL_ADMIN_PASSWORD=%s\n' \
		"${NOMBRE_PEDIDO:-incidencias}" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 9)" > .env )
	echo "Contraseñas generadas en .env"
fi
set -a; . ./.env; set +a
NOMBRE=${NOMBRE:-incidencias}
if [ -n "$NOMBRE_PEDIDO" ] && [ "$NOMBRE_PEDIDO" != "$NOMBRE" ]; then
	echo "Esta instalación es '$NOMBRE' (según .env), no '$NOMBRE_PEDIDO'." >&2
	exit 1
fi

COMPOSE="docker compose -p $NOMBRE -f docker-compose.server.yml"
MANTIS=$NOMBRE-mantis

# Lo que el portal del servidor DEV/PRO necesita de esta instalación.
escribir_app_env() {
	( umask 077
	  cat > app.env.portal <<EOF
# Lo que el portal (contenedor soporte-<entorno>, desplegado por el servidor
# DEV/PRO) necesita de la instalación $NOMBRE. Añadir a
# /opt/apps/servidor/apps/soporte/<entorno>/app.env: el servidor conserva estas
# variables al desplegar. No lo copies fuera del servidor.
DB_HOST=$NOMBRE-db
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
MANTIS_URL=http://$MANTIS
MANTIS_API_TOKEN=${MANTIS_API_TOKEN:-}
MANTIS_PROJECT=SPSIL
PORTAL_ADMIN_USER=$PORTAL_ADMIN_USER
PORTAL_ADMIN_PASSWORD=$PORTAL_ADMIN_PASSWORD
PORTAL_ADMIN_EMAIL=${PORTAL_ADMIN_EMAIL:-}
PORTAL_COOKIE_SECURE=1
PORTAL_PROXIES=2
RESEND_API_KEY=${RESEND_API_KEY:-}
CORREO_REMITENTE=${CORREO_REMITENTE:-}
EOF
	)
	echo "Variables para el portal del servidor DEV/PRO en $(pwd)/app.env.portal"
}

if [ -f config/config_inc.php ]; then
	$COMPOSE up -d --build --remove-orphans
	escribir_app_env
	echo "Ya estaba instalado: contenedores actualizados."
	exit 0
fi

$COMPOSE up -d --build --remove-orphans

echo "Esperando a MantisBT..."
for _ in $(seq 1 30); do
	docker exec "$MANTIS" curl -s -o /dev/null http://localhost/ && break
	sleep 2
done

# El instalador escribe config_inc.php como www-data (uid 33).
chown 33:33 config 2>/dev/null || true

docker exec "$MANTIS" curl -s http://localhost/admin/install.php \
	--data-urlencode "install=2" \
	--data-urlencode "db_type=mysqli" \
	--data-urlencode "hostname=$NOMBRE-db" \
	--data-urlencode "db_username=$DB_USER" \
	--data-urlencode "db_password=$DB_PASSWORD" \
	--data-urlencode "database_name=$DB_NAME" \
	--data-urlencode "admin_username=root" \
	--data-urlencode "admin_password=$DB_ROOT_PASSWORD" \
	--data-urlencode "timezone=Europe/Madrid" \
	--data-urlencode "path=http://$MANTIS/" > instalacion.log

if [ ! -f config/config_inc.php ]; then
	echo "La instalación no ha creado config/config_inc.php. Revisa instalacion.log" >&2
	exit 1
fi

cat >> config/config_inc.php <<'EOF'

# La carpeta admin está cerrada desde fuera (docker/web/produccion.conf).
$g_admin_checks           = OFF;

# Sin servidor de correo todavía: no se envían avisos.
$g_enable_email_notification = OFF;

require_once( __DIR__ . '/ha_config_inc.php' );
EOF
chown root:33 config config/config_inc.php 2>/dev/null || true
chmod 640 config/config_inc.php

docker exec "$MANTIS" php /var/www/scripts/seed.php

MANTIS_ADMIN_PASSWORD="$(openssl rand -base64 15)"
docker exec -e ADMIN_PASSWORD="$MANTIS_ADMIN_PASSWORD" "$MANTIS" php /var/www/scripts/admin-password.php

# Credencial con la que el portal habla con MantisBT.
TOKEN="$(docker exec "$MANTIS" php /var/www/scripts/crear-token.php | tr -d '\r\n')"
if [ "${#TOKEN}" -lt 20 ]; then
	echo "No se ha podido crear el token de MantisBT." >&2
	exit 1
fi
printf 'MANTIS_API_TOKEN=%s\n' "$TOKEN" >> .env
MANTIS_API_TOKEN=$TOKEN

( umask 077
  printf 'MANTISBT (solo administración interna)\nUsuario: administrator\nContraseña: %s\n' \
	"$MANTIS_ADMIN_PASSWORD" > credenciales-iniciales.txt )

escribir_app_env
echo
echo "Instalado. Claves iniciales en $(pwd)/credenciales-iniciales.txt"
