install_claude_cli() {
  log "Memastikan Claude Code CLI terpasang dan terkonfigurasi..."
  local claude_config_dir="${HOME}/.claude"
  local claude_settings_file="${claude_config_dir}/settings.json"

  # Install Claude CLI if not present
  if ! command_exists claude; then
    log "Menginstall @anthropic-ai/claude-code..."
    if command_exists sudo; then
      run_root npm install -g @anthropic-ai/claude-code || die "Gagal menginstall Claude Code CLI."
    else
      npm install -g @anthropic-ai/claude-code || die "Gagal menginstall Claude Code CLI."
    fi
    log "Claude Code CLI berhasil diinstall."
  else
    log "Claude Code CLI sudah terpasang."
  fi

  # Ensure config directory exists
  if [[ ! -d "$claude_config_dir" ]]; then
    log "Membuat direktori konfigurasi Claude: $claude_config_dir"
    mkdir -p "$claude_config_dir" || die "Gagal membuat direktori $claude_config_dir"
  fi

  # Generate settings.json from environment variables
  log "Membuat/memperbarui settings.json dari variabel environment..."
  
  # Validate required env vars
  [[ -z "${ANTHROPIC_API_KEY:-}" ]] && die "ANTHROPIC_API_KEY tidak diset di .env"
  [[ -z "${ANTHROPIC_BASE_URL:-}" ]] && die "ANTHROPIC_BASE_URL tidak diset di .env"

  cat > "$claude_settings_file" <<CLAUDE_EOF
{
  "env": {
    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL}",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${ANTHROPIC_DEFAULT_OPUS_MODEL:-deepseek-v4-flash}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${ANTHROPIC_DEFAULT_SONNET_MODEL:-deepseek-v4-flash}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-deepseek-v4-flash}"
  },
  "permissions": {
    "allow": [],
    "deny": []
  },
  "apiKeyHelper": "echo '${ANTHROPIC_API_KEY}'"
}
CLAUDE_EOF

  log "Claude Code CLI berhasil dikonfigurasi di $claude_settings_file"
}
