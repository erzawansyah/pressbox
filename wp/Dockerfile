# One image for both the demo "live" site and every disposable sandbox.
# WordPress + WP-CLI + SQLite (no MySQL container needed, DB is one file = easy clone).
FROM wordpress:cli-php8.2

USER root
RUN apk add --no-cache curl unzip

# Not /var/www/html: the base image declares that path a VOLUME, which would give every
# sandbox a writable anonymous volume on the host disk despite --read-only.
RUN mkdir -p /srv/wordpress && chown www-data:www-data /srv/wordpress
WORKDIR /srv/wordpress
RUN php -d memory_limit=1024M /usr/local/bin/wp core download --allow-root --path=/srv/wordpress \
 && rm -rf wp-content/plugins/akismet wp-content/plugins/hello.php \
 && curl -fsSL -o /tmp/sqlite.zip https://downloads.wordpress.org/plugin/sqlite-database-integration.zip \
 && unzip -q /tmp/sqlite.zip -d wp-content/plugins/ && rm /tmp/sqlite.zip \
 && sed -e 's#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#/srv/wordpress/wp-content/plugins/sqlite-database-integration#' \
        -e 's#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#' \
        wp-content/plugins/sqlite-database-integration/db.copy > wp-content/db.php \
 && mkdir -p wp-content/database wp-content/mu-plugins wp-content/uploads wp-content/pb-backups \
 && chown -R www-data:www-data /srv/wordpress

# Generic wp-config: no live credentials ever. Salts are generated per container at start.
COPY --chown=www-data:www-data wp-config.php /srv/wordpress/wp-config.php
COPY pb/ /opt/pb/
# Sandboxes mount an empty size-capped tmpfs over wp-content; entry.sh seeds it from this copy.
RUN chmod +x /opt/pb/*.sh && cp -a /srv/wordpress/wp-content /opt/pb/wp-content-seed

ENV PHP_CLI_SERVER_WORKERS=4
USER www-data
EXPOSE 8080
ENTRYPOINT ["/opt/pb/entry.sh"]
