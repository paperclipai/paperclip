#!/usr/bin/env bash
# ================================================================
# deploy-seo.sh — Deploy Technical SEO Artifacts to Live Servers
# ================================================================
# Usage:
#   export DJTECH_SSH_HOST_IN="djtechnologies.in"
#   export DJTECH_SSH_HOST_UK="djtechnologies.uk"
#   export DJTECH_SSH_HOST_NET="djtechnologies.net"
#   export DJTECH_SSH_USER="root"
#   export DJTECH_SSH_KEY_PATH="/path/to/ssh-key"
#   bash deploy-seo.sh
#
# Or provide SSH config inline:
#   bash deploy-seo.sh --ssh-host-in 185.158.133.1 --ssh-user deploy ...
#
# Prerequisites:
#   - SSH key with access to all 3 servers
#   - Ability to edit <head> on SPA sites (.in, .uk)
#   - Google Search Console ownership verified
#   - GA4 account created
# ================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --------------- Config ---------------
SSH_USER="${DJTECH_SSH_USER:-root}"
SSH_KEY="${DJTECH_SSH_KEY_PATH:-}"
SSH_PORT="${DJTECH_SSH_PORT:-22}"
WEB_ROOT_IN="${DJTECH_WEB_ROOT_IN:-/var/www/djtechnologies.in}"
WEB_ROOT_UK="${DJTECH_WEB_ROOT_UK:-/var/www/djtechnologies.uk}"
WEB_ROOT_NET="${DJTECH_WEB_ROOT_NET:-/var/www/djtechnologies.net}"

# Parse CLI args
while [[ $# -gt 0 ]]; do
  case $1 in
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --ssh-port) SSH_PORT="$2"; shift 2 ;;
    --web-root-in) WEB_ROOT_IN="$2"; shift 2 ;;
    --web-root-uk) WEB_ROOT_UK="$2"; shift 2 ;;
    --web-root-net) WEB_ROOT_NET="$2"; shift 2 ;;
    --host-in) HOST_IN="$2"; shift 2 ;;
    --host-uk) HOST_UK="$2"; shift 2 ;;
    --host-net) HOST_NET="$2"; shift 2 ;;
    --skip-phases) SKIP_PHASES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

HOST_IN="${HOST_IN:-${DJTECH_SSH_HOST_IN:-}}"
HOST_UK="${HOST_UK:-${DJTECH_SSH_HOST_UK:-}}"
HOST_NET="${HOST_NET:-${DJTECH_SSH_HOST_NET:-}}"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
[[ -n "$SSH_KEY" ]] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

DRY_RUN="${DRY_RUN:-0}"

SEP="================================================================"

# --------------- Helpers ---------------
info()  { echo -e "\n$SEP\n>>> $1\n$SEP"; }
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[DRY-RUN] $*"
  else
    echo "[RUN] $*"
    "$@"
  fi
}
ssh_cmd() {
  local host="$1"; shift
  ssh $SSH_OPTS -p "$SSH_PORT" "${SSH_USER}@${host}" "$@"
}
scp_cmd() {
  local host="$1"; shift
  scp $SSH_OPTS -P "$SSH_PORT" "$@"
}

# --------------- Validation ---------------
if [[ -z "$HOST_IN" && -z "$HOST_UK" && -z "$HOST_NET" ]]; then
  echo "ERROR: No hosts configured. Set DJTECH_SSH_HOST_IN/UK/NET or pass --host-*"
  exit 1
fi

SKIP="${SKIP_PHASES:-}"

# ================================================================
echo "$SEP"
echo "  DJ Technologies — Technical SEO Deployment"
echo "  $(date -u)"
echo "$SEP"

