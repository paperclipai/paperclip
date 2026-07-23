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
- Active Elementor Framework release resolves to its local deployed release directory.
- Fresh homepage HTML contains zero malformed `/wp-content/plugins/home/agents/.../releases/...` asset URLs.

## Findings untreated before this audit

| Finding | Evidence | Disposition |
|---|---|---|
| Voxel Addon `IconField` requires absent `templates/icon-field.php` | 13 fatals plus 13 paired warnings in OLS log; latest 2026-07-21 13:20:49 UTC; `IconField.php:163`; edit-form requests returned HTTP 500 | Fix reviewed and integrated. Best Matcha needs applicable release deployment before fresh-log closure. |
| Elementor Framework scalar coercion warnings | 190 OLS history lines and 212 overlapping debug-history lines across `settings_resolver.php` and `includes/media/icons.php`; active release emitted seven fresh `settings_resolver.php:84` warnings from 13:27:22 through 13:29:06 UTC | Fix reviewed; integration and local release deployment remain delivery work. |
| Voxel search terms SSR assumes `props.per_page` | 8 OLS warnings plus 2 debug warnings at `terms-ssr.php:61/85` | Blocked by live-source contract inspection. |
| Voxel price reindex uses `TRUNCATE` across foreign-key reference | 1 WordPress DB error at 2026-07-20 19:12:24 UTC: `wp_voxel_price_index_products` references `wp_voxel_index_products` | Data-integrity review requested changes; backend remediation pending. |
| Code Snippets Pro logs absent optional `code-snippets-pro-en_US.mo` as failure | 8 OLS entries, last 2026-07-19 12:32:27 UTC | Fix reviewed; default-branch integration and deployment remain delivery work. |

No unmatched actionable signature remains after these tasks were created and routed. All implementation issues use active component projects. Code/site delivery routes through QA Engineer review and DevOps Engineer approval/integration.

## Mapped existing work

| Signature | Evidence | Status |
|---|---|---|
| Hierarchy `wp_voxel_relations` foreign-key failure | 3 DB errors and 3 `RelationWriter` fatals | Existing remediation work tracked. |
| `ef_voxel_resolve_loop()` undefined | 21 OLS fatals plus debug fatal | Done; active release is newer than retained failure. |
| Early `voxel-addon` textdomain loading | 3 debug notices | Done. |
| Malformed Elementor image envelopes / save validation | 6 OLS warnings plus retained debug events | Existing remediation work tracked. |
| Elementor editor `localized`, `this.ui.input.val`, `NestedElementBase`, duplicate registration, ReactDOM/global-class errors | Retained editor errors and HTTP 400 global-class requests | Existing remediation work tracked. |
| WordPress.org secure connection update warnings | 18 OLS occurrences plus retained debug warnings | Done. |
| `FS_METHOD` duplicate definition | 43 early OLS warnings | Done. |
| Preview/render-batch 400/403 | Retained access requests | Existing remediation work tracked. |
| Old absolute release asset URLs return 404 | Retained access requests | Deployment lineage handled; current homepage emits none. |

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
- Files: `SKILL.md`, `scripts/audit_logs.py`, `scripts/tests/test_audit_logs.py`
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
python3 scripts/tests/test_audit_logs.py
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
