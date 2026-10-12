<?php
# Configuración común a todos los entornos (desarrollo y producción).
# La carga config_inc.php, que solo contiene lo propio de cada entorno:
# credenciales, sal criptográfica, URL y correo.

# --- Identidad -------------------------------------------------------------
$g_window_title           = 'Henry Arce · Soporte';
$g_from_name              = 'Henry Arce · Soporte';
$g_logo_image             = 'plugin_file.php?file=HenryArce/logo.svg';
$g_favicon_image          = 'plugin_file.php?file=HenryArce/monograma.svg';
$g_plugins_force_installed = array( 'HenryArce' => 5 );

# --- Idioma y fechas -------------------------------------------------------
$g_default_language       = 'spanish';
$g_fallback_language      = 'spanish';
$g_short_date_format      = 'd/m/Y';
$g_normal_date_format     = 'd/m/Y H:i';
$g_complete_date_format   = 'd/m/Y H:i T';

# --- Acceso ----------------------------------------------------------------
# Las cuentas de cliente las crea el administrador; nadie se registra solo.
$g_allow_signup           = OFF;
$g_show_realname          = ON;

# --- Formulario de alta ----------------------------------------------------
# El cliente solo ve tipo (categoría), prioridad, resumen, descripción y
# adjuntos. "handler" y "due_date" solo aparecen a quien puede asignar.
$g_bug_report_page_fields = array(
	'attachments',
	'category_id',
	'due_date',
	'handler',
	'priority',
);
$g_enable_profiles        = OFF;
$g_max_file_size          = 20 * 1024 * 1024;

# --- Seguimiento -----------------------------------------------------------
# La fecha límite viene desactivada de serie; el portal la usa.
$g_due_date_view_threshold   = DEVELOPER;
$g_due_date_update_threshold = DEVELOPER;

# --- Tiempo dedicado -------------------------------------------------------
# Se registra en las notas, con cronómetro. El cliente (informador) no lo ve.
# La facturación no se hace aquí, sino en el Gestor de peticiones.
$g_time_tracking_enabled             = ON;
$g_time_tracking_stopwatch           = ON;
$g_time_tracking_without_note        = ON;
$g_time_tracking_with_billing        = OFF;
$g_time_tracking_view_threshold      = DEVELOPER;
$g_time_tracking_edit_threshold      = DEVELOPER;
$g_time_tracking_reporting_threshold = MANAGER;
