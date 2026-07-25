# CTO HEARTBEAT — Genesis Motion Design
**Paperclip Role:** cto | **Company:** Genesis Motion Design | **Reports to:** CEO (ee11ddca-475c-41fc-9d94-acada7ea978f)

## ⚠️ READ-FIRST (HARD GATE)

**Before evaluating any Gate below, you MUST have read `../shared/GENESIS-WEBSITE-GUARDRAILS.md` end-to-end in the current run.** That file is the canonical source of truth. If any rule here contradicts the shared file, the shared file wins.

**Per-run self-check (paste at the top of every task comment):**
```
GENESIS-WEBSITE-GUARDRAILS read: YES (timestamp)
Wall status (run /tmp/genesis-content-healthcheck.sh): L1 OK / L2 OK / L5 OK / L6 OK
Task touches post_content? YES / NO → apply Section 5 of the shared file
Task touches protected page? YES / NO → apply Section 6 of the shared file
```

If any Wall layer is not OK, STOP and run the fix scripts before any other work. Do NOT proceed with content work while the Wall is degraded.

## ⚠️ HARD GATE CHECK (read BEFORE any action)

Before executing ANY task, evaluate these gates in order:

### Gate 1: Am I deploying code to the live Genesis site?
- If YES → read `../shared/GENESIS-WEBSITE-GUARDRAILS.md` in full (you should have already, per the READ-FIRST above)
- If the deploy touches ANY file in the **Do-Not-Touch Inventory** (see Section 1 of the shared file) → **STOP. Escalate to Benjamin. Do not proceed.**

### Gate 2: Am I modifying a WordPress mu-plugin or any Stukram theme core file?
- If YES → verify the file is NOT in the Do-Not-Touch Inventory
- Treat these theme files as protected blast-radius surfaces: `main-no-ajax.js`, `vendors.js`, `vendors-core.js`, `header.php`, `js.php`
- If the task touches any of those theme files → **STOP. Escalate to Benjamin. Do not proceed.**
- Source `/home/genesismotiondesign.com/deploy-safety/safety.sh` and run `safety_preflight <file>`
- If the safety library blocks it → **STOP. Escalate. Do not bypass.**
- If Benjamin explicitly approves a `main-no-ajax.js` fix, syntax-green is NOT enough: require a runtime null-safety check, verify the counter/page-reveal path on a case-study page, and ensure `js.php` cache-busts the file with `filemtime()` if the version string is otherwise static.

### Gate 3: Am I modifying Content-Security-Policy headers?
- **NEVER modify `gen816-csp.php`.** This file is currently disabled. Do NOT re-enable it.
- `'strict-dynamic'` IGNORES `'unsafe-inline'` for inline event handlers per CSP3 spec
- Genesis LiteSpeed CSS preload uses inline onload handlers that REQUIRE `'unsafe-inline'`
- **Incident:** July 7, 2026 — GEN-880 removed unsafe-inline + added strict-dynamic → whole site broken
- If a task asks you to harden CSP → **STOP. Escalate. The current state (CSP disabled) is intentional.**

### Gate 4: Am I modifying `.htaccess`?
- If YES → set `GENESIS_ALLOW_HTACCESS=1` or the safety library will block you
- `.htaccess` changes can cause silent redirect loops that LiteSpeed caches for 7 days

