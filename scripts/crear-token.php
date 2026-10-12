<?php
# Crea un token de la API REST de MantisBT para la cuenta administrator y lo
# imprime. Es la credencial con la que el portal habla con MantisBT.
#
#   docker compose exec web php /var/www/scripts/crear-token.php

if( php_sapi_name() != 'cli' ) {
	exit( 1 );
}

chdir( '/var/www/html' );
require_once( 'core.php' );
require_api( 'api_token_api.php' );
require_api( 'user_api.php' );

$t_name = 'portal-' . date( 'Ymd-His' );
echo api_token_create( $t_name, user_get_id_by_name( 'administrator' ) ), "\n";
