# Genesis Website Guardrails — single source of truth (Paperclip)

**Status:** CANONICAL — every Genesis-touching Paperclip agent MUST read this file at the start of every run. The file lives in the company-wide `shared/` directory. Each agent's `AGENTS.md` also inlines the full body of this file at the top so the rules are physically present in the agent's prompt even if the agent didn't read the canonical path on disk.

**Last updated:** 2026-07-25 (post-rn/xa0/LLM-box regression hardening)

This document is intentionally one file so rules do not drift between `AGENTS.md`, `HEARTBEAT.md`, and per-role workflow docs. If a rule contradicts this file, **this file wins**. If you need to change a rule here, edit THIS file — do NOT edit the inlined copy in each agent's `AGENTS.md`. The inlined copy is generated from this canonical source.

---

## 0. Read-first contract

Before you take ANY action on `genesismotiondesign.com`, you MUST have read this file end-to-end in the current run. The Paperclip runtime injects it via the agent instructions bundle, so reading `AGENTS.md` brings it into your context — but you must treat that as a load-bearing pre-condition. If you are acting on a stale session or the file isn't in your context, fetch it from `shared/GENESIS-WEBSITE-GUARDRAILS.md` before continuing.

Self-check at the top of every task comment (CTO, CMO, UXDesigner, Coder):

```
GENESIS-GUARDRAILS read: YES (timestamp)
Wall status (run /tmp/genesis-content-healthcheck.sh): L1 OK / L2 OK / L5 OK / L6 OK
Task touches post_content? YES / NO → apply Section 5
Task touches protected page? YES / NO → apply Section 6
```

If the Wall status check fails, STOP and route to the CTO before doing anything else.

---

## 1. Do-Not-Touch Inventory

These files / surfaces MUST NOT be modified by any agent without an explicit `request_confirmation` interaction accepted by Benjamin Ang AND a full pre-deploy audit. Any agent that proposes a change to one of these MUST escalate, not implement.

### 1.1 Safety-critical mu-plugins (`/wp-content/mu-plugins/`)

| File | Purpose | Risk if modified |
|---|---|---|
| `gen816-csp.php` (currently `.disabled-*`) | Content-Security-Policy header | Re-enabling breaks the entire site. **Never re-enable** without staging testing. |
| `genesis-complete-fix.php` | Core Genesis theme patches | Breaks theme layout |
| `genesis-design-system-safe.php` | Design CSS variables | Breaks all colors/typography |
| `genesis-isotope-grid-fallback.php` | Case-studies portfolio grid | Breaks portfolio page layout |
| `genesis-lcp-safe.php` | LCP optimizations | Breaks page-load performance |
| `genesis-content-safety-guard.php` | Closure-based `wp_insert_post_data` filter; protects GENESIS_PROTECTED post IDs | Removing it disables L1 of the Wall. Bypass only via `GENESIS_SAFETY_BYPASS=1`. |
| `genesis-content-safety.php` | Named-function content safety filter (L1 of the Wall, plugin 1 of 2) | Breaks content rendering / re-opens the silent-lie trap |
| `genesis-2026-07-09-ux-fixes.php` | Nav menu + header logo CSS (July 10 incident fix) | Reverts nav menu and hides Genesis logo |
| `genesis-lazy-media-materializer.php` | Image/video lazy-load materialization | Breaks all images on site |
| `genesis-core-fix` (inline script) | Video broken-src recovery | Breaks video embeds |
| `gen631-redirects.php` | Canonical redirects | Breaks URL structure |
| `genesis-clean-blank-n.php` | L5 render-time mu-plugin (priority 99999) — strips visible "n" artifacts | Removing it brings back visible "n" letters site-wide |
| `genesis-hide-broken-llm-boxes.php` | Hides the gen977 LLM-keyword boxes when broken/empty | Removing it exposes broken boxes to visitors |
| `fix-logo-hover.php` | Logo hover-state CSS | Reverts logo hover bug |

### 1.2 Critical infrastructure

