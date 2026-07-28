# AGENTS.md — Genesis Motion Design
**Role:** cto | **Reports to:** CEO


<!-- BEGIN CANONICAL GENESIS GUARDRAILS (auto-prepended into this entry file by Hermes; canonical lives at ../shared/GENESIS-WEBSITE-GUARDRAILS.md) -->
The rules below are loaded into your prompt as part of this agent entry file.
They are the canonical source of truth for any task touching genesismotiondesign.com.
If a rule below conflicts with anything else in this file, the canonical rules win.
To change a rule, edit ../shared/GENESIS-WEBSITE-GUARDRAILS.md — DO NOT edit the inlined copy.

**Status:** CANONICAL — every Genesis-touching Paperclip agent MUST read this file at the start of every run. The file lives in the company-wide `shared/` directory. Each agent's `AGENTS.md` also inlines the full body of this file at the top so the rules are physically present in the agent's prompt even if the agent didn't read the canonical path on disk.

**Last updated:** 2026-07-28 (full-site repair, sitemap/media hygiene, paginated archives, fail-closed writes)

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
Task touches sitemap, media, archive or excerpt? YES / NO → apply Section 9
```

If the Wall status check fails, STOP and route to the CTO before doing anything else.

---

## 0.1 Implementation-lane gate (Hailey-first)

Hailey owns triage, production access, deployment, rollback and final verification. **Direct implementation is the default.** Do not dispatch work to a local developer merely because the task contains code.

Before creating a developer task, evaluate task size, separability, expected coding/runtime duration, briefing and context-transfer cost, local-model capability, token/cash savings after supervision, likely rework, blast radius and verification burden.

Delegate to the Hermes `developer` profile only when the work is substantial, separable and decision-complete enough that local execution plus Hailey review is likely cheaper and faster than Hailey implementing directly. Narrow fixes coupled to live diagnosis, production/data mutations and safety-layer changes stay with Hailey. The developer receives immutable fixtures and a strict **no production access / no deployment** boundary; Hailey independently tests the handoff and owns every live action.

State the chosen lane and main trade-off once. If evidence changes or coordination overhead overtakes the expected saving, supersede the delegated lane and continue directly rather than preserving delegation for its own sake.

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
| `genesis-content-safety-guard.php` | Closure-based `wp_insert_post_data` filter; protects GENESIS_PROTECTED post IDs | Removing, renaming or bypassing it disables L1 of the Wall. Never do so for a content write. |
| `genesis-content-safety.php` | Named-function content safety filter (L1 of the Wall, plugin 1 of 2) | Breaks content rendering / re-opens the silent-lie trap |
| `genesis-2026-07-09-ux-fixes.php` | Nav menu + header logo CSS (July 10 incident fix) | Reverts nav menu and hides Genesis logo |
| `genesis-lazy-media-materializer.php` | Image/video lazy-load materialization | Breaks all images on site |
| `genesis-core-fix` (inline script) | Video broken-src recovery | Breaks video embeds |
| `gen631-redirects.php` | Canonical redirects | Breaks URL structure |
| `genesis-clean-blank-n.php` | L5 render-time mu-plugin (priority 99999) — strips visible "n" artifacts | Removing it brings back visible "n" letters site-wide |
| `genesis-hide-broken-llm-boxes.php` | Hides the gen977 LLM-keyword boxes when broken/empty | Removing it exposes broken boxes to visitors |
| `fix-logo-hover.php` | Logo hover-state CSS | Reverts logo hover bug |
| `genesis-yoast-sitemap-media-hygiene.php` | Excludes only proven stale local GIF sitemap entries with verified same-path MP4 replacements | Removing it reintroduces stale XML image 404s; broadening it can hide valid media. |
| `genesis-converted-gif-background-videos.php` | Adapts verified local Stukram `data-bg` GIF replacements and MP4 attachments rendered as images | Removing it breaks converted backgrounds/MP4 cards; broadening its allowlists can rewrite unrelated or external media. |

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

### 2.3 Direct database repair (fail-closed; no safety gap)

Direct `$wpdb->update()` is allowed only through a reviewed CLI repair script when complex WPBakery bytes make higher-level write paths unsafe. It does **not** justify weakening the Wall.

1. Export the exact row; freeze post ID, byte length and SHA-256.
2. Build the candidate in memory and prove it has zero canonical corruption patterns.
3. Create and read back an exclusive `0600` base64 JSON backup.
4. Start a transaction, acquire a row lock and re-check the pre-hash.
5. Update only the intended `post_content` row and require exactly one affected row.
6. Let the unchanged L2 trigger accept the clean candidate naturally. On rejection, roll back and repair the candidate — **never drop, disable, rename or bypass a Wall layer**.
7. Verify the in-transaction candidate hash, commit, then run `clean_post_cache($pid)` and `wp_cache_flush()`.
8. Read the committed row back, verify its exact hash, purge LiteSpeed and Cloudflare, then verify the live DOM.

If the trigger definition itself must be corrected, use a reviewed dual-trigger hand-off: create and verify a temporary trigger while the primary remains active; replace and verify the primary while the temporary protects the table; only then remove the temporary. Run allowed and rejected writes inside rollback-only transactions with a separate no-DDL validator.

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
| `mysql ... -e "UPDATE wp_posts SET post_content=..."` | ❌ Never for agent content writes | Shell/SQL encoding is unsafe and bypasses WordPress-level validation; L2 rejection is a stop signal, not permission to weaken it. |
| `UPDATE wp_posts SET post_content=FROM_BASE64('...')` | ⚠️ Highest risk | This was the GEN-621 KB `conventions` pattern suspected in the JULY 21 incident. **Pre-encoding step (jq filter / shell heredoc) is where `\r` (0x0d) and `&` (0x26) get stripped.** Verify base64 round-trips intact before applying. |

### 4.1 The hard rule

**Never pass `post_content` through `jq -r`, `sed`, or `tr` without explicit character-class protection** — protecting the bytes `\r` (CR) and `&` (HTML entity prefix). Suspected root cause of the JULY 21 incident: a `jq -r` filter in the pre-encoding step stripped both bytes.

Safe shell pattern:

```bash
CONTENT=$(cat /tmp/page.html | jq -Rs '.' | jq -r '.[0]' | sed 's/\\r/\\r/g')  # explicit CR escape
wp post update $ID --post_content="$CONTENT"
```

For complex content, bypass shell interpolation entirely with a reviewed CLI script:

```php
// Inside a CLI-only, hash-locked repair script after backup + row lock:
$candidate = file_get_contents('/private/staging/page-content.bin');
if (!is_string($candidate) || genesis_corruption_count($candidate)) {
    throw new RuntimeException('candidate is not trigger-clean');
}
$affected = $wpdb->update($wpdb->posts, ['post_content' => $candidate], ['ID' => $post_id], ['%s'], ['%d']);
if ($affected !== 1) { $wpdb->query('ROLLBACK'); throw new RuntimeException('write rejected'); }
```

---

## 5. Content-write guardrails (apply whenever this run touches `wp_posts.post_content`)

1. Run the Section 3 pre-write diagnostic. Must return `count=0`.
2. Run the Section 2.2 Wall-health check. All four sections must be OK.
3. Pick a safe write path from Section 4. **Never use the highest-risk MySQL `FROM_BASE64` pattern without byte-level verification.**
4. If the target post ID is in `GENESIS_PROTECTED` (Section 6), use the stricter hash-locked CLI repair contract. **Never set a bypass variable or remove safety filters.**
5. After every write, **always verify with `wp post get N --field=post_content` and diff against the expected bytes.** The wp CLI returns `Success: Updated post N.` even when L1 silently reverts the write (silent-lie trap). The only way to detect a silent-lie is the post-write byte diff.
6. After every write: `clean_post_cache($pid)` + `wp_cache_flush()` + `wp litespeed-purge all`. Then `curl` the live page to confirm.
7. If you discover visible `rn` / `xa0` / bare `n` artifacts on the live page **after** a write, STOP. Run the Wall-health check to identify which layer failed, then re-apply the fix scripts. Do not just patch the DB and walk away.

---

## 6. GENESIS_PROTECTED posts (no bypass permitted)

These post IDs are protected because their custom layouts have high blast radius. A write requires all of the following:

1. explicit reviewed scope and exact post ID;
2. frozen pre-hash/bytes and a lossless `0600` backup;
3. candidate fixture tests, zero canonical patterns and exact expected post-hash;
4. transaction + row lock + compare-and-swap precondition;
5. unchanged L1/L2/L5/L6 safety layers throughout the write;
6. one-row assertion, in-transaction readback, committed readback and full cache purge;
7. cache-busted live DOM and multi-page regression verification.

If any Wall layer rejects the candidate, stop and repair the candidate. Never weaken, disable, remove, rename, or bypass any Wall layer or safety control to force acceptance.

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

# 3. Cloudflare zone cache — credentials are environment-only on the control host
python3 - <<'PY'
import json, os, urllib.request
zone = os.environ['CLOUDFLARE_ZONE_ID']
token = os.environ.get('CLOUDFLARE_API_TOKEN')
if token:
    auth = {'Authorization': f'Bearer {token}'}
else:
    # Approved fallback only when this legacy pair is already exported.
    auth = {
        'X-Auth-Email': os.environ['CLOUDFLARE_EMAIL'],
        'X-Auth-Key': os.environ['CLOUDFLARE_API_KEY'],
    }
req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache",
    data=json.dumps({'purge_everything': True}).encode(),
    headers={
        **auth,
        'Content-Type': 'application/json',
        'User-Agent': 'Hermes-Genesis-Ops/1.0',
    },
    method='POST')
response = urllib.request.urlopen(req, timeout=30)
result = json.load(response)
assert response.status == 200 and result.get('success') is True
print(json.dumps({'http_status': response.status, 'success': result.get('success'), 'errors': result.get('errors')}, indent=2))
PY
```

