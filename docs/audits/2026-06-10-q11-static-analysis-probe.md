# Q11 Static-Analysis Tool Probe

**Date:** 2026-06-10  
**Branch:** `docs/q11-static-analysis-probe`  
**Codebase:** Paperclip monorepo (pnpm, TypeScript, ~975k lines across packages/, server/, ui/, cli/)  
**Question:** Which one static-analysis tool for the TS/JS stack?

---

## Candidates Evaluated

| Tool | Version | Probe command |
|---|---|---|
| Fallow | 2.91.0 | `npx fallow dead-code --format json` |
| Knip | latest | `npx knip --reporter json` |
| JSCPD | latest | `npx jscpd --format typescript,javascript --reporters json` |
| dependency-cruiser | 17.4.3 | `npx dependency-cruiser --config ... --output-type json` |
| ESLint curated set | — | Evaluated only (no existing config; cost/benefit assessment) |

Raw outputs: `/tmp/lanes/q11-outputs/`

---

## Results by Tool

### 1. Fallow (`dead-code`) — 1.2s runtime

**Issue summary (727 total):**

| Category | Count |
|---|---|
| Unused exports | 373 |
| Unused types | 231 |
| Unused files | 59 |
| Unused dependencies | 13 |
| Unlisted dependencies | 15 |
| Unresolved imports | 19 |
| Circular dependencies | 2 |
| Duplicate exports | 6 |
| Unused class members | 9 |

**Output quality:** Structured JSON (schema v7), each issue has `path`, `line`, `col`, `actions[]` with `auto_fixable` flag, suppression instructions. Multiple output formats: `json`, `sarif`, `markdown`, `codeclimate`, `pr-comment-github`, `pr-comment-gitlab`, `review-github`, `review-gitlab`. Native GitHub/GitLab PR comment integration via `fallow ci-template`. `--fail-on-issues` and `--fail-on-regression` for CI gates.

**Findings sampled (5 verified):**

1. `cli/src/client/board-auth.ts:63` — `resolveBoardAuthStorePath` exported but nothing imports it outside the file. **TRUE POSITIVE.** `auto_fixable: true`.
2. `cli/src/commands/onboard.ts:416` ↔ `cli/src/commands/run.ts:8` — circular dependency. **TRUE POSITIVE.** `onboard.ts` does `await import("./run.js")` at line 416; `run.ts` imports from `onboard.ts` at line 8. Dynamic import breaks static resolution.
3. `docker/openclaw-smoke/server.mjs` — flagged as unused file. **FALSE POSITIVE.** File is a Docker runtime entry point (`CMD ["node", "/app/server.mjs"]` in Dockerfile); not statically imported. Same false-positive class as Knip on Docker entry points.
4. `packages/adapter-utils` — 13 items in `unlisted_dependencies` (packages used but not declared). **TRUE POSITIVE** (spot-checked: several `@internal` transitive deps confirmed undeclared).
5. `cli/src/config/server-bind.ts` — `detectTailnetBindHost` and `resolveQuickstartServerConfig` flagged unused. **TRUE POSITIVE** — grepped entire codebase, no consumer outside the file.

**MCP integration:** No native MCP server. `fallow license` manages a paid runtime-coverage add-on; static analysis features run fully offline/free.

**False positive rate (sampled):** 1/5 = 20%, class: Docker/shell entry points not statically traceable (same limitation as Knip and any static tool).

---

### 2. Knip — 9s runtime

**Issue summary:**

| Category | Count |
|---|---|
| Unused exports | 319 |
| Unused types | 252 |
| Unused files | 45 |
| Unused dependencies | 13 |
| Unused devDependencies | 26 |
| Duplicate exports | 7 |
| Binaries (unlisted) | 62 |
| Unlisted deps | 97 |

**Output quality:** JSON per-file with per-symbol arrays. No `auto_fixable` flag; issues require manual interpretation. No native CI PR-comment integration. Config via `knip.json` / zero-config. Exit code 1 on issues.

**Findings sampled (5 verified):**

1. `cli/src/client/board-auth.ts` — `resolveBoardAuthStorePath` unused. **TRUE POSITIVE** (same as Fallow).
2. `cli/src/config/server-bind.ts` — `detectTailnetBindHost` unused. **TRUE POSITIVE**.
3. `packages/plugins/examples/plugin-file-browser-example` — `@codemirror/state` as unused dep. **NEEDS REVIEW** — plugin example may have intentionally loose deps for illustration.
4. `server/src/adapters/cursor-models.ts` — `parseCursorModelsOutput` unused. **TRUE POSITIVE**.
5. `docker/traceloop-init.js` — flagged as unused file. **FALSE POSITIVE** — Docker entry point, same class as Fallow.

