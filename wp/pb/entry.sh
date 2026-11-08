#!/bin/sh
# Container entrypoint for both roles of the PressBox WordPress image.
#   PB_ROLE=live     production site: seed the demo site on first boot, then serve
#   PB_ROLE=sandbox  disposable copy: add the sandbox observer, then serve
# PB_PHP_MEMORY_LIMIT / PB_PHP_MAX_EXECUTION_TIME let a sandbox mirror production's limits.
set -e

php /opt/pb/salts.php > /tmp/pb-salts.php

CONTENT=/srv/wordpress/wp-content
# A sandbox starts with an empty tmpfs over wp-content (its only writable place besides /tmp).
if [ "$PB_ROLE" = "sandbox" ] && [ ! -d "$CONTENT/plugins" ]; then
  cp -a /opt/pb/wp-content-seed/. "$CONTENT/"
fi

MU="$CONTENT/mu-plugins"
mkdir -p "$MU"
cp /opt/pb/pressbox-agent.php "$MU/pressbox-agent.php"

if [ "$PB_ROLE" = "sandbox" ]; then
  cp /opt/pb/pb-observer.php "$MU/pb-observer.php"
  # Tells the control plane it may now copy the production database and plugin in.
  touch /tmp/pb-seeded
fi

if [ "$PB_ROLE" = "live" ]; then
  /opt/pb/seed-live.sh
fi

# PB_ROLE is dropped so plugin code cannot tell a sandbox from production by reading it.
# Runtime guard for code the static scan misses: no process spawning, no URL file reads.
# Applies to web requests only; WP-CLI keeps its normal php.ini.
DISABLED_FUNCTIONS=exec,shell_exec,system,passthru,proc_open,popen,pcntl_exec,dl,putenv
exec env -u PB_ROLE php \
  -d disable_functions="$DISABLED_FUNCTIONS" \
  -d allow_url_fopen=0 \
  -d max_execution_time="${PB_PHP_MAX_EXECUTION_TIME:-20}" \
  -d memory_limit="${PB_PHP_MEMORY_LIMIT:-128M}" \
  -d display_errors=0 \
  -d log_errors=1 \
  -d error_log=/tmp/php-error.log \
  -S 0.0.0.0:8080 -t /srv/wordpress /opt/pb/router.php
