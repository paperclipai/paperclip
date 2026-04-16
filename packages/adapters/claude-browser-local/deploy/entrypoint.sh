#!/usr/bin/env bash
# Sidecar container entrypoint.
#
# 1. Applies iptables egress allowlist (drop everything not on the list).
# 2. Execs the sidecar process.
#
# Required capability: NET_ADMIN (set in docker-compose.yml).
# The allowlist is read from SURFER_EGRESS_ALLOWLIST (comma-separated hosts).
# Default is hardcoded for dev; production adds partner domains on hire.
#
# Allowlist logic:
#   - Allow outbound DNS (udp/tcp port 53) unconditionally so hostname resolution works.
#   - For each allowed host, resolve its A/AAAA records and allow outbound TCP
#     to those IPs on ports 80 and 443.
#   - Allow established/related traffic back in (connection state).
#   - DROP all other outbound.
#   - Inbound is unrestricted except the container has no published ports.

set -euo pipefail

log() { echo "[surfer-entrypoint] $*" >&2; }

# --------------------------------------------------------------------------
# Egress allowlist
# --------------------------------------------------------------------------

DEFAULT_ALLOWLIST="dev.to,2captcha.com,hcaptcha.com,challenges.cloudflare.com,api.paperclip.ing"
ALLOWLIST="${SURFER_EGRESS_ALLOWLIST:-$DEFAULT_ALLOWLIST}"

log "Applying iptables egress allowlist: $ALLOWLIST"

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow established/related (responses to our outbound connections)
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Always allow DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow each host in the allowlist
IFS=',' read -ra HOSTS <<< "$ALLOWLIST"
for host in "${HOSTS[@]}"; do
  host=$(echo "$host" | xargs)  # trim whitespace
  if [[ -z "$host" ]]; then
    continue
  fi
  # Resolve IPv4
  ipv4s=$(dig +short +timeout=3 A "$host" 2>/dev/null | grep -E '^[0-9]+\.' || true)
  for ip in $ipv4s; do
    log "Allow $host → $ip :80/443"
    iptables -A OUTPUT -d "$ip" -p tcp --dport 80  -j ACCEPT
    iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
  done
  # Resolve IPv6
  ipv6s=$(dig +short +timeout=3 AAAA "$host" 2>/dev/null | grep -E '^[0-9a-f:]+$' || true)
  for ip in $ipv6s; do
    log "Allow $host → $ip :80/443 (v6)"
    ip6tables -A OUTPUT -d "$ip" -p tcp --dport 80  -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
  done
done

# DROP everything else outbound
iptables -A OUTPUT -j DROP
log "Egress allowlist applied. DROP is now in effect for unlisted hosts."

# --------------------------------------------------------------------------
# Exec sidecar
# --------------------------------------------------------------------------
exec "$@"
