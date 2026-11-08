#!/bin/sh
# Container entrypoint for both roles.
#   PB_ROLE=live     seed the demo coffee-shop site on first boot, then serve
#   PB_ROLE=sandbox  install the observer mu-plugin, then serve
set -e

php /opt/pb/salts.php > /tmp/pb-salts.php

if [ "$PB_ROLE" = "sandbox" ]; then
  cp /opt/pb/pb-observer.php /var/www/html/wp-content/mu-plugins/pb-observer.php
fi

if [ "$PB_ROLE" = "live" ]; then
  /opt/pb/seed-live.sh
fi

# Hard per-request limits (containment rule 3). Memory/CPU/PID limits are set by docker run.
exec php \
  -d max_execution_time=20 \
  -d memory_limit=128M \
  -d display_errors=0 \
  -d log_errors=1 \
  -d error_log=/tmp/php-error.log \
  -S 0.0.0.0:8080 -t /var/www/html /opt/pb/router.php
