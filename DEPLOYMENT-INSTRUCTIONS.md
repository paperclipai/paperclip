# DEPLOYMENT-INSTRUCTIONS.md

## Paperclip VPS Deployment - Complete Guide

This document provides step-by-step instructions for deploying the updated Paperclip system to the VPS, including Claude Code CLI and OpenAI Codex CLI installation and configuration.

---

## Summary of Changes

The following files have been updated in this local repository:

1. **run.sh** - Complete implementation with:
   - `install_claude_cli()` - Idempotent Claude CLI installation with Linux paths (~/.claude/settings.json)
   - `install_codex_cli()` - Idempotent Codex CLI installation with Linux paths (~/.codex/auth.json, config.toml)
   - Traefik labels already present in `ensure_compose_file()`
   - Full error handling and verification

2. **.env** - Production environment configuration with actual credentials hardcoded

3. **.env.example** - Updated template with all CLI and Traefik configuration variables

---

## Prerequisites

Before deploying, ensure you have:

- SSH access to the VPS: `ubuntu@43.156.53.45`
- Password: `nebula-67%-river`
- The VPS already has:
  - Docker and Docker Compose installed
  - Traefik running on network `afiacloud-containers`
  - DNS record for `paperclip.carisinternational.com` pointing to VPS IP

---

## Deployment Steps

### Option 1: Manual Deployment (Recommended if SSH issues persist)

1. **Connect to VPS via SSH**
   ```bash
   ssh ubuntu@43.156.53.45
   # Password: nebula-67%-river
   ```

2. **Navigate to paperclip directory**
   ```bash
   cd /opt/paperclip
   ```

3. **Backup existing files**
   ```bash
   cp run.sh run.sh.backup-$(date +%Y%m%d-%H%M%S)
   cp .env .env.backup-$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
   ```

4. **Transfer updated files from your local machine**
   
   Open a new terminal on your Windows machine and run:
   ```powershell
   # From: C:\Users\admin\Downloads\paperclipandro\paperclip
   scp run.sh ubuntu@43.156.53.45:/opt/paperclip/run.sh
   scp .env ubuntu@43.156.53.45:/opt/paperclip/.env
   scp .env.example ubuntu@43.156.53.45:/opt/paperclip/.env.example
   ```
   
   Or use WinSCP/FileZilla to transfer:
   - `run.sh`
   - `.env`
   - `.env.example`

5. **Back on the VPS, set permissions**
   ```bash
   chmod +x run.sh
   chmod 600 .env
   ```

6. **Run the deployment**
   ```bash
   ./run.sh up
   ```

   This will:
   - Install Docker (if needed)
   - Install Node.js and pnpm (if needed)
   - Deploy Paperclip service with Traefik routing
   - Install and configure Claude Code CLI
   - Install and configure OpenAI Codex CLI
   - Run verification checks

7. **Monitor the deployment**
   
   The script will output progress. Watch for:
   - ✓ Service deployment completed
   - ✓ Claude CLI installed and configured
   - ✓ Codex CLI installed and configured
   - Verification results

---

### Option 2: Automated Deployment (If you have working SSH keys)

If you have SSH key authentication set up:

```bash
# From Windows (Git Bash or WSL):
cd /mnt/c/Users/admin/Downloads/paperclipandro/paperclip
bash deploy-vps.sh
```

---

## Verification

After deployment completes, verify all three objectives:

### 1. Paperclip Service (HTTPS with TLS)

```bash
curl -sSI https://paperclip.carisinternational.com
```

Expected output should include:
- `HTTP/2 200` or `HTTP/2 301/302` (redirect is OK)
- Valid TLS certificate from Let's Encrypt

### 2. Claude CLI

```bash
claude --version
```

Expected: Version number displayed

Check configuration:
```bash
cat ~/.claude/settings.json
```

Expected: JSON with correct API key and base URL

### 3. Codex CLI

```bash
codex -V
```

Expected: Version number displayed

Check configuration:
```bash
cat ~/.codex/auth.json
cat ~/.codex/config.toml
```

Expected: Correct API key and OpenModel configuration

---

## Manual Verification Checklist

- [ ] Paperclip accessible at https://paperclip.carisinternational.com with valid SSL
- [ ] `claude --version` returns version number
- [ ] `~/.claude/settings.json` exists with correct configuration
- [ ] `codex -V` returns version number
- [ ] `~/.codex/auth.json` exists with API key
- [ ] `~/.codex/config.toml` exists with correct model provider settings
- [ ] Docker containers running: `docker ps | grep paperclip`
- [ ] No errors in logs: `./run.sh logs`

---

## Idempotency Testing

To verify the script is idempotent (safe to re-run):

