#!/bin/sh
# Reset the demo live site (Kedai Kopi Senja) to its freshly seeded state.
# Deletes ONLY the demo live volume. Use before a demo run or recording.
set -e
cd "$(dirname "$0")/.."
docker compose rm -sf live
docker volume rm pressbox_live_wp_content
docker compose up -d live
echo "Menunggu seed situs live..."
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ | grep -q 200; then
    echo "Situs live bersih kembali: http://localhost:8080"
    exit 0
  fi
  sleep 1
done
echo "Situs live belum merespons; cek: docker compose logs live"
exit 1
