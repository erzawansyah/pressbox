#!/bin/sh
# Reset the demo production site (Senja Coffee) to its freshly seeded state.
# Deletes ONLY the demo site's volume. Run before a demo or a recording.
set -e
cd "$(dirname "$0")/.."
docker compose rm -sf live
docker volume rm pressbox_live_wp_content
docker compose up -d live
echo "Waiting for the demo site to seed..."
for attempt in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ | grep -q 200; then
    echo "Demo site is clean again: http://localhost:8080"
    exit 0
  fi
  sleep 1
done
echo "The demo site is not answering yet; check: docker compose logs live"
exit 1