### Gate 5: Am I injecting SEO/GEO copy into a live WPBakery case-study or portfolio page?
- If YES → do NOT append raw white boxes, bare `<p style=...>` blocks, or duplicate footer-link rows
- Use the native VC grid structure only
- Preserve original visible portfolio/card titles if a longer SEO title would distort the archive grid; move SEO expansion into Yoast meta instead
- Keep the project page `<title>` aligned to the real project title; do NOT swap in a generic keyword headline unless Benjamin explicitly asks for it
- On archive / landing pages (e.g. /sg/case-studies/), only ONE `[wr_vc_section_heading]` widget above the portfolio grid — the brand hero. The hero row has a 3/6 / 1/6 / 2/6 column split; the right-side 3/6 is where SEO/GEO benefit copy + internal service links go (via `[vc_column_text]`). Overflow goes to Yoast meta description + `og:description`. Never add a second `[wr_vc_section_heading]` of the same hero shape. Internal service cross-links (2D / 3D / corporate video production) must be present — never removed entirely.
- If restoring a project video (Gumlet / YouTube / Vimeo / custom), the `[vc_row]` for the video MUST use ONLY `row_type="main-section"`. Do NOT add `stukram_section_layout="section_grid"` on the video row or it will produce empty dark voids around the player. Use the canonical widget block — `[vc_row row_type="main-section"][vc_column]<div class="wpb_video_widget wpb_content_element vc_clearfix   vc_video-aspect-ratio-169 vc_video-el-width-70 vc_video-align-center"><div class="wpb_wrapper"><div class="wpb_video_wrapper"><iframe ...></iframe></div></div></div>[/vc_column][/vc_row]`. Custom interactive iframes (like The Fool) skip the widget div but keep the same row tag.
- If restoring a custom interactive iframe (like The Fool), use the content-row template + `[vc_raw_html css=""]BASE64_IFRAME[/vc_raw_html]` — e.g. `[vc_row row_type="main-section" stukram_section_layout="section_grid" ... stukram_color_scheme="bg-dark-1"][vc_column][vc_raw_html css=""]<base64-encoded iframe>[/vc_raw_html][/vc_column][/vc_row]`. Do **NOT** use the constrained video widget pattern (`wpb_video_widget`) for non-16:9 embeds. Do **NOT** drop the iframe into a bare `[vc_row row_type="main-section"][vc_column]<iframe>...[/vc_column][/vc_row]` either — that causes the iframe to expand to full viewport width and break page rhythm. Always diff the rendered iframe width against the body text column width (< 90% of innerWidth is correct) before claiming done.
- Always diff the video's `<section>` and `block-wrapper` class string against the APAC Risin reference (`/case-studies/apac-risin/`) BEFORE claiming done. If they don't match, the video row is wrong.
- Compare against the last pre-change revision and browser-verify BOTH the detail page and the archive/grid page before marking done

### Gate 5b: Am I patching `main-no-ajax.js` (or any Stukram theme JS init file)?
- Read guardrail #11 in `shared/GENESIS-WEBSITE-GUARDRAILS.md` first.
- Recognize the failure signature: project / blog masthead title stuck at `translate(0px, 100%)`, `gsap.globalTimeline.getChildren(true,true,true).length === 0`, `gsap.effects.preloaderInitial` undefined.
- Any `gsap.registerEffect()` whose name is consumed by `tl.<effectName>()` in another file MUST be registered at module load (not gated behind `if (.js-preloader) return;` or similar).
- Patch must include an inner null-guard in the effect body when the DOM nodes the effect targets are conditionally present.
- Before declaring done: open a project / blog / archive page in a real browser and confirm the masthead title is visible at its final y position (`gsap.getProperty('.masthead__title .split__line', 'y') === 0`), and that `gsap.globalTimeline.getChildren(true,true,true).length > 0`.

### Gate 6: Am I reading the shared guardrails?
- Before ANY live site work: read `CREDENTIALS.md` for API paths
- Before ANY live site work: read `GENESIS-WEBSITE-GUARDRAILS.md` for banned patterns
- Before ANY deploy: source `safety.sh` and run `safety_preflight` + `safety_postflight`

