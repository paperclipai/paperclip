# ValAdrien OS — External Auditor Log

Independent, read-only health watch (Claude Code Desktop, Max subscription — does **not** bill the OS `ANTHROPIC_API_KEY`). One dated section per run. See `ENGINEERING-SESSION-BRIEF.md` for the checklist and access patterns.

---

## 2026-06-05 12:43 EDT — YELLOW

Infra layer is fully healthy; two degradations, both latent/known (no active incident, loop intentionally OFF).

**Tier 1 — public (GREEN)**
- `GET /` → 200 (3.3KB). `GET /api/health` → 200; `bootstrapStatus=ready`, `deploymentMode=authenticated`, `googleAuthEnabled=true`, `bootstrapInviteActive=false`.
- All 11 `/assets/*.{js,css}` chunks → 200, non-zero. Largest: `vendor` 3.92MB, `index` 2.15MB raw (eager bundle — known cold-load debt, Work Item 1; functioning, not a failure).

**Tier 2 — credentialed**
- **DB (GREEN):** `:5432` and `:6543` both answer `select 1`. `pg_stat_activity` 26/60 conns = 43% (active 4, idle 15). Well under 80%.
- **Railway worker `valadrien_staff` (GREEN):** 0 `Server listening` boots in captured window (~12:50–15:52 UTC, 500 lines) → no crash loop. 0 `uncaughtException`/`EDBHANDLEREXITED`/`FATAL`/`504`. Hourly DB backups completing cleanly (~512KB, prunedCount 0).
- **Heartbeat runs (last 12h) — YELLOW:** 4 runs, **0 succeeded** (3 `adapter_failed`, 1 `cancelled`/`issue_terminal_status`). 0 stuck `running`. All runs were Sol (`13d9a505`) in a 04:31–05:02 UTC burst; idle since. **By the raw rule (0 successes) this reads RED, but mitigated:** both agents are manually `paused` and the heartbeat is OFF — these are leftover staged-test failures, not a live loop failing.
  - Root cause confirmed = **known Sol sandbox-home blocker (Work Item 2):** `error="ENOENT: no such file or directory, mkdir '/home/sbx_user1051'"`. Per-agent sandbox home under root-owned `/home` not writable by the `node` user. Tracked in DB task `7b336a40`. Recommended action: land the runtime/Docker fix (point sandbox-home base at the writable `/valadrien-os` volume, or pre-create+chown in `scripts/docker-entrypoint.sh`, or disable per-agent sandbox for `claude_local`) — see brief.
- **Agents (GREEN):** none in `status='error'`. Sol `paused/manual` (last_hb 05:02 UTC), Ti Claude `paused/manual` (last_hb 06-04 15:25 UTC). Stale heartbeats expected while paused.
- **Budget (GREEN):** Sol 743/2000¢ = 37.2%; Ti Claude 424/2000¢ = 21.2%. Both under 80%.
- **Vercel prod — YELLOW:** latest production deployment `dpl_E3Qyy4VoQFe72nJc8dsoehtKqoA5` = `READY`, alias `os.valadrien.dev`, but on commit `d0a63c87`. Branch HEAD = `f84775a3` (local == origin, 0 ahead/0 behind). **Prod is 3 commits behind HEAD**, un-promoted:
    - `f84775a3` fix(heartbeat): treat recent output as liveness so the reaper stops false-positiving
    - `d57d35b7` fix(heartbeat): a confirmed adapter success overrides a stale reaper mark
    - `fe43c42e` fix(runtime): CLAUDE_CODE_FORCE_SANDBOX=0 — disable claude's broken nested Bash sandbox
  - Note: the heartbeat/runtime fixes primarily affect the **Railway worker** (deployed via manual `railway up`, not Vercel promote). Could **not** verify the Railway-deployed commit from logs alone. Recommended: confirm `railway up` ran with these fixes; `vercel promote` the UI/control-plane when ready.

**Couldn't check / skipped:** `psql` not installed → used repo `pg@8.21.0` via Node for read-only SELECTs (worked). Railway log tail covered ~4h, not the full 12h (no boots/errors in covered window). Railway-deployed commit SHA not determinable from logs.

**Verdict:** YELLOW. No production incident. Watch items: (1) Sol sandbox-home blocker still unresolved — agent execution loop will fail the moment the heartbeat is re-enabled; (2) prod 3 commits behind HEAD (un-promoted fixes). No GitHub issue opened (reserved for RED); both items already tracked (DB task `7b336a40` + brief Work Items 1–2).

---

## 2026-06-05 13:10 EDT — Performance QA: cold-load / "extremely slow app" (read-only)

User report: lazy start, app extremely slow. Measured against live prod (`os.valadrien.dev`). **Conclusion: the slowness is client-side — a ~2.18MB-brotli eager JS graph parsed/executed before first interactive. The network/server layer is healthy.** This is Work Item 1 (cold-load); the partial fixes shipped (vendor `manualChunks` + immutable cache) are confirmed live, but the core fix (lazy-loading) is **not yet done**.