```bash
./run.sh down
./run.sh up
```

Then run again:
```bash
./run.sh up
```

Expected behavior:
- No duplicate installations
- No errors about existing files/configs
- Script should detect existing installations and skip redundant steps

---

## Troubleshooting

### Issue: Paperclip not accessible via HTTPS

**Check Traefik routing:**
```bash
docker logs traefik 2>&1 | grep paperclip
```

**Check Traefik network:**
```bash
docker network inspect afiacloud-containers
```

Expected: paperclip-app container should be listed

**Check DNS:**
```bash
nslookup paperclip.carisinternational.com
```

Expected: Should resolve to VPS IP 43.156.53.45

### Issue: Claude CLI not found

**Check installation:**
```bash
which claude
npm list -g @anthropic-ai/claude-code
```

**Check PATH:**
```bash
echo $PATH
```

**Reinstall manually:**
```bash
sudo npm install -g @anthropic-ai/claude-code
```

### Issue: Codex CLI not found

**Check installation:**
```bash
which codex
npm list -g @openai/codex
```

**Reinstall manually:**
```bash
sudo npm install -g @openai/codex
```

### Issue: Permission denied errors

**Fix permissions:**
```bash
chmod +x run.sh
chmod 600 .env
chmod 600 ~/.claude/settings.json
chmod 600 ~/.codex/auth.json
chmod 600 ~/.codex/config.toml
```

---

## Environment Variables Reference

The `.env` file contains all configuration. Key variables:

### Paperclip Configuration
- `PAPERCLIP_PUBLIC_URL` - https://paperclip.carisinternational.com
- `PAPERCLIP_DEPLOYMENT_MODE` - authenticated
- `PAPERCLIP_DEPLOYMENT_EXPOSURE` - public
- `BETTER_AUTH_SECRET` - Auth secret key
- `TRUST_PROXY` - 172.19.0.0/16 (for Traefik)

### Claude CLI Configuration
- `ANTHROPIC_API_KEY` - om-7hk48WkYHUjVhwYFND6hRioCmX8cYgDzmitMqvLpM
- `ANTHROPIC_BASE_URL` - https://api.openmodel.ai/v1
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` - 1
- `ANTHROPIC_DEFAULT_*_MODEL` - deepseek-v4-flash

### Codex CLI Configuration
- `OPENAI_API_KEY` - om-7hk48WkYHUjVhwYFND6hRioCmX8cYgDzmitMqvLpM
- `CODEX_MODEL_PROVIDER` - openmodel
- `CODEX_MODEL` - deepseek-v4-flash
- `CODEX_OPENMODEL_BASE_URL` - https://api.openmodel.ai/v1

### Traefik Configuration
- `TRAEFIK_NETWORK` - afiacloud-containers
- `TRAEFIK_CERTRESOLVER` - letsencrypt
- `TRAEFIK_DOMAIN` - paperclip.carisinternational.com

---

## Post-Deployment

After successful deployment:

1. **Test the Paperclip UI**
   - Navigate to https://paperclip.carisinternational.com
   - Verify login and basic functionality

2. **Test Claude CLI**
   ```bash
   cd /tmp
   mkdir test-claude
   cd test-claude
   echo "Test project" > README.md
   claude
   # Try a simple command like "help" or "exit"
   ```

3. **Test Codex CLI**
   ```bash
   cd /tmp
   mkdir test-codex
   cd test-codex
   echo "Test project" > README.md
   codex
   # Try a simple command like "help" or "exit"
   ```

4. **Monitor logs**
   ```bash
   ./run.sh logs
   ```

---

## Maintenance Commands

**View logs:**
```bash
cd /opt/paperclip
./run.sh logs
```

**Restart services:**
```bash
./run.sh restart
```

**Stop services:**
```bash
./run.sh down
```

**Update and redeploy:**
```bash
git pull origin main  # If using git
./run.sh restart
```

---

## Security Notes

- The `.env` file contains secrets and should never be committed to public repositories
- This repo is private, so credentials are hardcoded as per requirements
- SSH password authentication is enabled; consider setting up SSH keys for better security
- Review and rotate API keys periodically
- The `BETTER_AUTH_SECRET` should be changed to a strong random value in production

---

## Support

If issues persist after following this guide:

1. Check the logs: `./run.sh logs`
2. Verify all prerequisites are met
3. Review the VPS system logs: `journalctl -u docker -n 100`
4. Check Traefik logs: `docker logs traefik`
5. Verify network connectivity: `docker network ls`

---

**Deployment Date:** 2026-07-06
**Prepared by:** Kiro AI Assistant
**Repository:** https://github.com/wafiqmuhaz/paperclip (fork of paperclipai/paperclip)
