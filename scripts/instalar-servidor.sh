#!/usr/bin/env bash
# Instala o actualiza el gestor en el servidor. Se ejecuta desde la carpeta
# de la app (/opt/apps/incidencias):
#
#   bash scripts/instalar-servidor.sh
#
# La primera vez genera las contraseñas, instala MantisBT (que queda solo en
# la red interna), crea el proyecto, arranca el portal y, si existe la carpeta
# migracion/ con los CSV de la hoja, carga el historial. Las claves iniciales
# quedan en credenciales-iniciales.txt. Las siguientes veces solo reconstruye
# y reinicia.
set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.server.yml"
MANTIS=incidencias-mantis
PORTAL=incidencias-web

mkdir -p migracion

if [ ! -f .env ]; then
	( umask 077
	  printf 'DB_NAME=mantisbt\nDB_USER=mantisbt\nDB_PASSWORD=%s\nDB_ROOT_PASSWORD=%s\nPORTAL_ADMIN_USER=admin\nPORTAL_ADMIN_PASSWORD=%s\n' \
		"$(openssl rand -hex 16)" "$(openssl rand -hex 16)" "$(openssl rand -hex 9)" > .env )
	echo "Contraseñas generadas en .env"
fi
set -a; . ./.env; set +a

if [ -f config/config_inc.php ]; then
	$COMPOSE up -d --build
	echo "Ya estaba instalado: contenedores actualizados."
	exit 0
fi

$COMPOSE up -d --build incidencias-db incidencias-mantis

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
	--data-urlencode "hostname=incidencias-db" \
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

$COMPOSE up -d --build

echo "Esperando al portal..."
for _ in $(seq 1 30); do
	docker logs "$PORTAL" 2>&1 | grep -q "Portal escuchando" && break
	sleep 2
done

if [ -f migracion/Peticiones.csv ]; then
	docker exec "$PORTAL" node scripts/migrar-hoja.js /migracion
fi

( umask 077
  printf 'PORTAL (lo que se usa a diario)\nUsuario: %s\nContraseña: %s\n\nMANTISBT (solo administración interna)\nUsuario: administrator\nContraseña: %s\n' \
	"$PORTAL_ADMIN_USER" "$PORTAL_ADMIN_PASSWORD" "$MANTIS_ADMIN_PASSWORD" > credenciales-iniciales.txt )

echo
echo "Instalado. Claves iniciales en $(pwd)/credenciales-iniciales.txt"