### Measured baseline (live prod, brotli, warm CDN)
| Layer | Result | Verdict |
|---|---|---|
| Compression | **brotli on** all JS/CSS | ✅ healthy |
| Asset cache | `public, max-age≈31536000` immutable | ✅ healthy (Work Item 1 partial done) |
| Asset TTFB | 0.11–0.27s (CDN `iad1`) | ✅ healthy |
| **Eager JS on first paint** | **~2.18MB brotli across 8 `modulepreload`'d chunks** | ❌ the problem |
| API cold start `/api/health` | **1.0s cold → 0.33s warm** (~0.7s penalty; saw 1.6s colder) | ⚠️ secondary |

Eager chunk breakdown (brotli / raw):
- `vendor` **1.26MB / 3.92MB** — shared catch-all (the floor)
- `index` **542KB / 2.15MB** — **53 statically-imported pages** (`App.tsx`: 0 `React.lazy`, 0 `Suspense`)
- `editor` **111KB** (+ `editor.css` 8.7KB) — mdxeditor+lexical, eager (see below)
- `react-vendor` 76KB · `markdown` 48KB · `index.css` 38KB · `radix` 36KB · `chat` 25KB · `i18n` 17KB · `dnd` 17KB

### Root cause (code-level, confirmed)
1. **No route splitting.** `ui/src/App.tsx` statically imports **53 pages** → one eager 542KB-br `index` chunk. Every page's code downloads + parses on first paint regardless of route.
2. **Editor forced eager by globally-mounted UI.** `MarkdownEditor` is statically imported by 28 files, incl. `NewIssueDialog`/`NewGoalDialog`/`NewProjectDialog` (mounted globally via `DialogProvider` in `main.tsx`), plus `InlineEditor`, `IssueChatThread`, `AgentConfigForm`. So the 111KB-br `editor` chunk loads at startup even though no editor is on screen. `main.tsx` also eagerly does `import "@mdxeditor/editor/style.css"`.
3. **API cold start.** First lambda hit ~1.0–1.6s; with a blank shell this reads as a frozen "lazy start."

### Corrected assumptions (do NOT action these — already handled)
- **mermaid is already lazy** — `MarkdownBody.tsx` does `import("mermaid")` behind a `language-mermaid` check; it is NOT in the eager graph. The brief's "fix mermaid" TODO is already done.
- **Plugin bridge already lazy-loads the editor** — `bridge-init.ts:211` does `import("@/components/MarkdownEditor").then(...)`. Good pattern to copy at the other 6 app-code call sites.
- The 200MB+ node_modules (sqlite3, claude-agent-sdk, embedded-postgres) are **server/runtime** deps — not in the client bundle.

### Recommendations (ordered by ROI — read-only; implementation = Work Item 1)
1. **Route-level code splitting (biggest win).** Convert `App.tsx`'s 53 page imports to `React.lazy` + wrap `<Routes>` in `<Suspense fallback={…}>`. Named exports → a `lazyNamed` helper:
   ```ts
   const lazyNamed = (load, name) => React.lazy(() => load().then(m => ({ default: m[name] })));
   const IssueDetail = lazyNamed(() => import("./pages/IssueDetail"), "IssueDetail");
   ```
   Splits the 542KB-br `index` into ~53 route chunks; first paint loads only the landed route (e.g. Auth/Dashboard ≈ tens of KB).
2. **Lazy the editor at its call sites.** Wrap `MarkdownEditor` in `React.lazy` inside `NewIssueDialog`, `NewGoalDialog`, `NewProjectDialog`, `InlineEditor`, `IssueChatThread`, `AgentConfigForm` (copy the `bridge-init.ts` dynamic-import pattern). Removes `editor` (111KB) from the eager graph; it loads only when an editor surface opens. Note: route-splitting **alone won't** evict it because these are globally mounted via `DialogProvider`.
3. **Co-locate the editor CSS.** Move `import "@mdxeditor/editor/style.css"` out of `main.tsx` into the lazy editor component so the stylesheet loads with the editor, not at startup.
4. **Split/trim the `vendor` catch-all (1.26MB-br floor).** After 1–2, run `pnpm --filter @valadrien-os/ui build` chunk map and see what remains in `vendor`; split heavy libs into named chunks and tree-shake (e.g. ensure `es-toolkit` uses named imports, drop unused deps). This is the remaining floor once routes are split.
5. **Render an instant shell.** Paint a skeleton/spinner before auth/bootstrap resolves so the ~1s cold API call doesn't read as a blank/frozen screen.
6. **Cold start.** Confirm the API function runs on **Fluid Compute** (default — warm-reuses instances) rather than legacy per-request serverless; optionally a tiny scheduled warmer on `/api/health`. Secondary to the bundle.
7. **Verify discipline (runtime-risky).** A bad lazy boundary = blank route, not caught by build. After changes: build chunk map → deploy to **PREVIEW** → browse Auth, Dashboard, IssueDetail, and an editor dialog → only then `vercel promote`. **Never run `pnpm dev`/Vite** (crashes the machine — per brief).

