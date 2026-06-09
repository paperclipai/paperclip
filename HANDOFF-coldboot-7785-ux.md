# Handoff → runtime session: #7785 cold-boot hang — frontend/UX impact + design-QA observations

**From:** design/UI session · **Date:** 2026-06-09 · **Priority:** HIGH (UX) — this is the #1 thing making the app *look* unfinished, even though the UI work is done.

## TL;DR
While doing a full live design-review of the GLASSHOUSE redesign on `os.valadrien.dev` (authed as `cofounder@valadrien.dev`), the cold-boot hang (#7785) was by far the biggest problem I hit. **The owner's entire "this page isn't done" punch list was substantially this bug**, not missing design: pages caught mid-cold-boot render skeletons (or bounce to `/auth`), so a redesigned page looks blank/unfinished. Once the serverless instance is warm, every page renders the new UI correctly. **Fixing #7785 will resolve the perceived "unfinished" state across the whole app** — there's nothing left for the design lane to fix here.

You already have the root cause + fix (your audits below). This handoff adds the **frontend symptom map** + two **front-end mitigation asks** that are in the runtime/full-stack lane.

## What I observed (frontend symptoms, live)
1. **Splash hang 10s–300s on cold first-load of any route.** The SPA sits on the `LOADING…` splash; `document.body.innerText` stays `"LOADING…"` until the bootstrap resolves. Warm reloads clear in ~2–4s; cold ones can hang past 60s.
2. **Direct full-reload to a non-dashboard route hangs worse than the dashboard.** `goto /VAL/issues` (hard load) sat on the splash 7s+ repeatedly while `goto /VAL/dashboard` sometimes resolved — i.e. the hang isn't uniform per route; it tracks whatever the cold bootstrap is blocked on.
3. **The authed shell bounces to `/auth` mid-load.** Observed directly: `location.pathname` flipped to `/auth` ~150s into waiting for an agent page, with a valid session cookie present. This matches your "blocks on pending get-session and can bounce to /auth" note — it reads to the user as *"I got logged out"*, which is the worst version of this.
4. **Data-heavy pages render skeletons 30s+ even after the shell loads.** `AgentDetail` (`/VAL/agents/:id/dashboard`) — which fans out agent + runs + costs queries — stayed on skeleton placeholders for 30s+ on a coldish path; it only rendered for me after a fresh cookie + a warm instance (then ~3s).
5. **Warm path is genuinely fast.** Client-side nav between pages once warm is ~300ms–3s. Confirms this is cold-boot/bootstrap specific, not a per-page frontend cost.

## Cross-reference to your audits (same bug)
- `cf26c532` (docs/audit-log.md): 2nd run — cold-boot hang RED, 7/10 `/api/health` probes >10s, one 504@300s, authed shell blocks on pending `get-session`. Maps to login/logout/tab-nav lag.
- Your cold-init pinpoint commit: culprit = **`@zed-industries/codex-acp` (~165MB) evaluated at module scope every cold boot** via the eager adapter registry (`server/src/index.ts:28` → `app.ts:42` → `routes/adapters.ts:32` → `registry.ts:19` → `execute.ts:44`). Fix: **lazy-load the adapter execute imports.** That's the root-cause fix and the highest-leverage one.

## Front-end mitigation asks (runtime / full-stack lane — flagging, not mine to change)
Even after the codex-acp lazy-load lands, these two would make cold boots degrade gracefully instead of looking broken:

1. **Don't bounce to `/auth` while `get-session` is in-flight.** The redirect-to-login should fire only on a *definitive* 401, never on a pending/slow/timed-out `get-session`. While the session check is outstanding, hold the authed shell with a brief "reconnecting…" state. A bounce-to-login on a valid session is the single worst UX symptom of #7785.
2. **Bound per-route data queries with a timeout + "slow / retry" affordance.** Pages like `AgentDetail` sit on an indefinite skeleton when their queries hang. A timeout that swaps the skeleton for a "still loading — the server is waking up, retry" state (or an auto-retry) would stop redesigned pages from looking blank/unfinished during a cold boot.

## Design side — status (so you know nothing is blocked on me)
All GLASSHOUSE redesign work is shipped, deployed (`os.valadrien.dev`, prod), and verified live **once warm**: Dashboard (bigger animated agent-face), Inbox, Issues, Routines, Goals, Workspaces, Org, Skills, Costs (embellished), Activity, Settings (toggle now amber), IssueDetail, ProjectDetail, AgentDetail (living portrait header). Zero design defects open. The perceived-incomplete state is entirely #7785.

— design/UI session
