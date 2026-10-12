<?php
# Plugin HenryArce para MantisBT: imagen propia del gestor de incidencias.
#
# Este programa es software libre: puede redistribuirse y modificarse bajo
# los términos de la GNU General Public License, versión 2 o posterior,
# publicada por la Free Software Foundation.

class HenryArcePlugin extends MantisPlugin {

	function register() {
		$this->name = 'Henry Arce · Imagen propia';
		$this->description = 'Colores, logotipo y ajustes de interfaz de Henry Arce · Business Applications & Data.';
		$this->page = '';

		$this->version = '0.1.0';
		$this->requires = array(
			'MantisCore' => '2.28.0',
		);

		$this->author = 'Henry Arce';
	}

	function hooks() {
		return array(
			'EVENT_LAYOUT_RESOURCES' => 'resources',
		);
	}

	/**
	 * Enlaza la hoja de estilos de marca después de las de MantisBT.
	 * @return void
	 */
	function resources() {
		# El navegador guarda la hoja varias horas; la fecha del fichero en la
		# URL hace que cada cambio se vea al momento.
		$t_cache_key = filemtime( __DIR__ . '/files/ha.css' );
		printf( "\t<link rel=\"stylesheet\" type=\"text/css\" href=\"%s\" />\n",
			string_html_specialchars( plugin_file( 'ha.css' ) . '&v=' . $t_cache_key )
		);
	}
}
