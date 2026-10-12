<?php
# Datos iniciales del gestor: proyecto del cliente, tipos de solicitud y un
# usuario de cliente para pruebas. Se puede ejecutar varias veces.
#
#   docker compose exec web php /var/www/scripts/seed.php

if( php_sapi_name() != 'cli' ) {
	exit( 1 );
}

chdir( '/var/www/html' );
require_once( 'core.php' );
require_api( 'category_api.php' );
require_api( 'email_api.php' );
require_api( 'project_api.php' );
require_api( 'user_api.php' );

const SEED_PROJECT = 'SPSIL';
const SEED_CATEGORIES = array( 'Incidencia', 'Petición' );
const SEED_CLIENT_USER = 'cliente.prueba';

# Proyecto privado y sin categorías globales: el cliente solo elige entre
# Incidencia y Petición.
if( project_is_name_unique( SEED_PROJECT ) ) {
	$t_project_id = project_create( SEED_PROJECT, 'Multiforte SL · Grupo SPSIL', 50, VS_PRIVATE, '', true, false );
	echo 'Proyecto ' . SEED_PROJECT . " creado (id $t_project_id)\n";
} else {
	$t_project_id = project_get_id_by_name( SEED_PROJECT );
	echo 'Proyecto ' . SEED_PROJECT . " ya existe (id $t_project_id)\n";
}

foreach( SEED_CATEGORIES as $t_category ) {
	if( category_is_unique( $t_project_id, $t_category ) ) {
		category_add( $t_project_id, $t_category );
		echo "Categoría $t_category creada\n";
	} else {
		echo "Categoría $t_category ya existe\n";
	}
}

# Solo en desarrollo: un informador para ver el gestor como lo ve el cliente.
if( getenv( 'SEED_DEV_USERS' ) ) {
	if( user_is_name_unique( SEED_CLIENT_USER ) ) {
		user_create( SEED_CLIENT_USER, 'cliente_dev', 'cliente.prueba@example.test', REPORTER, false, true, 'Cliente de prueba' );
		echo 'Usuario ' . SEED_CLIENT_USER . " creado\n";
	} else {
		echo 'Usuario ' . SEED_CLIENT_USER . " ya existe\n";
	}
	$t_user_id = user_get_id_by_name( SEED_CLIENT_USER );
	if( !project_includes_user( $t_project_id, $t_user_id ) ) {
		project_add_user( $t_project_id, $t_user_id, REPORTER );
		echo 'Usuario ' . SEED_CLIENT_USER . ' añadido a ' . SEED_PROJECT . "\n";
	}
	email_send_all();
}
