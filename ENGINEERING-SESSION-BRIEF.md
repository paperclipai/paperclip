# Engineering Session Brief — ValAdrien OS runtime

Handoff from the runtime/ops session (2026-06-04). Pick up the engineering work below. Full background lives in auto-memory `project_management_os.md`.

## Where things are
- Repo: `/Users/fernandadrien/Projects/valadrien-os`, branch `rebrand/valadrien-os`.
- Architecture: **Vercel `valadrien-os-server`** = control plane + UI (os.valadrien.dev). **Railway** project `management-os` → service **`valadrien_staff`** = always-on execution worker. **One Supabase Postgres.**
- A **design session** deploys to the same Vercel project concurrently — the prod alias flips around. Anything committed to branch HEAD carries forward into their deploys too.

## Hard constraints (do not trip these)
- **NEVER run `pnpm dev` / Vite dev server** — Fernand's machine crashes. Verify via `pnpm --filter @valadrien-os/ui build` output + the browser tool against a deployed **preview**.
- **DB access:** query via the **session pooler `:5432`**, NOT `:6543` (it saturates/times out). Get the URL from `railway variables --service valadrien_staff --json` (field `DATABASE_MIGRATION_URL`, already `:5432`). `RAILWAY_TOKEN=$(cat ~/.config/valadrien/railway-token)` works for `variables`/`logs`/`status`/`up`.
- **`railway ssh` needs ACCOUNT auth** (run `railway login` / a workspace `RAILWAY_API_TOKEN`); the project token can't do ssh. ssh also needs a `~/.ssh/config` with `Host *\n  StrictHostKeyChecking accept-new` (no host key trusted by default). **`railway ssh` runs in a SEPARATE pid namespace/cgroup** from the server — `ps`/cgroup readings there are the wrong namespace; use the service's stdout logs instead.
- **Deploy mechanism:** `git push origin rebrand/valadrien-os` → Vercel builds a **PREVIEW** (not prod). To go live: `vercel promote <preview-url> --scope valdola-stacks-projects --yes` (rebuilds for prod; alias takes a few min to switch). Railway deploys via `railway up` (manual), not git-CD.
- Commit narrowly (the working tree has the design session's untracked files; stage only your files).

## Work item 1 — Cold-load latency (the headline ask)
Server is fast; the latency is the **client bundle** (~8MB raw / ~2.6MB gz, all eager).
- DONE this session: `manualChunks` vendor split (`ui/vite.config.ts`, commit `2afa36cd`) — fixes per-deploy re-download (heavy chunks stay immutable-cached; only the ~545KB `index` chunk changes per deploy). `/assets/*` immutable cache headers shipped in `vercel.json` (commit `f96cccef`).
- TODO (the real cold-load fix): **lazy-load**.
  - `ui/src/App.tsx` statically imports ~50 pages into one eager `index` chunk (545KB gz). Convert page imports to `React.lazy` (named exports → `lazy(() => import("./pages/X").then(m => ({default: m.X})))`; consider a `lazyNamed` helper) + wrap `<Routes>` in `<Suspense fallback={...}>`.
  - Build warning pinpoints the other giant: `ui/src/components/MarkdownEditor.tsx` (pulls `editor` mdxeditor+lexical + `mermaid` ≈ 440KB gz) is **statically imported by 11 components** (AgentConfigForm, InlineEditor, IssueChatThread, IssueDocumentsSection, NewGoalDialog, NewIssueDialog, NewProjectDialog, AgentDetail, CompanySkills, RoutineDetail, Routines). Make those sites lazy so editor+mermaid leave the initial graph.
  - `mermaid` (332KB gz) is a TRANSITIVE dep (nothing imports it directly) — confirm what pulls it (likely mdxeditor) and ensure it only loads behind the editor.
  - Verify: `pnpm --filter @valadrien-os/ui build` (chunk map), then deploy to PREVIEW and browse-test key routes (Auth, Dashboard, IssueDetail, an editor/dialog) before `vercel promote`. Runtime-risky (a bad lazy boundary = blank route) and not catchable by build alone.

## Work item 2 — Sol's sandbox-home blocker (unblocks ALL engineering)
Ti Claude self-diagnosed this in DB task `7b336a40`. Sol's runs `adapter_failed: ENOENT mkdir '/home/sbx_user<uid>'` (e.g. `/home/sbx_user1051`). The runtime provisions a per-agent sandbox home under `/home`, which is root-owned and not writable by the `node` user the worker runs as. CEO is unaffected (its runs use `HOME=/valadrien-os`).
- Find where the per-agent sandbox home path is chosen (search `sbx_user`, sandbox-home, `/home`, the sandbox-providers in `packages/plugins/sandbox-providers/`, and the local/claude-local adapter execution). 
- Fix options: point the sandbox-home base at a writable path (the `/valadrien-os` volume), pre-create + chown the dir in `scripts/docker-entrypoint.sh`, or disable per-agent sandbox for `claude_local`. Pick the cleanest; it's a runtime/Docker-level fix (agents have no root).

## Work item 3 — CEO turn-completion / timeout (staged test, ready)
Post-infra-fix, CEO runs are STABLE but never finish a turn — they run the full timeout then SIGTERM (exit 143). A controlled test is staged:
- Agent Ti Claude `aa8911e3-d105-4a00-9761-9763e1138204`, company `e8a1e79f-2711-4dfc-a701-e4f9978c472b`.
- Config set: `adapter_config.timeoutSec=300`, `runtime_config.heartbeat.maxConcurrentRuns=1`, `intervalSec=600`. Budget caps `budget_monthly_cents=2000` ($20) on both agents.
- Clean terminating task `acf4bd1f` ("Board check-in: post status + close") is `todo`, assigned to Ti Claude. Other tasks are blocked/cancelled so the heartbeat skips them.
- Heartbeat is **OFF**. To run: set `runtime_config.heartbeat.enabled=true` (via `:5432`), watch `heartbeat_runs` + `heartbeat_run_events` for the agent, expect succeeded in <5 min; **always disable after**. If it still burns the 300s timeout, read the run's claude stdout to see why the turn doesn't exit (looping HEARTBEAT steps? waiting? maxTurns?).

## Verified facts (don't re-litigate)
- Single Railway replica (`numReplicas:1`). The `reapOrphanedRuns`/`executeRun` logic is sound — process_lost came from server restarts (fixed) or the earlier concurrency storm, not a reaper bug.
- Instructions ARE wired + working (CEO read its bundle, delegated to Sol, refused to hire). Bundles live on the volume at `/valadrien-os/instances/default/companies/{co}/agents/{id}/instructions/`; executor reads `adapter_config.instructionsFilePath` raw (heartbeat resolver does NOT recover from disk).
- ANTHROPIC_API_KEY credit topped up (was a transient blocker).

## Operating mode — External Auditor (recurring, runs on the Max subscription)
This session does double duty: (1) the hands-on engineering above, and (2) a recurring **independent auditor** of the live platform — a second pair of eyes from *outside* the OS. It runs in Claude Code Desktop on the Max subscription, so it does **NOT** bill the OS's `ANTHROPIC_API_KEY`. Sol monitors from inside the platform (and burns API budget doing it); this is the free, external watch that keeps an eye on things even if the internal loop is down.

**Schedule:** twice daily (e.g. ~9am + ~9pm ET) via the **`/schedule`** skill in Claude Code Desktop — it creates a cron routine that fires the audit prompt. **Read-only by default:** report findings, open issues/PRs for fixes, do NOT auto-mutate prod. Log each run's findings to a rolling report (a dated section in `docs/audit-log.md`, or a tracked issue) so trends are visible across runs.

### System health check — run every audit (all read-only; DB via `:5432`)
1. **Frontend:** `curl -sS os.valadrien.dev/` → 200; entry + every `/assets/*.js|css` chunk → 200 non-zero; `/api/health` → 200 (retry once — a lone 504 is a cold-start transient, two in a row is real).
2. **Vercel:** latest production deployment `READY` + its `githubCommitSha` (get_deployment). Flag if prod is **behind branch HEAD** (un-promoted work sitting in previews).
3. **DB:** both `:5432` and `:6543` answer `select 1`; `pg_stat_activity` total vs `max_connections` (alert >80%).
4. **Railway worker (`valadrien_staff`):** `railway logs` — count `Server listening` boots in last ~12h (>1 = crash loop, investigate); scan for `uncaughtException`/`EDBHANDLEREXITED`/`FATAL`/`504`.
5. **Heartbeat runs (last 12h):** counts by `status`/`error_code`; alert on spikes of `process_lost`/`timeout`/`adapter_failed`; any run stuck `running` past its `timeoutSec`; overall success rate (target: runs reach `succeeded`).
6. **Agents:** any with `status='error'` (e.g. Sol's sandbox blocker); stale `last_heartbeat_at`.
7. **Budget:** `spent_monthly_cents` vs `budget_monthly_cents` per agent (alert >80%).
8. **Auth/bootstrap:** `/api/health` `bootstrapStatus` + `googleAuthEnabled` sane; no auth/origin regressions after secret changes.

Output each run as: GREEN (all clear) / YELLOW (degraded, list it) / RED (incident, what + suspected cause + recommended action). Don't fix in the audit run unless it's a one-line safe revert; open work instead.

### Scheduled audit prompt (paste into `/schedule`, twice daily ~9am + ~9pm ET)
```
You are the EXTERNAL AUDITOR for ValAdrien OS — an independent health watch running on the
Max subscription, NOT the OS's ANTHROPIC_API_KEY. Repo: /Users/fernandadrien/Projects/valadrien-os
(branch rebrand/valadrien-os). STRICTLY READ-ONLY: never deploy, never write the DB, never
enable heartbeats, never run `pnpm dev`/Vite. Report only; open an issue for anything RED.

First read ENGINEERING-SESSION-BRIEF.md (repo root) for the full checklist, access patterns,
and constraints. Run the checks in two tiers:

TIER 1 — public, no credentials (always run):
- GET https://os.valadrien.dev/ -> 200; extract every /assets/*.{js,css} and confirm each -> 200, non-zero bytes.
- GET https://os.valadrien.dev/api/health -> 200 (retry once: a single 504 is a cold-start transient;
  two in a row is RED). Capture bootstrapStatus + googleAuthEnabled.

TIER 2 — needs local creds/CLIs (run if present, else record "skipped: no <cred>"):
- DB via the :5432 session pooler (NOT :6543): URL =
  RAILWAY_TOKEN=$(cat ~/.config/valadrien/railway-token) railway variables --service valadrien_staff --json
  -> DATABASE_MIGRATION_URL. Then psql (read-only SELECTs only):
    * pg_stat_activity total vs max_connections (>80% = YELLOW).
    * heartbeat_runs last 12h: counts by status,error_code; any stuck status='running' past its
      timeoutSec; overall success rate. Spikes of process_lost / timeout / adapter_failed = YELLOW (RED if no successes).
    * agents (company e8a1e79f-2711-4dfc-a701-e4f9978c472b): any status='error'; stale last_heartbeat_at;
      spent_monthly_cents vs budget_monthly_cents (>80% = YELLOW).
- Railway worker: RAILWAY_TOKEN=... railway logs -s valadrien_staff (bounded: `> /tmp/a & LP=$!; sleep 18; kill $LP`).
  Count `Server listening` boots in the window (>1 per 12h = crash loop = RED); scan uncaughtException / EDBHANDLEREXITED / FATAL.
- Vercel: latest PRODUCTION deployment READY + its githubCommitSha; flag if prod is BEHIND
  origin/rebrand/valadrien-os HEAD (un-promoted work sitting in previews).

Then append a dated entry to docs/audit-log.md:
  ## YYYY-MM-DD HH:MM ET — <GREEN | YELLOW | RED>
  - one line per check: status + key numbers
  - for YELLOW/RED: what broke + suspected cause + recommended action
If RED: also open a GitHub issue (`gh issue create`) titled "[audit] <summary>" with the details.
Do NOT fix issues yourself unless it is a one-line, obviously-safe revert. Keep the run tight — it is unattended.
```

### Engineering skills the auditor/eng session should use
Routing lives in repo `CLAUDE.md` → "## Skill routing (engineering oversight)" (auto-applied every session).
Real installed skills: **/plan-eng-review, /code-review, /review, /simplify, /investigate, /codex, /qa,
/qa-only, /design-review, /ship, /land-and-deploy, /document-release, /document-generate, /health, /retro, /cso**.
Mappings from Fernand's list: `/debug`→/investigate, `/documentation`→/document-release+/document-generate,
`/architecture` + `/system-design`→/plan-eng-review, `/deploy-checklist`→/ship+/land-and-deploy,
`/incident-response`→/investigate(+/cso), `/tech-debt`→/health+/simplify+/review, `/testing-strategy`→/qa.
TODO (portable reuse): author an `eng-overseer` plugin = a `.claude/agents/eng-overseer.md` subagent +
thin first-class skills for the 6 composite concepts, so the whole overlay drops onto other tenants.