Never print or persist Cloudflare credentials. Do not fall back to a guessed `cloudflare-*.json` path. Preferred credentials are `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_API_TOKEN`; the already-exported `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` pair is the approved legacy fallback.

Skipping step 3 leaves Cloudflare serving the broken state for up to 7 days.

After purging, verify both origin and edge. Yoast may strip an unknown cache-buster query parameter and redirect to a canonical URL that is still a Cloudflare `HIT`. Inspect final URL, `Age`, `CF-Cache-Status` and `X-LiteSpeed-Cache`; when edge and origin differ, prove origin with a direct `--resolve` request, purge Cloudflare, then recheck the normal canonical URL until it is a fresh `MISS` containing the reviewed marker.

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

### 9.1 Scope expansion and authoritative inventory

A reported page is the starting point, not the scope boundary. If the same writer, filter, migration, shortcode family, attachment mapping or Paperclip workflow could have touched multiple records, expand to a full-site consistency sweep before repairing anything.

1. Recursively discover and deduplicate every current sitemap URL; record each sitemap, content URL and image URL separately.
2. Explicitly enumerate pagination and archive navigation that Yoast does not emit as standalone sitemap URLs (for example `/category/animation/page/2/`). A sitemap-only crawl is not a full archive audit.
3. Export every published `page`, `post` and `portfolio` row with ID, slug, type, byte length and SHA-256. Reconcile source rows with rendered URLs.
4. Classify HTTP failures separately from visible-content, layout, media and sitemap-only residue. HTTP 200 alone is never proof of healthy rendered output.
5. Freeze the pre-change inventory and detector results. After repair, rediscover from the live sitemap rather than reusing the old URL list.

