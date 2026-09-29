# Live workforce overview

Authenticated, company-scoped board view at `/:company/activity/workforce`.
The sidebar link is **Workforce**.

The page is read-only. Loading it, polling it, and pressing Refresh call:

`GET /api/companies/:companyId/workforce-overview`

An optional `initiative` query (issue id or identifier such as `TYR-721`) selects the handoff timeline. With no query, the server and the page use the same parent: the most recently updated issue that has child tasks, including a completed parent. The initiative control value is that issue's public identifier. None of those requests check out a task, resume an agent, reassign work, or start a run.

Work counts use the same execution-issue filter as the dashboard. Hidden issues, harness issues, and persistent conversation containers are omitted. A dependent task is waiting eligible only when every blocker is done. A cancelled blocker, or a blocker missing from the snapshot, stays unresolved.

Switching company starts a new read. The page does not keep the previous company's snapshot while that read is in flight. A failed refresh for the same company still keeps the last successful snapshot for that company.

## What it shows

- Overview counts: active projects, executing agents, waiting eligible tasks, blocked tasks, pending reviews, Marc decisions, recently accepted tasks, paused agents, and a labeled security count.
- Project cards: owner, stage, current task and assignee, last accepted output, next action, blockers, and links. There is no progress percentage.
- Agent cards: role, reporting chain (an ancestor titled or named XO is marked), adapter, model, and host when those values are stored, current task, latest run, last activity, and pause, wait, or failure reasons.
- Handoff timeline for the selected initiative, built only from `activity_log` rows on that issue tree. A row with no run id and no agent or user actor is labeled **Unknown provenance**.
- Deliverables. Same-origin paths, including `/api/...` attachment content paths, are authenticated links. External `https` URLs are labeled external. A deliverable with no stored path says **No authenticated link recorded**.
- Blockers and decisions, each with a release condition when one is stored. Security items keep a **Security** label.

Paused agents are excluded from the executing count. A paused agent with an in-progress task or a still-open run is shown as **Paused**, not as executing. That includes an agent such as Vulcan while it remains paused.

Marc decisions are pending board approvals, plus in-review tasks owned by a company member whose name is Marc. If no member is named Marc, the Marc count stays 0 and those approvals stay labeled as board decisions.

Timestamps use `Asia/Dubai`.

## Live data

While the browser tab is visible, the page refetches the same GET every 12 seconds and also refetches on company live events, coalesced to at most one extra refetch every 2 seconds. A hidden tab does not poll.

If the refresh fails, or the last success is older than 30 seconds, the page keeps the last snapshot and marks the connection disconnected or stale. It does not replace that snapshot with zeros.

A successful response from an empty company can show real zeros. A disconnected page with no snapshot says the counts are unavailable.

## Limits

One response reads at most 1,000 tasks, 400 activity rows, 300 runs, and 200 work products. The timeline shows at most 80 activity rows for the selected initiative. When a cap is hit, the page says the snapshot is partial.

Model and host are shown only when stored on the agent (`model`, `modelName`, or `defaultModel`, plus a hostname or the agent's environment name). Missing values say **Not recorded**. Adapter config values that look like secrets are dropped.

## Production

This change adds a server route and a UI page. A production process keeps serving the build it started with until that process is restarted with the new build.

Do not deploy this branch to `paperclip.tyr-x.com`. Do not restart production containers, and do not change DNS, Tailscale, Hermes, credentials, model routes, concurrency, Vulcan's pause state, or Studio. Preview it locally with `pnpm dev` (API and UI on port 3100) and open `/{prefix}/activity/workforce`.