| Path | Risk |
|---|---|
| `/.htaccess` | Redirect loops, 500 errors; Cloudflare caches the broken state for 7 days. Requires `GENESIS_ALLOW_HTACCESS=1` flag. |
| `/wp-content/themes/stukram/` (entire theme) | Breaks visual rendering site-wide |
| `wp-content/themes/stukram/includes/js/main-no-ajax.js` | Site-wide JS boot chain; one syntax error breaks counters, Swiper, lazy media. **Historical incident: July 9, 2026 — Paperclip patch inserted extra closing `})();` here, full JS boot failure.** |
| `wp-content/themes/stukram/includes/js/vendors.js` | Theme dependency bundle |
| `wp-content/themes/stukram/includes/js/vendors-core.js` | Theme dependency bundle |
| `wp-content/themes/stukram/header.php` | Theme header rendering |
| `wp-content/themes/stukram/includes/js.php` | Theme script enqueue/render path — also handles cache-bust version |
| Cloudflare zone | CDN caching rules |
| LiteSpeed Cache settings (`litespeed.conf`) | `css_combine` MUST stay `false`; `js_combine` should stay off for theme JS files |

---

## 2. Six-layer Wall (JULY 21 INCIDENT — rn/xa0 corruption)

Every `post_content` write on Genesis is auto-checked by six layers. The agent's job is **not to bypass any of these** — the agent's job is to verify the layers are healthy before the write and to use safe write paths so the layers don't even need to fire.

| Layer | Mechanism | What it catches | Verify |
|---|---|---|---|
| L1 | `genesis-content-safety-guard.php` mu-plugin — closure-based filter on `wp_insert_post_data` | rn/xa0 patterns in any WP-CLI / REST / Application Password write | `get_mu_plugins()` shows it loaded |
| L2 | `genesis_rn_corruption_trigger` MySQL `BEFORE UPDATE` trigger on `wp_posts` — `SIGNAL SQLSTATE '45000'` | Direct SQL `UPDATE` that bypasses WordPress entirely (the suspected JULY 21 root-cause path) | `SHOW TRIGGERS WHERE \`Trigger\` LIKE 'genesis%'` |
| L3 | `/tmp/genesis-rn-audit.sh` daily cron | DB-level regressions (writes report to `wp-content/uploads/genesis-audit-reports/`) | cron entry `0 1 * * * /bin/bash /tmp/genesis-rn-audit.sh` |
| L4 | `/tmp/fix-rn-corruption-v2.php` (and v1) | Bare-`\n` characters at WPBakery shortcode boundaries that survived v1 | Run if L3/L6 flags hits |
| L5 | `genesis-clean-blank-n.php` mu-plugin at `the_content` priority **99999** (not 999 — see filter timing rule below) | Visible "n" / "rn" / "xa0" artifacts in rendered HTML | `get_mu_plugins()` shows it loaded; run `/tmp/genesis-content-healthcheck.sh` |
| L6 | `/tmp/genesis-content-healthcheck.sh` daily cron | Rendered-HTML audit + mu-plugin health check | cron entry + last report in `/home/genesismotiondesign.com/public_html/wp-content/uploads/genesis-audit-reports/` |

### 2.1 Filter-timing rule (CRITICAL — most common mistake)

If you write a new render-time `the_content` filter to handle visible "n" artifacts, **do NOT use priority 999**. By the time priority 999 fires, WordPress has already run `wpautop(10)` and `do_shortcode(11)`, which have transformed literal shortcode text into HTML. The `]\n[` and `]\n<!--` patterns you want to clean up no longer exist by then.

**Always use priority 99999** and target the **rendered HTML output**:
- `</element>n<element` (e.g. `</h3>n<div`)
- `--n<!--` (e.g. `Genesis.n<!--`)
- `<p>n</p>`, `<p([^>]*)>\s*n\s*(<!--`, empty `<p></p>`

Reference skill: `genesis-render-time-cleanup-pattern`. Load it BEFORE writing any `the_content` filter.

### 2.2 Wall-health self-check (run before any post_content work)

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
  "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ eval-file /tmp/genesis-content-healthcheck.sh"