**False positive rate (sampled):** 1-2/5 ≈ 20–40%; slightly noisier on devDependency binaries (97 "unlisted" vs Fallow's 15).

**MCP:** No native MCP server (community `knip-mcp` package exists but unmaintained).

---

### 3. JSCPD (TS/JS only) — 168ms runtime

**Issue summary (filtered to `.ts`/`.tsx`/`.js` only; excluding migrations):**

| Metric | Value |
|---|---|
| Clone pairs | 1,153 |
| Duplicated lines | 14,541 |
| Duplication % | 6.19% of TS/JS lines |
| Total TS/JS lines scanned | 234,909 |

**Output quality:** JSON with `firstFile`/`secondFile`, start/end lines. Machine-readable. Exit code 0 even with clones (needs `--threshold` flag to use as a hard gate).

**Top findings verified (5):**

1. `packages/adapters/claude-local/src/server/parse.ts:211` ↔ `packages/adapters/codex-local/src/server/parse.ts:92` — **114 lines** shared. **TRUE POSITIVE.** Files differ in length (391 vs 261 lines) confirming divergence; the 114 shared lines represent stream-parsing logic that could move to `adapter-utils`.
2. `server/src/services/company-portability.ts:2188` ↔ `server/src/services/company-skills.ts:446` — **82 lines** shared. **TRUE POSITIVE.** Common permission-assertion + DB transaction pattern duplicated between two service files.
3. `cli/src/commands/client/zip.ts:64` ↔ `ui/src/lib/zip.ts:150` — **66 lines** shared cross-package. **TRUE POSITIVE.** Zip utility duplicated between CLI and UI.
4. `server/src/routes/access.ts:4071` ↔ `server/src/routes/access.ts:4168` — **60 lines** intra-file. **TRUE POSITIVE.** Two route handlers (`PATCH /members/:memberId` and `PATCH /members/:memberId/role-and-grants`) share identical preamble; differ only in schema validation and URL.
5. `packages/adapters/acpx-local/src/ui/build-config.ts` ↔ `packages/adapters/codex-local/src/ui/build-config.ts` — **66 lines**. **TRUE POSITIVE.** Adapter UI build configs near-identical.

**Note:** Without `--format typescript,javascript`, JSCPD scans migration JSON snapshots and returns 2,576 "clones" at 14.3% — almost entirely false positives. Always filter.

**False positive rate (sampled, filtered):** 0/5. JSCPD addresses a **different concern** (code duplication) than dead-code/dependency tools. It is complementary, not competitive with Fallow.

---

### 4. dependency-cruiser — ~120s runtime

**Findings:**

- With `--no-config` (no rules): 1,144 modules mapped, 0 violations. Produces a full dependency graph in JSON.
- With rules config (circular + orphan + cross-package-private): 0 violations triggered. Rules require careful tuning to the actual package layout.
- Raw circular dep pairs detected in the graph: **30 unique pairs** (46 directed).

**Analysis of circular pairs:** The 30 pairs are almost entirely barrel-file patterns (`cli/src/checks/index.ts` ↔ `cli/src/checks/agent-jwt-secret-check.ts`, etc.) — index files that re-export submodules that type-import from the index. Fallow conservatively filtered these to **2 real runtime cycles**. dep-cruiser's circular detection is aggressive (any graph cycle counts), leading to ~93% false positives on this codebase with default settings.

**Output quality:** JSON is very large (1.3MB for packages + server + cli). Useful for graph visualization (`depcruise --output-type dot | dot -T svg`). For violation detection, requires substantial rules investment.

**Runtime:** ~120 seconds. Prohibitively slow for CI unless scoped to changed packages.

**MCP:** None. CLI-only.

**False positive rate (circular only):** ~28/30 = 93% (barrel patterns). Architecture violation rules would have better precision but require significant config work.

---

### 5. ESLint curated set — evaluated, not run

No ESLint config exists anywhere in this monorepo. To get architecture-level signal comparable to the tools above would require:

- `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` (TS parsing)
- `eslint-plugin-boundaries` (package boundary enforcement) — distinct concern, not dead-code detection
- `eslint-plugin-import` or `eslint-plugin-n` (import ordering, no-cycle)

**Assessment:**
- Different category: ESLint catches issues at write time (IDE integration), not as a one-shot codebase probe
- Maintenance burden HIGH: multiple plugins with incompatible versions, per-package config in monorepo
- Does not detect unused exports/types/dependencies — TypeScript compiler and dedicated tools are better for this
- Does not produce consolidated "here are all the dead exports" report
- Would require a separate `eslint --format json` run per package to aggregate

**Verdict: Excluded from competition.** ESLint-as-linter is a valid complementary tool for enforcing import rules at PR time, but it is not a static-analysis probe tool and adds a third vocabulary alongside TypeScript and the winner.

---

## Comparison Table

| Criterion | Fallow | Knip | JSCPD | dep-cruiser | ESLint set |
|---|---|---|---|---|---|
| **Agent-friendly JSON** | ✅ structured, schema-versioned, auto_fixable flags | ✅ per-file arrays | ✅ clone pairs | ✅ (1.3MB, complex) | ✅ via --format json |
| **MCP integration** | ❌ | ❌ (community stub) | ❌ | ❌ | ❌ |
| **CI-friendly exit codes** | ✅ --fail-on-issues, --fail-on-regression | ✅ exits 1 | ⚠️ exits 0 by default | ✅ with rules | ✅ |
| **CI PR comments** | ✅ native (GitHub + GitLab) | ❌ | ❌ | ❌ | ❌ |
| **SARIF output** | ✅ | ❌ | ❌ | ❌ | ✅ (@microsoft/eslint-formatter-sarif) |
| **Speed** | ✅ 1.2s | ⚠️ 9s | ✅ 168ms (filtered) | ❌ ~120s | ⚠️ per-package |
| **Zero-config start** | ✅ | ✅ | ⚠️ (needs --format filter) | ❌ (requires rules) | ❌ (needs full setup) |
| **Dead code / unused exports** | ✅ 727 issues | ✅ overlapping 571+ issues | ❌ | ❌ | ❌ |
| **Dep hygiene** | ✅ | ✅ | ❌ | ❌ | ⚠️ partial |
| **Copy-paste detection** | ❌ | ❌ | ✅ 1,153 pairs | ❌ | ❌ |
| **Circular deps** | ✅ (2 real) | ❌ | ❌ | ⚠️ (30 noisy) | ⚠️ no-cycle plugin |
| **Baseline/regression** | ✅ --fail-on-regression | ❌ | ❌ | ❌ | ❌ |
| **Auto-fixable flags** | ✅ | ❌ | ❌ | ❌ | ✅ --fix |
| **False positive rate** | ~20% (Docker EP class) | ~20-40% | ~0% (filtered) | ~93% (barrel circulars) | N/A |
| **Maintenance burden** | ✅ single binary, versioned | ✅ | ✅ | ⚠️ config-heavy | ❌ multi-plugin |
| **Active development** | ✅ v2.91.0 yesterday | ✅ | ✅ | ✅ | — |

---

## Recommendation: **Fallow**

**Rationale:**

Fallow covers the full spectrum of what a static-analysis probe needs: unused code, type exports, file-level dead code, dependency hygiene, and circular dependency detection — in a single 1.2-second run. Its JSON output is structured, schema-versioned, and includes `auto_fixable` flags and per-issue suppression instructions, making it directly consumable by agents and CI scripts without post-processing.

The closest competitor is Knip, which covers overlapping ground but is 7× slower (9s vs 1.2s), lacks auto-fixable metadata, has no native CI PR-comment integration, and returned a noisier signal on the `unlisted_dependencies` category (97 vs 15). Fallow's circular-dependency detection is also more conservative and accurate (2 real cycles vs dep-cruiser's 30 noisy barrel patterns).

