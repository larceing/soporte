<?php
# Fija la contraseña de la cuenta administrator a partir de la variable de
# entorno ADMIN_PASSWORD. Lo usa instalar-servidor.sh para que la cuenta no
# quede nunca con la contraseña por defecto.

if( php_sapi_name() != 'cli' ) {
	exit( 1 );
}

$t_password = getenv( 'ADMIN_PASSWORD' );
if( !$t_password ) {
	fwrite( STDERR, "Falta ADMIN_PASSWORD\n" );
	exit( 1 );
}

chdir( '/var/www/html' );
require_once( 'core.php' );
require_api( 'user_api.php' );

user_set_password( user_get_id_by_name( 'administrator' ), $t_password, true );
echo "Contraseña de administrator actualizada\n";