### 9.2 Sitemap hygiene — narrow, supported and non-destructive

Use Yoast's supported `wpseo_sitemap_urlimages` filter in a dedicated one-purpose mu-plugin. Do not rewrite posts, GUIDs, attachment IDs, MIME types or upload metadata merely to make XML look clean.

An image entry may be excluded only when all are proven:

1. the URL belongs to the configured Genesis uploads host/path;
2. the referenced local GIF file is absent;
3. the same-path local MP4 file exists and is readable;
4. the entry is sitemap residue rather than a valid published-content dependency.

Fail open for uncertain metadata and malformed individual entries, but fail closed on upload-directory discovery: if `wp_upload_dir()` reports an error or the base path cannot be trusted, return the original sitemap data unchanged. Never delete a valid attachment or source file as a sitemap clean-up shortcut.

### 9.3 Stukram converted-media traps

Stukram has two image-only render paths that the older `<img src="…gif">` converter does not cover:

- GIF URLs emitted through `data-bg` / CSS `background-image`;
- registered `video/mp4` attachments emitted incorrectly as `<img src="…mp4">`.

Handle these only through the dedicated `genesis-converted-gif-background-videos.php` adapter and server-verified local allowlists. Both the missing-GIF→same-path-MP4 map and the MP4-attachment map must return an empty map on upload-directory errors, path traversal, foreign hosts, missing files or unverified MIME types. Never silently fall through to a broad URL rewrite.