JSCPD addresses a genuinely different concern (copy-paste duplication) and its findings are complementary (not competing) — the `cli/zip.ts` ↔ `ui/zip.ts` 66-line clone is a real housekeeping issue. However, it should not be the primary tool; it would pair with Fallow as an optional second pass.

dependency-cruiser is architecturally powerful but too slow and config-heavy to deliver value without significant investment. ESLint is the right tool for write-time linting, not a one-shot probe.

**One-vocabulary principle satisfied:** Fallow wins. JSCPD noted as a complementary-but-distinct concern (duplication ≠ dead code).

---

## Proposed CI Integration (Fallow)

Add to `.github/workflows/ci.yml` (or equivalent) as a non-blocking annotation step initially, graduating to blocking after a baseline is established:

```yaml
# In the lint/check job:
- name: Static analysis (Fallow)
  run: |
    npx fallow@latest dead-code \
      --format pr-comment-github \
      --output-file /tmp/fallow-pr-comment.md \
      --fail-on-regression \
      --baseline .fallow-baseline.json
  # On first run (establish baseline):
  # npx fallow dead-code --format json --output-file .fallow-baseline.json
```

**Key flags:**
- `--fail-on-regression` (not `--fail-on-issues`): blocks only if the issue count increases vs baseline, letting the existing 727 issues be tracked without blocking every PR until they're cleaned up.
- `--format pr-comment-github`: posts inline annotations on the PR diff.
- `--format sarif --sarif-output-file results.sarif`: uploads to GitHub Security tab for persistent tracking.

**Baseline file** (`.fallow-baseline.json`): commit to root, updated deliberately when issues are fixed or suppressed. Keeps noise out of CI while maintaining a ratchet.

**Follow-up work (out of scope for this probe):**
1. Add `.fallowrc.json` to configure entry points for Docker/shell scripts (reduces the false-positive class).
2. Suppress the 59 "unused files" that are legitimate runtime entry points (with `// fallow-ignore-file unused-file` comments or config).
3. Evaluate whether the 373 unused exports should be cleaned up (many may be intentional public API surface for the plugin system).
4. Optional: add JSCPD as a separate duplication gate if the `cli/zip.ts` ↔ `ui/zip.ts` class of duplicate is high-priority.