```

The script outputs a 4-section report. All four sections must say OK. If any section says FAIL, **STOP** and either run the fix script or escalate to the CTO. Do not proceed with content work while the Wall is degraded.

### 2.3 Order of operations when fixing content directly in the DB (JULY 23 INCIDENT — Redis cache trap)

If you must do a raw `$dbh->query("UPDATE wp_posts SET post_content=...")`:

1. Drop L2 trigger — otherwise it blocks the UPDATE with SQLSTATE 45000.
2. Rename L1 mu-plugins (`genesis-content-safety-guard.php` → `.bak-fix-<timestamp>`) — otherwise the L1 filter silently reverts the write.
3. Do the raw UPDATE.
4. **`clean_post_cache($pid)` AND `wp_cache_flush()`** — Redis object cache. **This is the biggest hidden gotcha.** Without it, the live page keeps showing the OLD content even though `$dbh->affected_rows` is 1, because `get_post()` reads from `wp_cache_get('post_45')` first.
5. Purge Litespeed (`wp litespeed-purge all`).
6. Re-create L2 trigger (use `/tmp/install-rn-trigger.php`; nested `IF/END IF`, not `ELSEIF` — MariaDB rejects `ELSEIF` in trigger bodies).
7. Re-enable L1 mu-plugins.
8. Verify with `curl` that the live page reflects the change.

---

## 3. Pre-write diagnostic (REQUIRED before any post_content write)

Run this **before** the write. Expected output: `count=0`. If count > 0, run the fix scripts in Section 2.2 first and re-run the diagnostic.

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
  "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ db query \"SELECT COUNT(*) FROM wp_posts WHERE post_content LIKE '%rnrn%' OR post_content LIKE '%>rn%' OR post_content LIKE '%xa0%' OR post_content LIKE '%rn<%'\""
```

---

## 4. Write paths — safe vs unsafe

| Path | Safe? | Why |
|---|---|---|
| `wp post update N --post_content="..."` (short strings, shell-safe) | ✅ Safe | Bytes round-trip |
| `wp eval` with content baked into a PHP string | ✅ Safe | Use `wp_update_post` inside the eval |
| REST API with JSON body | ✅ Safe | Bytes round-trip |
| `jq -r .content` piped to `wp post update --post_content=@file` | ⚠️ Risky | `jq -r` is the documented failure mode. Strip CRLF/& first, or use base64 |
| `mysql ... -e "UPDATE wp_posts SET post_content=..."` | ❌ Avoid | L2 trigger blocks unless you drop it first; L1 also blocks at application layer |
| `UPDATE wp_posts SET post_content=FROM_BASE64('...')` | ⚠️ Highest risk | This was the GEN-621 KB `conventions` pattern suspected in the JULY 21 incident. **Pre-encoding step (jq filter / shell heredoc) is where `\r` (0x0d) and `&` (0x26) get stripped.** Verify base64 round-trips intact before applying. |

### 4.1 The hard rule

**Never pass `post_content` through `jq -r`, `sed`, or `tr` without explicit character-class protection** — protecting the bytes `\r` (CR) and `&` (HTML entity prefix). Suspected root cause of the JULY 21 incident: a `jq -r` filter in the pre-encoding step stripped both bytes.

Safe shell pattern:

```bash
CONTENT=$(cat /tmp/page.html | jq -Rs '.' | jq -r '.[0]' | sed 's/\\r/\\r/g')  # explicit CR escape
wp post update $ID --post_content="$CONTENT"
```

Or simpler — bypass shell entirely:

```bash
sudo -u genes8393 wp eval '
  putenv("GENESIS_SAFETY_BYPASS=1");
  remove_all_filters("wp_insert_post_data");
  $r = wp_update_post(["ID" => N, "post_content" => file_get_contents("/tmp/page.html")]);
  echo is_wp_error($r) ? "ERR: ".$r->get_error_message() : "OK";
'
```

---

## 5. Content-write guardrails (apply whenever this run touches `wp_posts.post_content`)