# ================================================================
# PHASE 1: Deploy robots.txt + Sitemaps
# ================================================================
if [[ "$SKIP" != *"1"* ]]; then
  info "PHASE 1/4: Deploy robots.txt + Sitemaps"

  # --- djtechnologies.in ---
  if [[ -n "$HOST_IN" ]]; then
    info "→ djtechnologies.in"
    run scp_cmd "$HOST_IN" \
      "$SCRIPT_DIR/07-robots-djtechnologies.in.txt" \
      "${SSH_USER}@${HOST_IN}:${WEB_ROOT_IN}/robots.txt"
    run scp_cmd "$HOST_IN" \
      "$SCRIPT_DIR/05-sitemap-djtechnologies.in.xml" \
      "${SSH_USER}@${HOST_IN}:${WEB_ROOT_IN}/sitemap.xml"
    # Verify
    run ssh_cmd "$HOST_IN" "ls -la ${WEB_ROOT_IN}/robots.txt ${WEB_ROOT_IN}/sitemap.xml"
  else
    echo "SKIP: No host configured for djtechnologies.in"
  fi

  # --- djtechnologies.uk ---
  if [[ -n "$HOST_UK" ]]; then
    info "→ djtechnologies.uk"
    run scp_cmd "$HOST_UK" \
      "$SCRIPT_DIR/08-robots-djtechnologies.uk.txt" \
      "${SSH_USER}@${HOST_UK}:${WEB_ROOT_UK}/robots.txt"
    run scp_cmd "$HOST_UK" \
      "$SCRIPT_DIR/06-sitemap-djtechnologies.uk.xml" \
      "${SSH_USER}@${HOST_UK}:${WEB_ROOT_UK}/sitemap.xml"
    run ssh_cmd "$HOST_UK" "ls -la ${WEB_ROOT_UK}/robots.txt ${WEB_ROOT_UK}/sitemap.xml"
  else
    echo "SKIP: No host configured for djtechnologies.uk"
  fi

  # --- djtechnologies.net (append AI rules to existing robots.txt) ---
  if [[ -n "$HOST_NET" ]]; then
    info "→ djtechnologies.net (append AI crawler rules)"
    run ssh_cmd "$HOST_NET" "
      cat >> ${WEB_ROOT_NET}/robots.txt << 'EOF'

# AI-specific crawlers
User-agent: ChatGPT-User
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: YouBot
Allow: /

User-agent: anthropic-ai
Allow: /

Crawl-delay: 1
EOF
    "
  else
    echo "SKIP: No host configured for djtechnologies.net"
  fi
fi

# ================================================================
# PHASE 2: Inject JSON-LD Schema Markup
# ================================================================
if [[ "$SKIP" != *"2"* ]]; then
  info "PHASE 2/4: Inject JSON-LD Schema Markup into <head>"

  if [[ -n "$HOST_IN" || -n "$HOST_UK" ]]; then
    info "Generating schema injection HTML fragment..."

    SCHEMA_HTML="$SCRIPT_DIR/_schema-head.html"
    cat > "$SCHEMA_HTML" << 'HEADEOF'
<!-- Schema: Organization + LocalBusiness -->
<script type="application/ld+json">
HEADEOF
    cat "$SCRIPT_DIR/01-organization-localbusiness-schema.jsonld" >> "$SCHEMA_HTML"
    cat >> "$SCHEMA_HTML" << 'HEADEOF'
</script>

<!-- Schema: FAQPage -->
<script type="application/ld+json">
HEADEOF
    cat "$SCRIPT_DIR/02-faq-schema.jsonld" >> "$SCHEMA_HTML"
    cat >> "$SCHEMA_HTML" << 'HEADEOF'
</script>

<!-- Schema: Product/Service -->
<script type="application/ld+json">
HEADEOF
    cat "$SCRIPT_DIR/03-service-schema.jsonld" >> "$SCHEMA_HTML"
    cat >> "$SCHEMA_HTML" << 'HEADEOF'
</script>

<!-- Schema: BreadcrumbList + WebSite -->
<script type="application/ld+json">
HEADEOF
    cat "$SCRIPT_DIR/04-article-breadcrumb-schema.jsonld" >> "$SCHEMA_HTML"
    cat >> "$SCHEMA_HTML" << 'HEADEOF'
</script>

<!-- Schema: Comparison Table -->
<script type="application/ld+json">
HEADEOF
    cat "$SCRIPT_DIR/12-comparison-table-schema.jsonld" >> "$SCHEMA_HTML"
    cat >> "$SCHEMA_HTML" << 'HEADEOF'