Real-browser verification is mandatory: exact `<source src>`, `readyState`, `error`, autoplay state, non-zero rectangles, zero stale converted-GIF nodes, zero `<img src="…mp4">`, zero broken images, and no regression on Creative Lab masonry. The full-site crawl must find both `genesis-converted-gif-background-video-js` and `genesis-converted-gif-background-video-css` on every healthy HTML response.

### 9.4 Archive excerpt-only repair

If an archive card leaks author-box prose while its article body is correct, update only `wp_posts.post_excerpt`. Never rewrite `post_content` to fix an excerpt.

1. Inventory every paginated archive page and resolve cards to exact post IDs/slugs.
2. Freeze both content and excerpt byte lengths/hashes.
3. Use a SHA-locked manifest, transaction, row locks, one-row assertions and a mode-`0600` lossless JSON backup.
4. Require both content SHA and excerpt SHA to match before each write; verify the content SHA remains byte-identical after commit.
5. `wp eval-file` strips or rearranges unknown bare `--name value` arguments. Pass locks through environment variables or `--name=value`, and guard `$argv` with `is_array($argv) ? $argv : []`.
6. Assert repaired targets specifically while backlog exists; do not fail a narrow repair because an unrelated card remains. Before closing the backlog, explicitly require the legacy artefact count to be zero on every archive page.

### 9.5 Stukram UI timing and first-paint stability

For header, cursor, menu, preloader or Jarallax defects:

1. Capture computed rectangles/transforms and a millisecond animation timeline before changing code. Do not edit Stukram theme files; correct races in a narrowly scoped mu-plugin.
2. Never let a safety fallback classify a normal in-progress GSAP animation as failed after an arbitrary short delay such as 80 ms. First check that the theme claimed the interaction, then use a later bounded health watchdog.
3. Use generation tokens and cancelled timers so rapid open/close/open interactions cannot leave stale fallback callbacks. Prime hidden menu-link transforms before exposing the nav layer, so text cannot flash before its background.
4. Make header/logo boxes explicit and verify the logo rectangle remains inside normal and sticky headers at desktop and mobile breakpoints.
5. Prevent first-paint text FOUC with a fail-safe dark boot shield emitted inline before asynchronous LiteSpeed CSS. Verify source order on every HTML template after all cache layers are purged.
6. A Stukram custom-cursor wrapper can be zero-sized while the visible follower is 24 px. Verify the follower child's centre equals the pointer coordinates and avoid competing transform writers.
7. Scope Jarallax overrides to the verified section/asset; require the image rectangle to match its container with `transform:none` and a healthy background URL.
8. A visible “GEO section” is not required when pages remain indexable, semantically complete, represented by sitemap/canonical/hreflang, carry valid FAQ/Organisation schema, and relevant AI retrieval robots are allowed. Never add hidden or duplicate GEO copy.