**Expected impact:** removing `index` (542KB) + `editor` (111KB) + editor CSS from first paint ≈ **~660KB br off the eager path**; first-paint JS drops from ~2.18MB-br toward the ~1.26MB-br `vendor` floor + a small route chunk. Vendor splitting (rec 4) pushes it lower. No code changed in this audit — recommendations only.

### Real-browser Web Vitals (headless Chromium, cold load, desktop 1280×800, warm CDN)
Measured via the browse daemon against `os.valadrien.dev` (redirects to `/auth` unauthenticated — still loads the full eager bundle + fires the app's data calls). **This changes the priority order: the dominant user-facing latency is API cold-start, not the bundle.**

| Metric | Value | Rating |
|---|---|---|
| TTFB | 389 ms | good |
| FCP (first contentful paint) | 932 ms | ok |
| DOMContentLoaded / load | 886 ms | good |
| **LCP (largest contentful paint)** | **7,972 ms (~8s)** | ❌ **poor** (target <2.5s) |
| JS transferred / decoded | 2,089 KB br / 6,945 KB | heavy |
| CSS transferred | 46 KB | fine |

**Why LCP is 8s — the smoking gun.** The DOM is interactive at ~0.9s, but the largest paint (the right-panel "company that runs itself" agent graph) is gated on three data calls that **cold-started the serverless functions**:

| Endpoint (first hit, cold) | Status | Latency |
|---|---|---|
| `/api/auth/get-session` | 401 | **6,939 ms** |
| `/api/adapters` | 403 | **7,185 ms** (then retried 3× at 140/90/65 ms) |
| `/api/companies` | 403 | **7,085 ms** |

Re-measured **warm**, all three return in **0.13–0.34s**. So the ~7s is pure cold-start. `/api/health` (already warm from earlier probes) was 654 ms. The "lazy start / extremely slow" report = **the first load after the functions go idle pays a ~7s cold-start, and the app blocks its main paint on it.** Likely cause of the heavy cold init: the serverless function bundle drags in large server-only deps present in this repo (sqlite3 ~219MB, `@anthropic-ai/claude-agent-sdk` ~205MB, `embedded-postgres` ~145MB, playwright-core, codex-acp). Console also shows the unauthenticated `/auth` page firing authed calls that 401/403 and retry with backoff.

*Couldn't measure:* main-thread blocking (TBT/longtasks) — buffered `longtask` observer is deprecated in this Chromium build, returned 0.

### REVISED recommendations (re-prioritized by measured user impact)
> Correction to the section above: I first called cold-start "secondary." The browser test proves it's **#1** — it owns ~7s of the 8s LCP. Bundle work (old rec 1–4) is real but moves below it.

1. **Kill the API cold-start stall (8s → <1s) — biggest win.**
   a. **Slim the serverless bundle.** Make sure the Vercel API functions that serve the UI's hot routes (`get-session`, `adapters`, `companies`) do **not** bundle the heavy worker deps (sqlite3, embedded-postgres, claude-agent-sdk, playwright-core, codex-acp). Those belong on the **Railway worker**, not the Vercel request path. Externalize them / split control-plane API from worker code so cold init is small.
   b. **Keep functions warm.** Confirm Fluid Compute is on (default — reuses instances), and add a Vercel cron warmer hitting `/api/health` + the hot routes every few minutes so the first real user doesn't eat a cold start.
2. **Don't block first paint on auth/data.** Render the auth shell + login form immediately; load the right-panel agent graph after mount with a skeleton. On `/auth` specifically, **don't call `/api/adapters` or `/api/companies` while unauthenticated** (they 403). Gate them behind a valid session.
3. **Stop the 403 retry storm.** Disable retries for 401/403 in the React Query client (auth errors aren't retryable). `/api/adapters` retried 4× on the auth page.
4. **Route-split `App.tsx`** (was rec 1) — `React.lazy` + `<Suspense>` for the 53 pages. Improves FCP/parse, ~542KB off first paint. Does **not** fix LCP.
5. **Lazy the editor at its call sites** (was rec 2) — removes 111KB `editor` chunk from the eager graph.
6. **Co-locate editor CSS, split the `vendor` floor** (was rec 3–4), **confirm Fluid Compute** folded into rec 1b.
7. **Verify discipline:** re-run this exact browse measurement after the fix (cold LCP 8.0s is the baseline to beat). Deploy to PREVIEW, browse Auth + Dashboard + IssueDetail + an editor dialog before `vercel promote`. Never run `pnpm dev`/Vite.

**Headline:** the app isn't slow because of React — it's slow because the first request after idle cold-starts a heavyweight serverless function for ~7s and the UI waits on it. Fix cold-start first (rec 1–3); do the bundle diet second (rec 4–6).
