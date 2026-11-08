#!/bin/sh
# Seeds the demo "live" site once (idempotent). Runs as www-data inside the live container.
set -e
cd /var/www/html

if wp core is-installed >/dev/null 2>&1; then
  echo "[seed] Situs live sudah ada, lewati seed."
  exit 0
fi

echo "[seed] Memasang situs demo Kedai Kopi Senja..."
mkdir -p wp-content/database wp-content/plugins

wp core install \
  --url="${PB_HOME:-http://localhost:8080}" \
  --title="Kedai Kopi Senja" \
  --admin_user=pemilik \
  --admin_password="${LIVE_ADMIN_PASSWORD:-senja-demo-2026}" \
  --admin_email=pemilik@kedaisenja.example \
  --skip-email

wp option update blogdescription "Kopi seduh manual di sudut kota"
wp option update timezone_string "Asia/Jakarta"
wp option update date_format "j F Y"
wp rewrite structure ""

# The one and only custom plugin of this site.
cp -r /opt/pb/plugin-seed/kedai-senja-custom wp-content/plugins/
wp plugin activate kedai-senja-custom

# Remove default sample content.
wp post delete 1 --force >/dev/null 2>&1 || true
wp post delete 2 --force >/dev/null 2>&1 || true

BERANDA=$(wp post create --post_type=page --post_status=publish --post_title="Beranda" --post_name=beranda --menu_order=1 --post_content="$(cat /opt/pb/content/beranda.html)" --porcelain)
wp post create --post_type=page --post_status=publish --post_title="Menu" --post_name=menu --menu_order=2 --post_content="$(cat /opt/pb/content/menu.html)" --porcelain >/dev/null
wp post create --post_type=page --post_status=publish --post_title="Tentang" --post_name=tentang --menu_order=3 --post_content="$(cat /opt/pb/content/tentang.html)" --porcelain >/dev/null
wp post create --post_type=page --post_status=publish --post_title="Kontak" --post_name=kontak --menu_order=4 --post_content="$(cat /opt/pb/content/kontak.html)" --porcelain >/dev/null

wp option update show_on_front page
wp option update page_on_front "$BERANDA"

# Settings that look like real secrets, so the sandbox sanitizer has something to redact in the demo.
wp option add kss_payment_server_key "live-server-key-DEMO-7f3a91" >/dev/null
wp option add kss_smtp_password "smtp-pass-DEMO-2b8c44" >/dev/null

echo "[seed] Selesai. Admin: pemilik"
