#!/bin/sh
set -eu

cert_dir="${PAPERCLIP_TLS_CERT_DIR:-/etc/nginx/certs}"
cert_file="${PAPERCLIP_TLS_CERT_FILE:-$cert_dir/fullchain.pem}"
key_file="${PAPERCLIP_TLS_KEY_FILE:-$cert_dir/key.pem}"
server_name="${PAPERCLIP_TLS_SERVER_NAME:-localhost}"
alt_names="${PAPERCLIP_TLS_CERT_ALT_NAMES:-}"
if [ -z "$alt_names" ]; then
  if [ "$server_name" = "localhost" ]; then
    alt_names="DNS:localhost,IP:127.0.0.1"
  else
    alt_names="DNS:${server_name},DNS:localhost,IP:127.0.0.1"
  fi
fi
days="${PAPERCLIP_TLS_CERT_DAYS:-3650}"

mkdir -p "$cert_dir"

if [ -s "$cert_file" ] && [ -s "$key_file" ]; then
  echo "paperclip nginx: TLS certificate already exists at $cert_file"
  exit 0
fi

echo "paperclip nginx: generating self-signed TLS certificate for ${server_name} (${alt_names})"

tmp_cert="${cert_file}.tmp"
tmp_key="${key_file}.tmp"
rm -f "$tmp_cert" "$tmp_key"

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -days "$days" \
  -nodes \
  -keyout "$tmp_key" \
  -out "$tmp_cert" \
  -subj "/CN=${server_name}" \
  -addext "subjectAltName=${alt_names}"

chmod 600 "$tmp_key"
chmod 644 "$tmp_cert"
mv "$tmp_key" "$key_file"
mv "$tmp_cert" "$cert_file"
