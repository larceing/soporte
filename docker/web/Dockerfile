FROM php:8.3-apache

# Núcleo de MantisBT sin modificar: se descarga el paquete oficial y se
# comprueba contra el SHA-256 publicado en su fichero .digests.
# Para actualizar, cambiar versión y suma y reconstruir la imagen.
ARG MANTIS_VERSION=2.28.4
ARG MANTIS_SHA256=a400bd2957154baad3412130031e893d5c18cf1ed1cfb38b77ee64afd1ed2a33

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libfreetype6-dev libjpeg62-turbo-dev libpng-dev \
    && docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" mysqli gd \
    && rm -rf /var/lib/apt/lists/* \
    # La API REST de MantisBT enruta con mod_rewrite (api/rest/.htaccess).
    && a2enmod rewrite

RUN curl -fsSL -o /tmp/mantisbt.tar.gz \
        "https://downloads.sourceforge.net/project/mantisbt/mantis-stable/${MANTIS_VERSION}/mantisbt-${MANTIS_VERSION}.tar.gz" \
    && echo "${MANTIS_SHA256}  /tmp/mantisbt.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/mantisbt.tar.gz -C /var/www/html --strip-components=1 \
    && rm /tmp/mantisbt.tar.gz \
    # El código es de root y Apache (www-data) solo lo lee: si alguien lograra
    # ejecutar código como www-data, no podría dejar ficheros en la web. La
    # imagen base deja /var/www/html con permisos 1777; aquí se cierran.
    && chown -R root:root /var/www/html \
    && chmod -R u=rwX,go=rX /var/www/html

# php.ini de producción: los errores van al log del contenedor (docker logs), no a la página,
# para no enseñar rutas, consultas ni versiones a quien navega.
RUN cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY php.ini "$PHP_INI_DIR/conf.d/mantisbt.ini"