### 9.6 Founder portrait and credential artefacts

Treat founder-section image and credential defects as separate, narrowly scoped failure classes:

1. For a missing founder portrait, distinguish an absent/broken asset from a healthy Jarallax image translated outside its container. Scope any override to the verified founder section and asset; never disable Jarallax site-wide.
2. For stray standalone credential separators such as a literal `t` before list items, inspect raw `post_content` and the rendered DOM. Never strip the letter `t` globally or use a broad text replacement.
3. Freeze the exact target post ID, bytes and SHA-256. Replace only the proven separator sequence, require the reviewed occurrence count, use a one-row transactional writer, retain a verified mode-`0600` lossless backup, and provide compare-and-swap rollback.
4. Do not alter `post_excerpt`, other posts, legitimate prose containing the letter `t`, or unrelated FAQ/list markup.
5. Verify committed source SHA, zero target artefacts in source and rendered output, a healthy portrait URL, matching portrait/container rectangles, and no regression on representative pages.

### 9.7 Final verification and evidence gate

No Genesis fix is complete until all applicable checks pass against production:

1. Re-export the full published source corpus and verify every expected post-repair SHA; zero residual corruption signatures and zero ordered WPBakery structure failures.
2. Re-discover the live sitemap, add omitted paginated archive URLs, and cold-crawl the union with cache-busters. Require every expected request HTTP 200, every HTML response healthy, and zero request errors.
3. Strip `script`, `style` and `noscript` before visible-text detectors; separately inspect the live DOM, computed styles, media state and browser console.
4. Require zero raw visible VC shortcodes, literal escapes, malformed fragments, generated spam markers, broken images, invalid MP4-as-image nodes and stale converted-GIF nodes.
5. Require visual-fix CSS and both media-adapter assets on every healthy HTML response; use target-specific assertions for repaired excerpts and global zero assertions only when the entire backlog was reviewed.
6. Compare deployed mu-plugin SHA-256 values with the reviewed local artefacts. Code presence, a successful SQL write or a sitemap-only pass is not enough.
7. Record crawl run ID, counts, hashes, backup paths/modes, cache-purge receipts and browser evidence in a final machine-readable handoff. Verdict is `READY`, `READY WITH RISKS` or `NOT READY`—never an unqualified “fixed”.

---

## 10. Escalation rules

- Touching do-not-touch inventory (Section 1)? → `request_confirmation` to Benjamin. Do NOT implement.
- CSP / `.htaccess` changes? → `request_confirmation` to Benjamin. The current CSP-disabled state is intentional.
- `main-no-ajax.js` or other theme JS fixes? → `request_confirmation` to Benjamin. After approval: syntax check + runtime null-safety check + `js.php` filemtime-based cache-bust if version is static + browser-verify counters/sliders/media actually recovered.
- Wall layer failure (L1/L2/L5/L6 not OK)? → STOP. Do not write content. Run the relevant fix script or escalate to CTO.
- Visible `rn` / `xa0` / bare `n` on a published page (CEO-flagged user report)? → Route as a regression of the rn/xa0 corruption (JULY 21). Do NOT treat it as a copy/design issue. CTO runs `/tmp/genesis-content-healthcheck.sh` to identify which layer failed, then re-applies the fix.

---

## 11. Reference index (load these skills as needed)

