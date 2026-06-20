# Paperclip — Cross-Ecosystem Reuse Opportunities

> What in Paperclip can be lifted and reused across **QSL**, **Selarix**, **Directory Factory**, and **TheBinMap**.
> Read-only analysis, 2026-06-20. `[OBSERVED]` = confirmed in this repo. `[DOCUMENTED]` = stated in config/docs. Sibling repos (Directory Factory, TheBinMap) were **not** in scope — reuse fit for those is inferred from Paperclip's generic surface and noted as inference.

---

## Orientation: who already uses what

- **QSL (Quantum Shield Labs)** — already a first-class Paperclip company (`QSL_CONFIG.md`, `templates/QSL_PAPERCLIP_CONTEXT.md`, `qsl_findings` table, `qsl-bridge` routes, `QslReview.tsx`). Deepest integration. `[OBSERVED]`
- **Selarix** — already a Paperclip company (`SELARIX_CONFIG.md` company ID `11dc08e7-…`, `SELARIX_OPS_SETUP.md`: CEO agent, daily swarm health-check routine, SSH/EC2 secrets, SEL-1 standing issue). `[DOCUMENTED]`
- **Directory Factory / TheBinMap** — not present in this repo. Treated as candidate consumers of Paperclip-as-a-platform. `[inference]`

The strategic point: **Paperclip is already the shared control plane.** Most "reuse" is not copying code into other repos — it's onboarding the other businesses as **companies inside one Paperclip deployment** (the multi-company isolation is built for exactly this) or extracting a handful of genuinely standalone modules.

---

## Tier 1 — Reuse by onboarding as a Paperclip company (zero code copy)

These capabilities are company-scoped and isolated by design, so any of the four businesses gets them for free by becoming a company:

| Capability | Value to QSL | Selarix | Directory Factory | TheBinMap |
|---|---|---|---|---|
| Org chart + agent roster + reporting lines | ✓ (15-agent cabinet) | ✓ (swarm) | ✓ build/SEO crews | ✓ scraper/curation crews |
| Heartbeat scheduling (cron/webhook/API) | ✓ daily scans | ✓ daily swarm health | ✓ nightly directory rebuilds | ✓ periodic map refresh |
| Budget hard-stops + cost tracking per agent/model | ✓ quota drain protection | ✓ | ✓ | ✓ |
| Approval gates + governance | ✓ board review | ✓ | ✓ publish gates | ✓ data-quality gates |
| Issue/ticket system with goal ancestry | ✓ | ✓ | ✓ | ✓ |
| Secrets (instance + company, redacted, scoped) | ✓ EC2 SSH keys, wallets | ✓ SSH/EC2 secrets | ✓ API keys | ✓ scraper creds |
| Execution workspaces (git worktrees) | ✓ | ✓ | ✓ codegen | ✓ |
| Company export/import + portability | ✓ instance backup | ✓ | ✓ template clone | ✓ template clone |

**Action:** stand up Directory Factory and TheBinMap as companies (mirror `SELARIX_OPS_SETUP.md`). The `templates/qsl-instance-backup/` snapshot + `company-portability.ts` give a clone-and-rename path. `[OBSERVED capability]`

---

## Tier 2 — Standalone modules worth extracting/sharing

These are clean enough to lift out and reuse even *outside* a Paperclip deployment:

### A. The Python runtime-health stack (`scripts/*.py`) — highest reuse value
Self-contained, no server dependency, operates on an instance directory. Directly reusable by any ops-heavy business:
- `runtime_topology_report.py`, `runtime_guardian.py`, `runtime_remediator.py`, `runtime_history.py`, `runtime_rotation.py`, `runtime_export.py`, `governance_checkpoint.py`.
- **Reuse fit:** Selarix already runs EC2 health-check scripts (`security_engineer health-check`, `treasurybot report`, etc.) — wire those signals into `runtime_guardian` for unified scoring. Directory Factory / TheBinMap (data pipelines) benefit from the same orphan/staleness/duplicate detection and hash-chained checkpoints. `[OBSERVED — already executes against QSL instance]`
- **To make portable:** parameterize the instance root (already takes `C:\Users\mikeb\.paperclip\instances\default`); drop QSL-specific assumptions in topology scan.