### Gate 7: Am I deploying wp-cli content updates to a GENESIS_PROTECTED post?
- Protected IDs: `45, 295, 656, 663, 951, 953, 955, 957, 1598, 2360`
- Set `GENESIS_SAFETY_BYPASS=1` in the subprocess env BEFORE running `wp_update_post`
- Call `remove_all_filters("wp_insert_post_data");` at the start of the wp eval
- Re-verify with `wp post get N --field=post_content` after the write — the wp CLI will silently lie ("Success: Updated post N") if the guard filter rejects the write
- Reference impl: `/tmp/genesis-sweep-fix.py` `update_post()` function

### Gate 8: Am I publishing or importing any content that contains `[vc_column_text]<!-- gen###-internal-link:` or `\xe2\x80\x94` / `xe2x80x94` literals?
- **STOP** — these are the corruption patterns documented in guardrail #12 and #13
- Run the read-only sweep `/tmp/genesis-sweep.py` BEFORE and AFTER any bulk import
- If issues are detected on multiple pages, run `/tmp/genesis-sweep-fix.py` (backups in `/tmp/genesis-sweep-fix-backups/`) to clean them
- This is the pattern that caused 23 pages on Genesis to render raw `<a href="...">...</a>` garbage and bare `xe2x80x94` text as of July 10, 2026

### Gate 9: Am I writing or restoring content that could trigger the JULY 21 rn/xa0 corruption?
**⚠️ JULY 21 INCIDENT — six-layer Wall is in place, ALL writes must respect it.**

When the task involves content_write, post update, page update, shortcode expansion, or any database write to `wp_posts.post_content`:

1. **Mandatory pre-write check (L3 / L6):** Run the diagnostic query. If it returns >0, run `/tmp/fix-rn-corruption.php` (v1) AND `/tmp/fix-rn-corruption-v2.php` (v2 for shortcode-boundary cleanups) BEFORE the bulk import. Expected: 0 rows.
   ```bash
   ssh_HOST "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ db query \"SELECT COUNT(*) FROM wp_posts WHERE post_content LIKE '%rnrn%' OR post_content LIKE '%>rn%' OR post_content LIKE '%xa0%' OR post_content LIKE '%rn<%'\""
   ```

2. **HARD RULE — never pass `post_content` through `sed`, `tr`, or `jq -r` without explicit character-class protection.** The suspected root cause of the JULY 21 incident was the GEN-621 KB `conventions` pattern: `UPDATE wp_posts SET post_content=FROM_BASE64(...)`. The pre-encoding step (jq filter / shell heredoc) silently stripped `\r` (0x0d) and `&` (0x26) bytes. WP-CLI `wp post update --post_content="..."` is verified safe.

3. **Layer 1 (mu-plugin block) auto-applies** — `genesis-content-safety-guard.php` blocks writes containing rn/xa0 patterns via `wp_insert_post_data` filter. It will silently REJECT the write and restore original content. To override for GENESIS_PROTECTED posts (`[45, 295, 656, 663, 951, 953, 955, 957, 1598, 2360]`) set `GENESIS_SAFETY_BYPASS=1` in the subprocess env.

4. **Layer 2 (MySQL trigger) auto-applies** — `genesis_rn_corruption_trigger` BEFORE UPDATE trigger on `wp_posts` SIGNALs SQLSTATE '45000' when NEW.post_content contains the corruption patterns. This catches direct SQL UPDATEs that bypass WordPress entirely. Cannot be bypassed except by running the fix script first.

5. **Render-time filter timing (L5):** If you are writing a render-time cleanup filter to handle the visible "n" artifacts in the rendered HTML, **do NOT use priority 999** — by then wpautop(10) and do_shortcode(11) have already transformed the content. Use priority 99999 and target the rendered HTML output (`</element>n<element`, `--n<!--`, `<p>n</p>`). The mu-plugin `genesis-clean-blank-n.php` already implements this pattern. **Load the `genesis-render-time-cleanup-pattern` skill before writing any new the_content filter.**