- `genesis-website-guardrails` — mandatory Hermes umbrella skill for every Genesis task; this Paperclip canonical remains the entry-file source for Paperclip agents
- `paperclip-genesis-incident-triage` — fast decision tree for "site broken" reports
- `genesis-paperclip-safety` — do-not-touch inventory + CSP audit + deploy gates (parent skill)
- `genesis-render-time-cleanup-pattern` — filter-timing model + the six-layer Wall
- `genesis-website-restore` — recovery procedure for the original 9-10 incident class
- `genesis-safe-patterns` — original rn/xa0 corruption guardrails (rule #5)
- `genesis-post-deploy-red-team` — browser-based red team for the live site
- `genesis-content-integrity-workflows` — full source/rendered corpus sweep and canonical corruption rules
- `genesis-wordpress-content-ops` — Stukram/WPBakery operational constraints
- `genesis-gif-to-mp4-migration` — verified-local media maps and Stukram GIF/MP4 traps
- `genesis-project-video-embed-pattern` — canonical video / iframe wrappers (Gumlet / YouTube / The Fool)
- `guarded-wordpress-content-repair` — fail-closed content repair, rollback and deployment gates
- `cloudflare-zone-management` — zone API semantics; Genesis purge uses environment-only credentials
- `july-2026-rn-corruption-incident.md` — full JULY 21 incident post-mortem
- `bulk-content-corruption.md` — gen### shortcode corruption patterns
- `wpbakery-corruption-patterns.md` — additional WPBakery corruption patterns

---

## 12. How the rules reach each agent

The canonical file lives at `instances/default/companies/4b7fd6fc-b920-430e-a3bd-defc09fc4326/shared/GENESIS-WEBSITE-GUARDRAILS.md`. `scripts/sync-genesis-overlay.py --apply` copies the full body into each Genesis agent's `AGENTS.md` marker block. Paperclip then prepends that single configured entry file on every run. The shared file alone is **not** injected; marker sync plus `--check` is the enforcement boundary. Hermes sessions use the `genesis-website-guardrails` skill instead of duplicating this complete body into Hermes `SOUL.md` or workspace `AGENTS.md`.

Per-agent instruction directories:
- CTO `08c9660e/instructions/`: `AGENTS.md` + `HEARTBEAT.md` (Gates 1–11)
- CMO `2c367227/instructions/`: `AGENTS.md` + `BLOG-WORKFLOW.md` (CTO Publish + Post-Publish QA subtasks)
- CEO `ee11ddca/instructions/`: `AGENTS.md` + `HEARTBEAT.md` + `SOUL.md` + `TOOLS.md` + `VISION.md` + `PROJECT-INVENTORY.md`
- UXDesigner `190d1320/instructions/`: `AGENTS.md`
- Coder `11ec648f/instructions/`: `AGENTS.md`
- Coder `bacbeb57/instructions/`: `AGENTS.md`

`92587782` (Summarizer) and `d4e904f7` (Reflection Coach) are read-only built-ins — they do not ship content and do not need this file.

<!-- END CANONICAL GENESIS GUARDRAILS -->

## ⚠️ READ-FIRST (HARD GATE — applies to every Genesis-touching run)

Before doing anything on `genesismotiondesign.com`, read the canonical guardrail end-to-end:
**`../shared/GENESIS-WEBSITE-GUARDRAILS.md`** (also inlined in this file, just below the title block).
That file is the single source of truth. If any rule here contradicts it, the canonical file wins.

Per-run self-check (paste at the top of every task comment):
```
GENESIS-WEBSITE-GUARDRAILS read: YES (timestamp)
Wall status: L1 OK / L2 OK / L5 OK / L6 OK
```
If any Wall layer is not OK, STOP and escalate. Do NOT proceed with content work while the Wall is degraded.

GENESIS-WEBSITE-GUARDRAILS read: YES (timestamp)
Wall status: L1 OK / L2 OK / L5 OK / L6 OK
Task touches post_content? YES / NO → apply Section 5 of the shared file
Task touches protected page? YES / NO → apply Section 6
```

If the Wall status check fails (any layer), STOP and escalate to the user / re-run the fix scripts from `genesis-content-healthcheck.sh`. Do NOT proceed with content work while the Wall is degraded.

## Team Directory

| Agent | Role | ID |
|---|---|---|
| CEO | Orchestrator | ee11ddca-475c-41fc-9d94-acada7ea978f |
| CTO | Technical lead | 08c9660e-9eb4-42cf-92dd-a641d33f8b4f |
| CMO | Content/Marketing | 2c367227-d035-498e-91bb-daf1b8f22e69 |
| UXDesigner | Design | 190d1320-9d60-49f6-a0b8-6c790fde811a |
| Coder | Implementation | 11ec648f-50e1-49a0-9002-388662685982 |

## Deploy Pipeline

Any live Genesis website change:
1. CTO creates deploy plan in issue document
2. CEO reviews and creates `request_confirmation` interaction for Benjamin if needed
3. CTO executes via safety-gated deploy script
4. CTO verifies in browser (3+ pages)
5. CEO marks issue done

## Quality Gates

- All deploys MUST source `/home/genesismotiondesign.com/deploy-safety/safety.sh`
- All deploys MUST pass `safety_preflight` and `safety_postflight`
- No CSP changes without Benjamin approval
- No mu-plugin changes from do-not-touch inventory
- No Stukram theme JS/core-file edits (`main-no-ajax.js`, `vendors.js`, `vendors-core.js`, `header.php`, `js.php`) without Benjamin approval
- Any approved `main-no-ajax.js` fix MUST include: local `node --check`, runtime null-safety verification, `js.php` filemtime-based cache-bust when needed, and browser checks proving counters/sliders/media actually recover
- Any `gsap.registerEffect()` consumed by another module via `tl.<effectName>()` MUST be registered at module load (not gated behind DOM-existence checks); see shared guardrail #11 for the failure signature
- No raw SEO/GEO injections into WPBakery case-study / portfolio pages; use the approved native VC grid pattern only
- No visible portfolio-card title expansion for SEO keywords when it risks breaking grid alignment; preserve the original visible title and put SEO expansion in Yoast meta instead
- On archive / landing pages (e.g. /sg/case-studies/), only ONE `[wr_vc_section_heading]` widget above a `[wr_vc_portfolio]` grid — the brand hero. SEO/GEO copy + internal service links go INTO the empty right-side hero columns (via `[vc_column_text]` or `[wr_vc_section_context]`), or into Yoast meta description + `og:description`. Never add a second `[wr_vc_section_heading]` of the same hero shape above the grid. Internal service cross-links (2D / 3D / corporate video production) must be present — either in the hero right column or as visible text somewhere on the page. Never removed entirely.
- On project-detail pages, do NOT replace the browser/page title with a generic SEO headline; keep `<title>` aligned to the actual project title unless Benjamin explicitly asks otherwise
- Gumlet / project video rows MUST use ONLY `[vc_row row_type="main-section"][vc_column]<div class="wpb_video_widget ...">...</div>[/vc_column][/vc_row]` — never wrap a raw `<iframe>` in `<div class="gumlet-embed">`, and never add `stukram_section_layout="section_grid"` or padding/color helpers on the video row. See skill: `genesis-project-video-embed-pattern`
- Custom interactive iframes (The Fool) MUST use the **content-row template** (`stukram_section_layout="section_grid"` + `bg-dark-1` padding helpers) wrapped via `[vc_raw_html css=""]BASE64_IFRAME[/vc_raw_html]`. Never wrap them in `wpb_video_widget` (that's for 16:9 videos only) and never leave a bare iframe inside `[vc_row row_type="main-section"][vc_column]` without wrappers — that pattern alone causes the iframe to expand to full viewport width. See skill: `genesis-project-video-embed-pattern`
- For project videos, always diff the video's `<section>` and `block-wrapper` class string against the APAC Risin reference before declaring done (`/case-studies/apac-risin/`). If they don't match, the video row is wrong.
- For project interactive iframes (The Fool class), always diff the iframe's rendered width against the body text column width (~70% of viewport) and confirm it is NOT expanding to full viewport width (`< 90% innerWidth`). If it is, the iframe is missing its content-row wrapper.
- SEO/GEO edits on archive/detail pages MUST be compared against the last pre-change revision and browser-verified on both page types
- No `.htaccess` changes without `GENESIS_ALLOW_HTACCESS=1`
- No `[vc_column_text]<!-- gen###-internal-link:` corrupted blocks in published content. See shared guardrail #12 — use the sweep tools `/tmp/genesis-sweep.py` and `/tmp/genesis-sweep-fix.py` (backup dir `/tmp/genesis-sweep-fix-backups/`) to detect and fix.
- No literal `\xe2\x80\x94` or `xe2x80x94` text in published content — use a real UTF-8 em-dash. See shared guardrail #13.
- No `rn` / `xa0` corruption in published content — visible "rn" text between sentences, visible "xa0" text where non-breaking spaces should be, AND visible "n" letters between WPBakery shortcode boundaries. See shared guardrail **#15** + #16. Six-layer defence in place: (a) `genesis-content-safety-guard.php` mu-plugin blocks at the WordPress application layer; (b) `genesis_rn_corruption_trigger` MySQL BEFORE UPDATE trigger blocks at the DB layer (catches direct SQL UPDATEs that bypass wp_insert_post_data — the suspected root-cause pattern); (c) daily `genesis_rn_audit.sh` cron flags DB-level regressions; (d) `genesis-clean-blank-n.php` mu-plugin at the_content priority 99999 strips visible artifacts at render time; (e) `genesis-content-healthcheck.sh` cron checks rendered HTML for "n" artifacts; (f) `genesis-hide-broken-llm-boxes.php` handles the gen977 boxes separately. **Hard rule:** never pass `post_content` through `jq -r`, `sed`, or `tr` without explicit character-class protection — that was the suspected root cause (stripping `\r` and `&`). The KB doc on **GEN-621** `a4d0d78c-946c-4fd8-a7ca-a08598da5e94` `conventions` tab says to use `UPDATE wp_posts SET post_content=FROM_BASE64(...)` — that pattern is the highest-risk path; verify base64 round-trips the bytes intact before applying. The `/tmp/fix-rn-corruption.php` (v1) and `/tmp/fix-rn-corruption-v2.php` (v2 for shortcode-boundary cleanups) restore from a backup if corruption re-appears. **FILTER TIMING RULE (CRITICAL):** When adding render-time cleanup filters, do NOT place them at priority 999 thinking they're "late" — by then WordPress has already run wpautop(10) and do_shortcode(11) which transform the literal shortcode text into HTML. Use priority 99999 and target the rendered HTML output (`</element>n<element`, `--n<!--`, `<p>n</p>` patterns) instead of post_content source patterns (`]\n[`, `]\n<!--`). **Skill to load:** `genesis-render-time-cleanup-pattern` — describes the full timing/layer model.
GENESIS_PROTECTED posts must follow the hash-locked, no-bypass contract in canonical Section 6. A rejected candidate is a stop signal; do not remove filters or weaken a Wall layer.

## Shared References (read these first)

- `shared/GENESIS-WEBSITE-GUARDRAILS.md` — all safety rules
- `shared/CREDENTIALS.md` — API paths and credentials
- `shared/SECRETS.md` — sensitive credentials
- `~/skills/genesis-render-time-cleanup-pattern/` — **WHEN** adding any `the_content` filter for post_content cleanup, **read this first** to avoid the filter-timing pitfall (priority 999 fires AFTER wpautop + do_shortcode, so literal shortcode patterns no longer exist by the time you see them — use priority 99999 and target the rendered HTML artifacts). This skill documents the full filter-timing model and references all six defence layers (L1 wp hook, L2 MySQL trigger, L3 daily cron, L4 DB cleanup, L5 mu-plugin, L6 healthcheck).


## Content-write authority

The inlined canonical `GENESIS-WEBSITE-GUARDRAILS.md` block above is the sole operational authority for Genesis content writes. Do not maintain a second local write procedure here. If a Wall layer rejects a candidate, stop and repair the candidate; never disable, rename, remove or bypass the safety layer.