1. Run the Section 3 pre-write diagnostic. Must return `count=0`.
2. Run the Section 2.2 Wall-health check. All four sections must be OK.
3. Pick a safe write path from Section 4. **Never use the highest-risk MySQL `FROM_BASE64` pattern without byte-level verification.**
4. If the target post ID is in `GENESIS_PROTECTED` (Section 6), you MUST set `GENESIS_SAFETY_BYPASS=1` in the subprocess env AND call `remove_all_filters("wp_insert_post_data");` at the start of the wp eval.
5. After every write, **always verify with `wp post get N --field=post_content` and diff against the expected bytes.** The wp CLI returns `Success: Updated post N.` even when L1 silently reverts the write (silent-lie trap). The only way to detect a silent-lie is the post-write byte diff.
6. After every write: `clean_post_cache($pid)` + `wp_cache_flush()` + `wp litespeed-purge all`. Then `curl` the live page to confirm.
7. If you discover visible `rn` / `xa0` / bare `n` artifacts on the live page **after** a write, STOP. Run the Wall-health check to identify which layer failed, then re-apply the fix scripts. Do not just patch the DB and walk away.

---

## 6. GENESIS_PROTECTED posts (require explicit bypass)

These post IDs are protected by the L1 mu-plugin. Writing to them requires:

```bash
GENESIS_SAFETY_BYPASS=1 sudo -u genes8393 wp eval '
  remove_all_filters("wp_insert_post_data");
  $r = wp_update_post(["ID" => $ID, "post_content" => $NEW]);
  echo is_wp_error($r) ? "ERR" : "OK";
' --path=/home/genesismotiondesign.com/public_html/
```