### B. Board intelligence export (`server/scripts/generate-board-export.ts` + `board_exports/`)
Generates governance.md, review packets, transaction-integrity reports from DB tables. **Reuse fit:** any company gets a board-review packet; aligns with the user's "always generate a review packet before approvals" rule. `[OBSERVED]`

### C. Fingerprint-dedup + durable-decision pattern (from `qsl-review.ts`)
SHA-256(`title+category+severity`) upsert that **never overwrites human decisions**, append-only review history, `database→fallback→bridge→empty` source hierarchy with `X-QSL-Source` header.
- **Reuse fit:** TheBinMap (deduping map entries across crawls) and Directory Factory (deduping directory listings across rebuilds) have the *exact* "re-scan must not clobber human curation" problem QSL solved. Generalize `qsl_findings` into a `reviewable_findings` pattern. `[OBSERVED — strong fit, inference for siblings]`

### D. Adapter contract (`packages/adapter-utils` + `ServerAdapterModule`)
One interface (`execute`, `sessionCodec`, `getConfigSchema`, `getQuotaWindows`, `listModels`, skills) abstracts Claude/Codex/Cursor/Gemini/OpenCode/Pi/OpenClaw. **Reuse fit:** any ecosystem repo that shells out to multiple AI CLIs should adopt this contract instead of bespoke wrappers. `[OBSERVED]`

### E. Plugin SDK (`packages/plugins/sdk`)
Out-of-process JSON-RPC workers, capability gating, custom DB/entities/routes/UI. **Reuse fit:** Directory Factory and TheBinMap can be implemented *as Paperclip plugins* (custom entities + jobs + UI tabs) rather than separate apps — sharing auth, secrets, scheduling, and the board UI. `[OBSERVED capability; inference on fit]`

### F. PARA file-memory skill (`skills/para-memory-files`)
File-based persistent agent memory. **Reuse fit:** any long-running agent in any of the four businesses. `[OBSERVED]`

---

## Tier 3 — Patterns to copy (not code)

- **Hash-chained governance checkpoints** — cheap deterministic continuity for any autonomous system. `[OBSERVED]`
- **Approval-aware non-destructive remediation** — auto-run inspections, gate mutations, expire stale plans. `[OBSERVED]`
- **Risk register + dated changelog + sequenced hardening order** — drop into each repo's root. `[OBSERVED]`
- **Secret-ref bindings + regex log redaction** — never let creds reach prompts/logs. `[OBSERVED]`

---

## Concrete reuse recommendations

1. **Consolidate.** Run all four businesses as companies in one Paperclip deployment rather than four control planes. This is the single biggest reuse win and the product is built for it. `[OBSERVED capability]`
2. **Extract the Python health stack into a small shared package** (`paperclip-ops/` or pip-installable) consumed by Selarix's EC2 scripts and any new business. `[OBSERVED ready]`
3. **Generalize `qsl_findings`/`qsl-review.ts` into a reusable "reviewable findings" module** for TheBinMap + Directory Factory dedup-with-human-curation. `[inference, strong fit]`
4. **Implement Directory Factory + TheBinMap as plugins**, not standalone repos, to inherit auth/secrets/scheduling/UI. `[inference]`
5. **Fix or retire the Moltbook integration** before reusing content-distribution flows elsewhere — it has been broken (401) since 2026-04-09. `[OBSERVED BROKEN]`

---

## Caveat on inference

Directory Factory and TheBinMap source was not available in this harvest. All fit-claims for them are inferences from Paperclip's generic, company-agnostic surface (multi-company isolation, plugins, adapters, scheduling). Validate against those repos before committing engineering time.
