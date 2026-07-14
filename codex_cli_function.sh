install_codex_cli() {
  log "Memastikan OpenAI Codex CLI terpasang dan terkonfigurasi..."
  local codex_config_dir="${HOME}/.codex"
  local codex_auth_file="${codex_config_dir}/auth.json"
  local codex_config_file="${codex_config_dir}/config.toml"

  # Install Codex CLI if not present
  if ! command_exists codex; then
    log "Menginstall @openai/codex..."
    if command_exists sudo; then
      run_root npm install -g @openai/codex || die "Gagal menginstall OpenAI Codex CLI."
    else
      npm install -g @openai/codex || die "Gagal menginstall OpenAI Codex CLI."
    fi
    log "OpenAI Codex CLI berhasil diinstall."
  else
    log "OpenAI Codex CLI sudah terpasang."
  fi

  # Ensure config directory exists (recreate if stale)
  if [[ -d "$codex_config_dir" ]]; then
    log "Direktori konfigurasi Codex sudah ada, akan diperbarui jika perlu."
  else
    log "Membuat direktori konfigurasi Codex: $codex_config_dir"
    mkdir -p "$codex_config_dir" || die "Gagal membuat direktori $codex_config_dir"
  fi

  # Generate auth.json from environment variables
  log "Membuat/memperbarui auth.json dari variabel environment..."
  
  # Validate required env vars
  [[ -z "${OPENAI_API_KEY:-}" ]] && die "OPENAI_API_KEY tidak diset di .env"

  cat > "$codex_auth_file" <<CODEX_AUTH_EOF
{
  "OPENAI_API_KEY": "${OPENAI_API_KEY}"
}
CODEX_AUTH_EOF

  # Generate config.toml from environment variables
  log "Membuat/memperbarui config.toml dari variabel environment..."

  cat > "$codex_config_file" <<CODEX_CONFIG_EOF
model_provider = "${CODEX_MODEL_PROVIDER:-openmodel}"
model = "${CODEX_MODEL:-deepseek-v4-flash}"
model_reasoning_effort = "${CODEX_MODEL_REASONING_EFFORT:-high}"
disable_response_storage = ${CODEX_DISABLE_RESPONSE_STORAGE:-true}
preferred_auth_method = "${CODEX_PREFERRED_AUTH_METHOD:-apikey}"

[model_providers.openmodel]
name = "openmodel"
base_url = "${CODEX_OPENMODEL_BASE_URL:-https://api.openmodel.ai/v1}"
wire_api = "responses"
CODEX_CONFIG_EOF

  log "OpenAI Codex CLI berhasil dikonfigurasi di $codex_config_dir"
}
