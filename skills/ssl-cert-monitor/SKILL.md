---
name: ssl-cert-monitor
description: Monitor SSL/TLS certificate expiry across Bobby Tours domains. Use in the weekly SSL routine (ssl-check) or when diagnosing HTTPS warnings. Alerts when certs are within 30 days of expiry.
---

# SSL Certificate Monitor

## When to use

- Every Monday 09:00 EAT (weekly routine `weekly-mon-09-EAT` fires this)
- When a user reports "this site is not secure" browser warning
- After DNS changes or CDN switches
- Before making domain-related changes

## Domains to monitor

1. `bobbytours.cloud` — Paperclip UI (Let's Encrypt, auto-renew via certbot timer)
2. `bobbysafaris.com`
3. `mountkilimanjaroclimb.com`
4. `magicaltanzania.com`
5. `safarikilimanjaro.com`
6. `safaris-tanzania.com`

Plus their `www.` subdomains.

## Alert thresholds

| Days to expiry | Action |
|---|---|
| > 30 | No action — healthy |
| 30–15 | Log. Routine posts a comment but doesn't alert Telegram. |
| 15–7 | Alert Telegram with link to ticket |
| ≤ 7 | URGENT — alert Telegram + tag operator in ticket |
| Expired | P0 incident — Telegram + ticket marked blocker |

## Procedure

1. **For each domain**, check cert expiry via openssl:
   ```bash
   for d in bobbysafaris.com mountkilimanjaroclimb.com magicaltanzania.com safarikilimanjaro.com safaris-tanzania.com bobbytours.cloud; do
     EXPIRY=$(echo | openssl s_client -servername "$d" -connect "$d:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
     if [ -z "$EXPIRY" ]; then
       echo "$d|ERROR|unable to fetch cert"
       continue
     fi
     DAYS=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
     echo "$d|$DAYS days|$EXPIRY"
   done
   ```

2. **Optionally check `www.` variants** (most Let's Encrypt certs include both — but verify):
   ```bash
   for d in bobbysafaris.com mountkilimanjaroclimb.com magicaltanzania.com safarikilimanjaro.com safaris-tanzania.com; do
     echo | openssl s_client -servername "www.$d" -connect "www.$d:443" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null | head -2
   done
   ```

3. **Check certbot timer status** (VPS auto-renewal):
   ```bash
   systemctl list-timers certbot.timer --no-pager
   certbot certificates 2>/dev/null | grep -E "(Certificate Name|Expiry|Domains)"
   ```

4. **Cross-check**: is Cloudways handling cert renewal for the 5 site domains? Or is this VPS? The sites run on Cloudways — their certs are managed by Cloudways, not this VPS's certbot.
   - **bobbytours.cloud** cert: managed here (certbot on VPS)
   - **5 site domains**: managed by Cloudways platform
   - If site cert is expiring and we don't control it: **escalate to user immediately** — they need to renew in Cloudways dashboard.

5. **Report format:**

   ```
   ## SSL cert expiry — weekly check
   
   | Domain | Days left | Expiry date | Status | Managed by |
   |---|---|---|---|---|
   | bobbytours.cloud | 58 | Jun 16 | ✅ healthy | VPS certbot |
   | bobbysafaris.com | 42 | May 31 | ✅ healthy | Cloudways |
   | mountkilimanjaroclimb.com | 12 | May 01 | ⚠ ACTION | Cloudways |
   | magicaltanzania.com | 45 | Jun 03 | ✅ healthy | Cloudways |
   | safarikilimanjaro.com | 38 | May 27 | ✅ healthy | Cloudways |
   | safaris-tanzania.com | 89 | Jul 17 | ✅ healthy | Cloudways |
   
   ### Action items
   - [ ] mountkilimanjaroclimb.com — renew in Cloudways within 5 days (12 days to expiry)
   
   ### Telegram notifications sent
   - ⚠ mountkilimanjaroclimb.com cert 12 days from expiry
   ```

6. **Send Telegram alerts for any domain with ≤15 days:**
   ```bash
   curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_REAL}/sendMessage" \
     -d chat_id="${TELEGRAM_DON_CHAT_ID}" \
     -d text="⚠ SSL cert for <domain> expires in <N> days ($(date -d "$EXPIRY" +%Y-%m-%d))"
   ```

## Common issues

| Issue | Likely cause | Fix |
|---|---|---|
| `openssl s_client` hangs or errors | DNS issue or firewall | `dig +short <domain>` — check A records resolve |
| "unable to fetch cert" on all domains | No network egress or TLS blocked | Check VPS egress; try from different host |
| Cert valid but browser shows warning | Cert/domain mismatch, intermediate cert missing | Check with `ssllabs.com/ssltest/analyze.html?d=<domain>` |
| Expiry date says "Jan 1 1970" or garbage | Parsing failed | Re-run with `openssl x509 -noout -text` to see raw |
| Cloudways cert expired on a site | Auto-renewal failed silently | Operator must fix in Cloudways panel — can't be done from VPS |

## Pitfalls

- `date -d` macOS vs Linux differs. On this VPS (Ubuntu), `date -d "<string>"` works.
- Cert on Cloudways is different from cert on origin. What matters is what the PUBLIC sees via `curl https://<domain>`. Test accordingly.
- Some Cloudways configs use Let's Encrypt through their own system. If you see a "Cloudways" issuer, it's via their LE integration.
- Not all of our domains have IPv6 — `-4` flag on openssl avoids wasting time on v6 attempts: `echo | openssl s_client -4 ...`.

## Related skills

- The `weekly-mon-09-EAT` routine invokes this skill on the bobby-safaris-devops agent
- `core-web-vitals-audit` — HTTPS issues cause CWV failures too (mixed content, slow TLS handshake)

## Budget

$0.02–0.05 per run. Cheap — it's just a loop + curl.
