# mem0-shim 7777 Cutover Plan

Date: 2026-05-05
Issue: KTA-1447

## Decision

Use option B: make `mem0-shim` the only memory service on `127.0.0.1:7777` and decommission Rasputin / `hybrid-brain` on that port.

Reasoning:

- Existing agent instructions already treat `:7777` as the default memory endpoint in many rendered prompts and onboarding assets.
- KTA-1189 intended `:7778` to be the synthetic smoke port before the final `:7777` takeover.
- Updating every rendered agent instruction to `:7778` would leave old prompt caches and externally copied instructions stale. Moving the backend behind `:7777` fixes the wider routing layer.

## Current State Verified

- `http://127.0.0.1:7777/health` returns `engine: hybrid-brain`, version `0.8.0`.
- `http://127.0.0.1:7778/health` returns `engine: mem0-shim`.
- mem0-shim currently runs under a `screen` process named like `mem0-shim-7778`.
- `/Volumes/SSD/projects/Peper/mem0-shim/start-mem0.sh` defaults to `PORT=7778` and currently uses `nohup` for startup.
- The local Rasputin startup script starts `tools/hybrid_brain.py` on `:7777`.
- `server/src/onboarding-assets/default/AGENTS.md` and `server/src/onboarding-assets/ceo/AGENTS.md` still default `MEM0_SHIM_URL` to `http://127.0.0.1:7777`.

## Target State

- `127.0.0.1:7777/health` returns `engine: mem0-shim`.
- Rasputin / `hybrid-brain` is not listening on `:7777`.
- mem0-shim is supervised, not a bare `nohup` process.
- `:7778` may remain as a temporary smoke endpoint only during the cutover window; after verification, no agent instructions should depend on it.
- Onboarding assets continue to point at `:7777`, now backed by mem0-shim.

## Migration Sequence

1. Record the pre-cutover state:
   - `curl -sS --max-time 2 http://127.0.0.1:7777/health`
   - `curl -sS --max-time 2 http://127.0.0.1:7778/health`
   - `ps -axo pid,ppid,command | rg 'mem0|hybrid_brain|7777|7778|Rasputin'`
   - `sqlite3 /Volumes/SSD/projects/Peper/mem0-shim/history.db "SELECT actor_id, COUNT(*) FROM history WHERE created_at > datetime('now','-1 day') GROUP BY actor_id ORDER BY 2 DESC;"`
2. Stop the Rasputin `hybrid_brain.py` process that owns `:7777`.
3. Start mem0-shim on `:7777` under a supervised process. Prefer the same local supervisor pattern already used for `mem0-shim-7778` (`screen -dmS mem0-shim-7777 ...`) unless Paperclip has a stronger local service supervisor available.
4. Update `/Volumes/SSD/projects/Peper/mem0-shim/start-mem0.sh` so the default port is `7777` and startup uses the chosen supervised process rather than bare `nohup` for mem0-shim. Keep Qdrant/Ollama handling compatible with the existing script.
5. Update `/Volumes/SSD/projects/Peper/mem0-shim/README.md` to describe `127.0.0.1:7777` as the default endpoint and `7778` as optional smoke/override only.
6. Leave `server/src/onboarding-assets/default/AGENTS.md` and `server/src/onboarding-assets/ceo/AGENTS.md` defaulting to `:7777`; only change wording if needed to remove stale "Rasputin" language. Do not flip them to `:7778`.
7. Disable or rename the Rasputin startup entry point so routine operator startup does not reclaim `:7777`. If editing the local startup script, make the change minimal: do not delete Qdrant/Ollama startup if other local memory services share them.
8. Smoke test:
   - `curl -sS --max-time 2 http://127.0.0.1:7777/health | jq -r '.engine'` returns `mem0-shim`.
   - Commit a verification memory with a synthetic UUID using `agent_id`.
   - Confirm the synthetic UUID appears in `history.actor_id`.
9. Observe real traffic:
   - Run the acceptance query after several real agent heartbeats:
     `sqlite3 /Volumes/SSD/projects/Peper/mem0-shim/history.db "SELECT actor_id, COUNT(*) FROM history WHERE created_at > datetime('now','-1 day') GROUP BY actor_id ORDER BY 2 DESC;"`
   - Acceptance requires at least 5 distinct real agent UUIDs, excluding synthetic verification commits.

## Rollback

Rollback is only acceptable if mem0-shim fails health or commit attribution on `:7777`.

1. Stop the mem0-shim `:7777` supervisor.
2. Restart Rasputin using the previous command from the local startup script.
3. Keep mem0-shim alive on `:7778` for diagnosis.
4. Comment on KTA-1447 with the failing health response, process list, and last mem0-shim log lines.

Do not run both Rasputin and mem0-shim on `:7777`; the whole failure mode is ambiguous ownership of the canonical memory port.
