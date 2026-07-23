# Best Matcha log audit — 2026-07-21

## Scope

Read-only audit of local `best-matcha.test`:

- OpenLiteSpeed error log: `.wpdev/ols-docker/logs/best-matcha-error.log` — 298,190 bytes, 1,799 lines, retained from 2026-07-19 through 2026-07-21 13:29 UTC.
- OpenLiteSpeed access log: `.wpdev/ols-docker/logs/best-matcha-access.log` — 4,235,606 bytes, 13,145 lines, retained from 2026-07-21 08:11 through 13:29 UTC.
- WordPress debug log: `sites/best-matcha/wp-content/debug.log` — 70,507 bytes, 347 lines, retained through 2026-07-20 21:32 UTC.

Counts between error/debug streams overlap. No log was truncated or mutated.

Current health proof:

- `https://best-matcha.test:8443/` follows one redirect and returns HTTP 200.
- `https://best-matcha.test:8443/wp-json/` returns HTTP 200.
- Active Elementor Framework release resolves to `/home/agents/workspaces/wordpress/releases/cla-943-aed7c113/elementor-framework`.
- Fresh homepage HTML contains zero malformed `/wp-content/plugins/home/agents/.../releases/...` asset URLs.

## Findings untreated before this audit

| Finding | Evidence | Disposition |
|---|---|---|
| Voxel Addon `IconField` requires absent `templates/icon-field.php` | 13 fatals plus 13 paired warnings in OLS log; latest 2026-07-21 13:20:49 UTC; `IconField.php:163`; edit-form requests returned HTTP 500 | [CLA-1098](/CLA/issues/CLA-1098) fixed and [CLA-1104](/CLA/issues/CLA-1104) QA-approved; [CLA-1105](/CLA/issues/CLA-1105) integrated commit `9515d12` into Voxel Addon default branch. Best Matcha still needs applicable release deployment before fresh-log closure. |
| Elementor Framework scalar coercion warnings | 190 OLS history lines and 212 overlapping debug-history lines across `settings_resolver.php` and `includes/media/icons.php`; active release emitted seven fresh `settings_resolver.php:84` warnings from 13:27:22 through 13:29:06 UTC | [CLA-1100](/CLA/issues/CLA-1100) fixed and QA/DevOps-approved at `6469bba5`; dedicated integration and local release deployment remain its named delivery action. |
| Voxel search terms SSR assumes `props.per_page` | 8 OLS warnings plus 2 debug warnings at `terms-ssr.php:61/85` | [CLA-1101](/CLA/issues/CLA-1101), blocked by live-source contract inspection [CLA-1106](/CLA/issues/CLA-1106). |
| Voxel price reindex uses `TRUNCATE` across foreign-key reference | 1 WordPress DB error at 2026-07-20 19:12:24 UTC: `wp_voxel_price_index_products` references `wp_voxel_index_products` | [CLA-1102](/CLA/issues/CLA-1102); QA requested changes after data-integrity review, Backend owns remediation. |
| Code Snippets Pro logs absent optional `code-snippets-pro-en_US.mo` as failure | 8 OLS entries, last 2026-07-19 12:32:27 UTC | [CLA-1103](/CLA/issues/CLA-1103) fixed and QA/DevOps-approved at `3f22f08`; dedicated default-branch integration/deployment remains its named delivery action. |

No unmatched actionable signature remains after these tasks were created and routed. All implementation issues use active component projects. Code/site delivery routes through QA Engineer review and DevOps Engineer approval/integration.

## Mapped existing tasks

