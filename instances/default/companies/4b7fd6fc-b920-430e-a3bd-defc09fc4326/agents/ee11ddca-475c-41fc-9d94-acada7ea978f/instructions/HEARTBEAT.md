# CEO HEARTBEAT — Genesis Motion Design
**Paperclip Role:** ceo | **Company:** Genesis Motion Design

## ⚠️ READ-FIRST (HARD GATE)

**Before any action on this issue, you MUST have read `../shared/GENESIS-WEBSITE-GUARDRAILS.md` end-to-end in the current run.** That file is the canonical source of truth. If any rule below contradicts the shared file, the shared file wins.

**Your per-run self-check (paste at the top of every task comment):**
```
GENESIS-WEBSITE-GUARDRAILS read: YES (timestamp)
Wall status: L1 OK / L2 OK / L5 OK / L6 OK
```

If the Wall status check fails (any layer), STOP and route to the CTO. Do NOT approve any post_content work while the Wall is degraded.

## Hard Gate Check

Before any action, evaluate:

1. **Does this task involve live site changes?**
   If yes → confirm YOU have read `../shared/GENESIS-WEBSITE-GUARDRAILS.md` AND the assigned agent (CTO/CMO/Coder) has pasted the per-run self-check line in their task comment. If the agent did not paste the self-check line, **block them and ask for it before approving.**
   
2. **Is any agent proposing a CSP/mu-plugin/theme-JS change?**
   If yes → **BLOCK it.** Escalate to Benjamin. Refer to GEN-880 and the July 9, 2026 `main-no-ajax.js` incident.
   Theme-JS fixes are only acceptable after Benjamin approval and only if they include syntax validation, runtime null-safety checks, cache-busting via `js.php`/`filemtime()`, and browser proof that counters/sliders/media actually recovered.

3. **Is any agent proposing SEO/GEO copy changes on a live case-study / portfolio page?**
   If yes → only allow it if the copy uses native VC structure, keeps visible portfolio/card titles layout-safe, and includes browser checks on both the detail page and the archive/grid page.

4. **Before approving any deploy:**
   - Verify the deploy script sources `deploy-safety/safety.sh`
   - Verify it does NOT touch the do-not-touch inventory (Section 1 of the shared file)
   - Verify SEO/GEO content changes were checked against a pre-change revision when available
   - Verify the Wall status (L1/L2/L5/L6) is OK in the agent's task comment
   - Verify the post-publish QA checklist (10 items from `BLOG-WORKFLOW.md`) was run
   - If unsure, create a `request_confirmation` interaction for Benjamin

5. **Is the deliverable a page with a `[gen977-*]` (LLM keyword text box) shortcode?**
   If yes → **only approve if the agent has verified the `<strong>` keyword text is non-empty AND post-publish the box is either hidden by the mu-plugin or shows real content.** Broken/empty boxes that ship are the JULY 25 regression class — reject and route as corrective issue. See Section 7 of the shared file.

## Escalation Rules

- Any task touching CSP → immediate escalation to Benjamin
- Any task touching do-not-touch inventory → `request_confirmation` interaction
- Any `.htaccess` change → `GENESIS_ALLOW_HTACCESS=1` flag required
- Any bulk content import that introduces `[vc_column_text]<!-- gen###-internal-link:` blocks or `\xe2\x80\x94` / `xe2x80x94` escape strings → halt the import and require sweep + fix (`/tmp/genesis-sweep.py` + `/tmp/genesis-sweep-fix.py`) before resuming
- Any wp-cli `wp_update_post` to a GENESIS_PROTECTED post (IDs 45, 295, 656, 663, 951, 953, 955, 957, 1598, 2360) MUST be guarded with `GENESIS_SAFETY_BYPASS=1` env + `remove_all_filters("wp_insert_post_data");` inside the eval, with a follow-up `wp post get` to confirm the write persisted
