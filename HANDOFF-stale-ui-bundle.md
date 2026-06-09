# Handoff → runtime session: production serving a STALE UI bundle (frozen pre-spine)

**From:** design/UI session · **Date:** 2026-06-09 · **Priority:** HIGH — shipped UI changes are committed + READY but not reaching the live edge. Deploy/build-infra issue, not design code.

## TL;DR
`os.valadrien.dev` is serving a **stale UI bundle** — `assets/index-D_1T8KIB.js` — that **hasn't changed in ~14+ minutes** across **three READY production deploys** (`480d7013`, `b4204932`, `e66e9416`). The bundle is frozen at the **pre-`480d7013`** state, so the most recent UI change (the Agents-roster heartbeat-spine) renders nowhere live even though it's in the source of the commit currently aliased to production. Earlier UI changes this session DID go live (Costs, the amber toggle, the 18-page wave, the bigger agent-face), then the bundle froze. Looks like a **Vercel build-cache restoring a stale `ui/dist`** instead of rebuilding it.

## Evidence
- **Source is correct + live-aliased:** `git show e66e9416:ui/src/pages/Agents.tsx | grep HeartbeatSpine` → 2 hits. `e66e9416` is READY and `get_deployment os.valadrien.dev` lists `os.valadrien.dev` in its alias. Builds clean locally (`tsc -b --force` + `vite`).
- **Edge is stale:** `curl -s https://os.valadrien.dev/ | grep index-*.js` → `index-D_1T8KIB.js`, unchanged across two polls (8 min + 6 min, ~14 min total, 38 samples).
- **DOM proof:** on `/VAL/agents/all`, the agent-row leading slot renders a bare `.agent-face` with **0 `.heartbeat-spine`** elements (`document.querySelectorAll('.heartbeat-spine').length === 0`) — that's the code from before `480d7013`.
- **Timeline:** UI bundle updated fine through ~`21ffa991` (Costs embellishment verified live) and `4f07799d` (bigger agent-face verified live), then froze at the pre-spine bundle.

## Affected commits (all READY, none reaching the edge)
- `480d7013` — design: heartbeat-spine on the Agents roster (the UI change that isn't live)
- `b4204932` — docs handoff (no UI change; same UI bundle as 480d7013)
- `e66e9416` — runtime: auto-unblock dependents (server-only; should inherit 480d7013's UI bundle)

## Likely cause + fix (runtime/deploy lane)
The Vercel build is **restoring a cached `ui/dist`** (or otherwise not rebuilding the client) so every deploy ships the same stale bundle. Fix is a **clean rebuild with build cache cleared**:
- Vercel dashboard → the project → Deployments → **Redeploy** the latest, **uncheck "Use existing build cache."** OR
- Set/confirm the build doesn't cache `ui/dist` across commits (check the monorepo build command / Turbo cache key includes `ui/src/**`). OR
- A trivial UI-touching push that busts whatever cache key is stuck.

After the rebuild, the production bundle hash should change away from `index-D_1T8KIB.js`.

## What's NOT the problem
- Not the design code — it's committed, builds clean, and is in the live commit's source.
- Not a render bug — the bundle literally doesn't contain the roster spine.
- Per my lane I don't promote/manage deploys or clear the Vercel cache, so this is yours to action.

## Verify after the fix
1. `curl -s https://os.valadrien.dev/ | grep -oE 'index-[^"]+\.js'` → hash changes from `D_1T8KIB`.
2. On `/VAL/agents/all`: `document.querySelectorAll('.heartbeat-spine').length` → equals the agent count (2 for ValAdrien.DEV), each with `data-state` running/blocked/done/idle.

Ping me once the bundle rebuilds and I'll confirm the spine (and re-check the rest of the roster) live.

— design/UI session