| Signature | Evidence | Existing task |
|---|---|---|
| Hierarchy `wp_voxel_relations` FK failure for parent 12755 / child 14661 | 3 DB errors and 3 `RelationWriter` fatals | [CLA-891](/CLA/issues/CLA-891) |
| `ef_voxel_resolve_loop()` undefined | 21 OLS fatals plus debug fatal | [CLA-986](/CLA/issues/CLA-986), done; active release is newer than retained failure |
| Early `voxel-addon` textdomain loading | 3 debug notices | [CLA-1073](/CLA/issues/CLA-1073), done |
| Malformed Elementor image envelopes / post 16083 save validation | 6 OLS warnings plus retained debug events | [CLA-310](/CLA/issues/CLA-310), [CLA-361](/CLA/issues/CLA-361), [CLA-541](/CLA/issues/CLA-541) |
| Elementor editor `localized`, `this.ui.input.val`, `NestedElementBase`, duplicate registration, ReactDOM/global-class errors | Retained editor errors and HTTP 400 global-class requests | [CLA-896](/CLA/issues/CLA-896), [CLA-905](/CLA/issues/CLA-905), [CLA-907](/CLA/issues/CLA-907), [CLA-908](/CLA/issues/CLA-908) |
| WordPress.org secure connection update warnings | 18 OLS occurrences plus retained debug warnings | [CLA-489](/CLA/issues/CLA-489), done |
| `FS_METHOD` duplicate definition | 43 early OLS warnings | [CLA-3](/CLA/issues/CLA-3), done |
| Preview/render-batch 400/403 | Retained access requests | [CLA-929](/CLA/issues/CLA-929), [CLA-943](/CLA/issues/CLA-943) |
| Old CLA-909 absolute release asset URLs return 404 | Retained access requests | Deployment lineage handled by [CLA-909](/CLA/issues/CLA-909) and [CLA-943](/CLA/issues/CLA-943); current homepage emits none |

## Historical or secondary events not filed

- 285 OpenLiteSpeed LSAPI dead-lock notices cluster around old failing requests and stop at 2026-07-21 02:43 UTC. Current front page and REST root respond with HTTP 200. Monitor; no standalone root cause proven.
- One LiteSpeed debug-log rename fatal from 2026-07-19 did not recur after debug directory creation.
- Two early `wp-config.php` parse lines and old `FS_METHOD` setup warnings are retained provisioning history, not current runtime.
- Source-map 404s are non-runtime artifacts.
- Expected or contract-dependent authenticated HTTP 400/403 responses were not treated as defects without failed-behavior evidence.

## Reusable all-sites audit skill

Managed company skill:

- ID: `aedea575-1dce-4a7c-b064-727dfcb0c955`
- Key: `company/3000c724-cd0c-4ff0-b21c-d721a74c113f/site-log-audit`
- Files: `SKILL.md`, `scripts/audit_logs.py`, `scripts/test_audit_logs.py`
- Compatibility: `compatible`
- Trust: `scripts_executables`
- Audit: warning-only (`script_trust`, `secret_reference`); no hard-stop finding. Secret references are redaction patterns and guidance, not embedded credentials.

Run one site or all discovered sites:

```bash
python3 scripts/audit_logs.py \
  --root /home/agents/workspaces/wordpress \
  --site best-matcha > best-matcha-audit.json
python3 scripts/audit_logs.py \
  --root /home/agents/workspaces/wordpress \
  > all-sites-audit.json
python3 scripts/test_audit_logs.py
```

Verification:

- Assert-based self-check: PASS, including sensitive query parameters in error/access lines and malformed request-target continuation.
- Python compilation: PASS.
- Managed skill files match verified local source byte-for-byte.
- Fresh Best Matcha parse since 2026-07-21 12:00 UTC: 3 files and 21 grouped events across all evidence streams.
- Redaction covers authorization values, bearer tokens, cookies, nonces, API keys, passwords, secrets, and other sensitive query values.
- Malformed access-log request targets fail closed as `<malformed-target>` without aborting later events.

## QA Engineer wiring

Company skill metadata identifies QA Engineer in `usedByAgents` with `desired: true` and `attachedAgentCount: 1`. Paperclip will materialize the desired skill in QA's runtime on its next applicable run.

Exactly one next action: QA Engineer reviews the security fix commit and fresh verification above. Paperclip then advances approved work to DevOps Engineer for final approval and integration.
