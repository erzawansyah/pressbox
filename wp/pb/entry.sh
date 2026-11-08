#!/bin/sh
# Container entrypoint for both roles of the PressBox WordPress image.
#   PB_ROLE=live     production site: seed the demo site on first boot, then serve
#   PB_ROLE=sandbox  disposable copy: add the sandbox observer, then serve
# PB_PHP_MEMORY_LIMIT / PB_PHP_MAX_EXECUTION_TIME let a sandbox mirror production's limits.
set -e

php /opt/pb/salts.php > /tmp/pb-salts.php

MU=/var/www/html/wp-content/mu-plugins
mkdir -p "$MU"
cp /opt/pb/pressbox-agent.php "$MU/pressbox-agent.php"

if [ "$PB_ROLE" = "sandbox" ]; then
  cp /opt/pb/pb-observer.php "$MU/pb-observer.php"
fi

if [ "$PB_ROLE" = "live" ]; then
  /opt/pb/seed-live.sh
fi

# PB_ROLE is dropped so plugin code cannot tell a sandbox from production by reading it.
exec env -u PB_ROLE php \
  -d max_execution_time="${PB_PHP_MAX_EXECUTION_TIME:-20}" \
  -d memory_limit="${PB_PHP_MEMORY_LIMIT:-128M}" \
  -d display_errors=0 \
  -d log_errors=1 \
  -d error_log=/tmp/php-error.log \
  -S 0.0.0.0:8080 -t /var/www/html /opt/pb/router.php
