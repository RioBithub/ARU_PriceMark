#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:-pricemark.aruraharaja.co.id}"
APP_PORT="${APP_PORT:-3300}"
HESTIA="/usr/local/hestia"
BIN="$HESTIA/bin"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TPL_SRC="$ROOT_DIR/deploy/hestia/pricemark.tpl"
STPL_SRC="$ROOT_DIR/deploy/hestia/pricemark.stpl"

if [[ $EUID -ne 0 ]]; then
  echo "Jalankan sebagai root." >&2
  exit 1
fi

if [[ ! -x "$BIN/v-list-web-domains" ]]; then
  echo "HestiaCP tidak ditemukan di $HESTIA" >&2
  exit 1
fi

if [[ ! -f "$TPL_SRC" || ! -f "$STPL_SRC" ]]; then
  echo "File template PriceMark tidak ditemukan di deploy/hestia/." >&2
  exit 1
fi

if ! curl -fsS "http://127.0.0.1:$APP_PORT/health" >/dev/null; then
  echo "PriceMark belum sehat di 127.0.0.1:$APP_PORT. Batalkan perubahan Hestia." >&2
  exit 1
fi

OWNER=""
for conf in "$HESTIA"/data/users/*/web.conf; do
  [[ -f "$conf" ]] || continue
  if grep -Fq "$DOMAIN" "$conf"; then
    OWNER="$(basename "$(dirname "$conf")")"
    break
  fi
done

if [[ -z "$OWNER" ]]; then
  echo "Domain $DOMAIN tidak ditemukan pada user Hestia." >&2
  echo "Cek: $BIN/v-list-users" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/hestia-${DOMAIN//./_}-$STAMP"
mkdir -p "$BACKUP"

if [[ -d "/home/$OWNER/conf/web/$DOMAIN" ]]; then
  cp -a "/home/$OWNER/conf/web/$DOMAIN" "$BACKUP/domain-conf"
fi
cp -a "$HESTIA/data/users/$OWNER/web.conf" "$BACKUP/web.conf"

# Read Hestia stack type.
# shellcheck disable=SC1090
source "$HESTIA/conf/hestia.conf"

echo "Domain : $DOMAIN"
echo "Owner  : $OWNER"
echo "App    : http://127.0.0.1:$APP_PORT"
echo "Backup : $BACKUP"
echo "WEB_SYSTEM=${WEB_SYSTEM:-}"
echo "PROXY_SYSTEM=${PROXY_SYSTEM:-}"
echo "WEB_BACKEND=${WEB_BACKEND:-}"

if [[ "${PROXY_SYSTEM:-}" == "nginx" ]]; then
  DEST="$HESTIA/data/templates/web/nginx"
  install -m 0644 "$TPL_SRC" "$DEST/pricemark.tpl"
  install -m 0644 "$STPL_SRC" "$DEST/pricemark.stpl"

  echo "Memasang PriceMark sebagai Hestia Nginx proxy template..."
  "$BIN/v-change-web-domain-proxy-tpl" "$OWNER" "$DOMAIN" pricemark "jpg,jpeg,png,gif,webp,svg,ico,css,js,woff,woff2" no
elif [[ "${WEB_SYSTEM:-}" == "nginx" ]]; then
  if [[ -n "${WEB_BACKEND:-}" && -d "$HESTIA/data/templates/web/nginx/$WEB_BACKEND" ]]; then
    DEST="$HESTIA/data/templates/web/nginx/$WEB_BACKEND"
  else
    DEST="$HESTIA/data/templates/web/nginx"
  fi

  # Nginx-only Hestia uses web_port/web_ssl_port instead of proxy_port/proxy_ssl_port.
  sed 's/%proxy_port%/%web_port%/g' "$TPL_SRC" > "$DEST/pricemark.tpl"
  sed 's/%proxy_ssl_port%/%web_ssl_port%/g' "$STPL_SRC" > "$DEST/pricemark.stpl"
  chmod 0644 "$DEST/pricemark.tpl" "$DEST/pricemark.stpl"

  echo "Memasang PriceMark sebagai Hestia Nginx web template..."
  "$BIN/v-change-web-domain-tpl" "$OWNER" "$DOMAIN" pricemark no
else
  echo "Stack Hestia ini tidak dikenali otomatis." >&2
  echo "Tidak melakukan reload Nginx. Backup ada di $BACKUP" >&2
  exit 1
fi

echo
echo "Menguji konfigurasi Nginx..."
if ! nginx -t; then
  echo
  echo "NGINX TEST GAGAL. Nginx TIDAK direload." >&2
  echo "Backup config: $BACKUP" >&2
  echo "Kirim output nginx -t ini untuk rollback/perbaikan." >&2
  exit 1
fi

systemctl reload nginx

echo
echo "=== OK ==="
echo "Template PriceMark aktif untuk $DOMAIN"
echo "Nginx sudah direload."
echo
echo "Tes lokal domain:"
echo "  curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://$DOMAIN/"
echo
echo "Jika force-SSL aktif, HTTP seharusnya redirect ke HTTPS."