</script>
HEADEOF

    echo "Schema fragment generated at: $SCHEMA_HTML"

    if [[ -n "$HOST_IN" ]]; then
      info "Upload schema fragment to djtechnologies.in server"
      run scp_cmd "$HOST_IN" "$SCHEMA_HTML" "${SSH_USER}@${HOST_IN}:${WEB_ROOT_IN}/_schema-head.html"
    fi
    if [[ -n "$HOST_UK" ]]; then
      info "Upload schema fragment to djtechnologies.uk server"
      run scp_cmd "$HOST_UK" "$SCHEMA_HTML" "${SSH_USER}@${HOST_UK}:${WEB_ROOT_UK}/_schema-head.html"
    fi

    echo ""
    echo "NOTE: For Lovable SPAs, servers inject via Lovable project settings."
    echo "Manual step required: Edit index.html/head template to include _schema-head.html"
  fi

  if [[ -n "$HOST_NET" ]]; then
    info "Upload schema files to djtechnologies.net (WHMCS)"
    for f in 01-organization-localbusiness-schema.jsonld 02-faq-schema.jsonld \
             03-service-schema.jsonld 04-article-breadcrumb-schema.jsonld \
             12-comparison-table-schema.jsonld; do
      run scp_cmd "$HOST_NET" "$SCRIPT_DIR/$f" "${SSH_USER}@${HOST_NET}:${WEB_ROOT_NET}/_seo/${f}"
    done
    echo "WHMCS: Add schema blocks via System Settings → Other → Head Output"
  fi

  rm -f "$SCHEMA_HTML"
fi

# ================================================================
# PHASE 3: GA4 Setup Guide (Manual)
# ================================================================
if [[ "$SKIP" != *"3"* ]]; then
  info "PHASE 3/4: GA4 Setup"

  echo "GA4 setup is a manual process requiring Google Analytics account access."
  echo ""
  echo "Steps:"
  echo "  1. Create GA4 property at https://analytics.google.com"
  echo "  2. Add 3 data streams (djtechnologies.in, .uk, .net)"
  echo "  3. Inject tracking code from 10-ga4-implementation-guide.md"
  echo "  4. Enable cross-domain tracking"
  echo "  5. Verify with GA4 Realtime report"
  echo ""
  echo "Full guide: $SCRIPT_DIR/10-ga4-implementation-guide.md"
fi

# ================================================================
# PHASE 4: Search Console Submission (Manual)
# ================================================================
if [[ "$SKIP" != *"4"* ]]; then
  info "PHASE 4/4: Submit to Search Engines"

  echo "Search Console submission is manual. Requires domain ownership verification."
  echo ""
  echo "Steps:"
  echo "  1. Add domains to Google Search Console:"
  echo "     - https://search.google.com/search-console"
  echo "     - Properties: djtechnologies.in, djtechnologies.uk, djtechnologies.net"
  echo "  2. Verify ownership (DNS TXT record or HTML file)"
  echo "  3. Submit sitemaps:"
  echo "     - https://djtechnologies.in/sitemap.xml"
  echo "     - https://djtechnologies.uk/sitemap.xml"
  echo "     - https://djtechnologies.net/sitemap.xml"
  echo "  4. Repeat for Bing Webmaster Tools"
  echo "  5. Request manual indexing of homepage"
fi

# ================================================================
# Verification
# ================================================================
info "VERIFICATION"

echo "After deployment, verify with these checks:"
echo ""
echo "  curl https://djtechnologies.in/robots.txt | head -5"
echo "  curl https://djtechnologies.in/sitemap.xml | head -5"
echo "  curl -s https://djtechnologies.in | grep 'application/ld+json'"
echo "  curl -s https://djtechnologies.in | grep 'gtag'"
echo ""
echo "Rich Results Test: https://search.google.com/test/rich-results"
echo "Mobile-Friendly Test: https://search.google.com/test/mobile-friendly"
echo "PageSpeed Insights: https://pagespeed.web.dev"

echo ""
echo "$SEP"
echo "  Deployment script finished."
echo "  $(date -u)"
echo "$SEP"
