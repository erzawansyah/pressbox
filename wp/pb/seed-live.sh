#!/bin/sh
# Seeds the demo production site (Senja Coffee) once; later boots are a no-op.
# Runs as www-data inside the live container.
set -e
cd /var/www/html

if wp core is-installed >/dev/null 2>&1; then
  echo "[seed] Site already installed, skipping seed."
  exit 0
fi

echo "[seed] Installing the Senja Coffee demo site..."
mkdir -p wp-content/database wp-content/plugins

wp core install \
  --url="${PB_HOME:-http://localhost:8080}" \
  --title="Senja Coffee" \
  --admin_user=owner \
  --admin_password="${LIVE_ADMIN_PASSWORD:-senja-demo-2026}" \
  --admin_email=owner@senjacoffee.example \
  --skip-email

wp option update blogdescription "Hand-brewed coffee in the heart of Malang"
wp option update timezone_string "Asia/Jakarta"
wp rewrite structure ""

# The one and only custom plugin of this site.
cp -r /opt/pb/plugin-seed/senja-coffee wp-content/plugins/
wp plugin activate senja-coffee

# Remove WordPress sample content.
wp post delete 1 --force >/dev/null 2>&1 || true
wp post delete 2 --force >/dev/null 2>&1 || true

page() {
  wp post create --post_type=page --post_status=publish --post_title="$1" --post_name="$2" --menu_order="$3" \
    --post_content="$(cat "/opt/pb/content/$2.html")" --porcelain
}
HOME_ID=$(page "Home" home 1)
page "Menu" menu 2 >/dev/null
page "About" about 3 >/dev/null
page "Contact" contact 4 >/dev/null

wp option update show_on_front page
wp option update page_on_front "$HOME_ID"

# Settings that look like real credentials, so the sandbox sanitizer has something to redact.
wp option add senja_payment_server_key "live-server-key-DEMO-7f3a91" >/dev/null
wp option add senja_smtp_password "smtp-pass-DEMO-2b8c44" >/dev/null

echo "[seed] Done. Admin user: owner"