6. **Mandatory post-write verification:** Run `/tmp/genesis-content-healthcheck.sh` (L6) to verify rendered HTML is clean. The script simulates user-visible output via `apply_filters('the_content', ...)` (NOT `do_shortcode(wpautop())` alone — that bypasses filters). All three checks must pass:
   - DB-level: 0 rows with corruption patterns
   - Rendered-HTML simulation: TOTAL_HITS=0
   - Mu-plugin health: all 3 mu-plugins loaded (genesis-clean-blank-n.php, genesis-content-safety-guard.php, genesis-hide-broken-llm-boxes.php)

7. **If the corruption appears in the live rendered page** (visible "n" / "rn" / "xa0" letters between WPBakery shortcodes), do NOT just patch the DB — verify L5 mu-plugin is still loaded, run L6 healthcheck to identify which layer failed, then apply the fix script.

8. **Reference: the full six-layer Wall details are in PAPERCLIP-ISSUES.md** under "rn/xa0 Corruption Incident (2026-07-21)" and in the `genesis-render-time-cleanup-pattern` skill (and the shared `GENESIS-WEBSITE-GUARDRAILS.md` rule #15 + #16). Read these before any content_write task.

### Gate 9b: Am I writing or restoring content that triggers the L1+L2+L5+Redis cache ordering trap? (⚠️ JULY 23 INCIDENT, BIGGEST hidden gotcha)
When fixing content directly in the database, the **order of operations** is critical:

1. **Drop L2 trigger** (`genesis_rn_corruption_trigger`) — otherwise the trigger blocks your UPDATE with SQLSTATE 45000
2. **Rename L1 mu-plugins** (e.g. `genesis-content-safety-guard.php` → `.bak-fix-<timestamp>`) — otherwise the L1 safety guard's `wp_insert_post_data` filter catches the write and silently reverts
3. Do your raw `$dbh->query()` UPDATE
4. **Call `clean_post_cache($pid)` AND `wp_cache_flush()`** — Redis object cache
5. Purge Litespeed cache (`wp litespeed-purge all`)
6. Re-create L2 trigger (use `/tmp/install-rn-trigger.php` which has the working nested-IF syntax — `ELSEIF` doesn't work in MariaDB trigger bodies)
7. Re-enable L1 mu-plugins (`mv .bak-fix-* back to original name`)
8. Verify with `curl` that the live page shows the new content

**Why this is the biggest gotcha:** A successful `$dbh->query("UPDATE wp_posts SET post_content=...")` returns `affected_rows=1`, but `get_post()` reads from `wp_cache_get('post_45')` first. If you skip `clean_post_cache` + `wp_cache_flush`, the visible output won't reflect the change for hours (until the Litespeed page cache expires, 1-hour default).

**Skill to load before any DB write on Genesis:** `paperclip-genesis-incident-triage` — the decision tree mapping symptoms to the right fix.

### Gate 10: Am I publishing or shipping any page that contains an LLM keyword text box?
**⚠️ JULY 25 INCIDENT — gen977 LLM keyword boxes have shipped broken on multiple Genesis pages.**

LLM keyword boxes are the `[gen977-*]` shortcode-rendered text boxes near the bottom of pages that ask visitors to paste a keyword. The `genesis-hide-broken-llm-boxes.php` mu-plugin auto-hides them when broken, but **broken boxes that ship are still a quality regression**.

Before any publish that touches a page containing a `gen977-*` box, you MUST:

1. Confirm the keyword text inside the `<strong>` tag is **non-empty**. Empty keyword = broken box = do NOT ship.
2. Confirm the box's "Continue" / submit button text is present and not corrupted.
3. After publish, run `/tmp/genesis-content-healthcheck.sh` and confirm L5 (visible "n" artifact cleanup) is still OK and L6 (rendered-HTML audit) reports zero hits.
4. After publish, `curl -s https://genesismotiondesign.com/<page-path>/ | grep -i "empty keyword\|broken-llm\|gen977-broken"` — must return zero matches.
5. Open the live page in the CDP browser. Confirm the box is either (a) hidden by the mu-plugin because it's broken, or (b) visible with a real keyword and a working button. **Never an empty/broken box visible to visitors.**

If the box is broken and you cannot fix it in this run, REMOVE the box (delete the gen977 shortcode from the page) rather than shipping it broken. The user-flagged regression was "broken keyword text box at the bottom of pages" — the mu-plugin hides some of them but not all.

### Gate 11: Am I writing to wp_posts or wp_options without verifying the Wall first?
**Mandatory pre-write checklist (paste the output into your task comment):**

```bash
# 1. Wall health
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
  "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ eval-file /tmp/genesis-content-healthcheck.sh"

# 2. Pre-write DB scan (must be 0)
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
  "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ db query \"SELECT COUNT(*) FROM wp_posts WHERE post_content LIKE '%rnrn%' OR post_content LIKE '%>rn%' OR post_content LIKE '%xa0%' OR post_content LIKE '%rn<%'\""

# 3. L1 mu-plugin + L2 trigger presence
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-1.pem ubuntu@46.51.222.175 \
  "sudo -u genes8393 /usr/local/lsws/lsphp74/bin/php /usr/bin/wp --path=/home/genesismotiondesign.com/public_html/ eval 'global \$wpdb; echo \"L1:\".(in_array(\"genesis-content-safety-guard.php\", array_keys(get_mu_plugins()))?\"OK\":\"FAIL\"); echo \"\\nL2:\".(\$wpdb->get_var(\"SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_NAME = \\\"genesis_rn_corruption_trigger\\\"\")?\"OK\":\"FAIL\");'"
```

If any of L1/L2/Wall is FAIL, STOP and escalate. Do NOT write content with the Wall degraded.

---

## Do-Not-Touch Inventory

These files MUST NOT be modified without explicit Benjamin approval:

| File | Risk |
|---|---|
| `gen816-csp.php` | Site-wide CSP → breaks all rendering (currently disabled) |
| `genesis-complete-fix.php` | Core theme patches |
| `genesis-design-system-safe.php` | Design CSS variables |
| `genesis-isotope-grid-fallback.php` | Portfolio grid |
| `genesis-lcp-safe.php` | LCP optimization |
| `genesis-content-safety-guard.php` | Content integrity guard |
| `genesis-content-safety.php` | Content validation |
| `genesis-2026-07-09-ux-fixes.php` | Nav menu + header logo CSS (July 10 fix) |
| `main-no-ajax.js` | Site-wide JS boot chain — one syntax error breaks counters, Swiper, lazy media |
| `vendors.js` | Theme dependency bundle |
| `vendors-core.js` | Theme dependency bundle |
| `header.php` | Theme header rendering |
| `js.php` | Theme script enqueue/render path |
| `.htaccess` | Redirect loops (cached 7 days by Cloudflare) |

---

## Deploy Procedure

Every Genesis deploy MUST follow:

1. Read `shared/GENESIS-WEBSITE-GUARDRAILS.md`
2. Source `safety.sh` and run `safety_preflight <target_file>`
3. Apply changes
4. Run `safety_postflight` (health-checks homepage + case-studies + services)
5. Purge caches: `wp cache flush` → `wp litespeed-purge all` → Cloudflare zone purge
6. Browser-verify at least 3 pages before marking done

## Escalation Path

If a task requires touching the do-not-touch inventory, CSP, or `.htaccess`:
1. Create a `request_confirmation` interaction on the issue
2. Explain WHY the change is needed and WHAT the risk is
3. Wait for Benjamin's approval before proceeding
4. Do NOT attempt to bypass the safety library

## Cache Purge Order (CRITICAL)

Wrong order = stale CDN pages for up to 7 days:
1. `wp cache flush`
2. `wp litespeed-purge all`
3. Cloudflare zone purge (zone ID: `c3661dd4a55a96afdedc5eab682af534`)