Protected IDs (verify before relying on this list — the CTO updates it whenever the L1 mu-plugin's constant changes):

```
45, 295, 656, 663, 951, 953, 955, 957, 1598, 2360
```

After the write, verify with `wp post get N --field=post_content` and confirm the bytes actually changed.

---

## 7. LLM keyword text boxes (gen977 boxes at the bottom of pages)

These are shortcode-rendered text boxes that ask visitors to paste a keyword and click a button. They have been a recurring source of breakage:

- The `genesis-hide-broken-llm-boxes.php` mu-plugin hides the boxes when their inner `<strong>` tag is empty or broken. **Do not remove this mu-plugin.**
- When the LLM boxes ARE part of a deliverable (e.g. CMO adding a keyword box to a new page), the keyword text inside the `<strong>` tag MUST be non-empty. An empty keyword box is broken output — it must not ship.
- When the LLM boxes are NOT part of a deliverable, leave the mu-plugin in place; it auto-hides them on pages that don't have valid content.
- After any publish that touches a page with an LLM box, the Post-Publish QA step (Section 9) MUST curl the live page and grep for the visible broken-state marker. If found, file a corrective issue.

---

## 8. Cache purge order (CRITICAL — wrong order = stale CDN for 7 days)

```bash
# 1. WordPress object cache
sudo -u genes8393 wp cache flush --path=/home/genesismotiondesign.com/public_html/

# 2. LiteSpeed internal cache
sudo -u genes8393 wp litespeed-purge all --path=/home/genesismotiondesign.com/public_html/

# 3. Cloudflare zone cache — use the zone-scoped token (cfat_*), NOT the global API key
python3 - <<'PY'
import json, urllib.request
cf = json.load(open('/volume2/Hailey/Hermes/home/.hermes/secrets/cloudflare-genesis.json'))['cloudflare']
req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/zones/{cf['zone_id']}/purge_cache",
    data=b'{"purge_everything":true}',
    headers={'Authorization': f"Bearer {cf['zone_scoped_token']}", 'Content-Type': 'application/json'},
    method='POST')
print(urllib.request.urlopen(req, timeout=30).read().decode())
PY
```

Skipping step 3 leaves Cloudflare serving the broken state for up to 7 days.

---

## 9. Post-publish QA gate (MANDATORY for CTO publishes; non-skippable)

After any CTO publish or content write that touches a live page:

1. `curl -s https://genesismotiondesign.com/<page-path>/ | grep -c "rnrn\|>rn\|<rn\|]rn\|)rn\|,rn\|!rn\|?rn\|xa0"` — must be 0.
2. `curl -s https://genesismotiondesign.com/<page-path>/ | grep -c "\[vc_\|<!-- gen"` — must be 0 (no raw shortcodes).
3. `curl -s https://genesismotiondesign.com/<page-path>/ | grep -i "broken\|empty keyword"` — must be 0 (no visible broken-state markers).
4. Open the page in the CDP browser. Verify:
   - Hero/title renders without raw shortcodes.
   - FAQ section (if present) renders the questions as a list, not as raw text.
   - Internal links resolve (no 404s).
   - Images load.
   - **LLM keyword box (if present) is either hidden by the mu-plugin OR shows non-empty keyword text. Never shows an empty/broken box.**
5. If any check fails: do NOT mark the parent issue done. File a corrective issue assigned to the CTO with the failing curl/grep evidence and the wall-health report.

---

## 10. Escalation rules

- Touching do-not-touch inventory (Section 1)? → `request_confirmation` to Benjamin. Do NOT implement.
- CSP / `.htaccess` changes? → `request_confirmation` to Benjamin. The current CSP-disabled state is intentional.
- `main-no-ajax.js` or other theme JS fixes? → `request_confirmation` to Benjamin. After approval: syntax check + runtime null-safety check + `js.php` filemtime-based cache-bust if version is static + browser-verify counters/sliders/media actually recovered.
- Wall layer failure (L1/L2/L5/L6 not OK)? → STOP. Do not write content. Run the relevant fix script or escalate to CTO.
- Visible `rn` / `xa0` / bare `n` on a published page (CEO-flagged user report)? → Route as a regression of the rn/xa0 corruption (JULY 21). Do NOT treat it as a copy/design issue. CTO runs `/tmp/genesis-content-healthcheck.sh` to identify which layer failed, then re-applies the fix.

---

## 11. Reference index (load these skills as needed)

- `paperclip-genesis-incident-triage` — fast decision tree for "site broken" reports
- `genesis-paperclip-safety` — do-not-touch inventory + CSP audit + deploy gates (parent skill)
- `genesis-render-time-cleanup-pattern` — filter-timing model + the six-layer Wall
- `genesis-website-restore` — recovery procedure for the original 9-10 incident class
- `genesis-safe-patterns` — original rn/xa0 corruption guardrails (rule #5)
- `genesis-post-deploy-red-team` — browser-based red team for the live site
- `genesis-project-video-embed-pattern` — canonical video / iframe wrappers (Gumlet / YouTube / The Fool)
- `wp-cli-content-safety-silent-lie` — the silent-lie bypass recipe
- `july-2026-rn-corruption-incident.md` — full JULY 21 incident post-mortem
- `bulk-content-corruption.md` — gen### shortcode corruption patterns
- `wpbakery-corruption-patterns.md` — additional WPBakery corruption patterns

---

## 12. How the rules reach each agent

The canonical file lives at `instances/default/companies/4b7fd6fc-b920-430e-a3bd-defc09fc4326/shared/GENESIS-WEBSITE-GUARDRAILS.md`. Hermes prepends the full body of this file to the top of each agent's `AGENTS.md` entry file at agent-load time (see `<!-- BEGIN CANONICAL GENESIS GUARDRAILS -->` markers). When the agent's adapter reads the entry file, the rules are physically present in the system prompt — the agent does not have to resolve a relative path to load them.

Per-agent instruction directories:
- CTO `08c9660e/instructions/`: `AGENTS.md` + `HEARTBEAT.md` (Gates 1–11)
- CMO `2c367227/instructions/`: `AGENTS.md` + `BLOG-WORKFLOW.md` (CTO Publish + Post-Publish QA subtasks)
- CEO `ee11ddca/instructions/`: `AGENTS.md` + `HEARTBEAT.md` + `SOUL.md` + `TOOLS.md` + `VISION.md` + `PROJECT-INVENTORY.md`
- UXDesigner `190d1320/instructions/`: `AGENTS.md`
- Coder `11ec648f/instructions/`: `AGENTS.md`
- Coder `bacbeb57/instructions/`: `AGENTS.md`

`92587782` (Summarizer) and `d4e904f7` (Reflection Coach) are read-only built-ins — they do not ship content and do not need this file.
