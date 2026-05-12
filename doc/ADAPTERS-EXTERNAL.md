# Wiring Agent Runtimes Into Paperclip

Paperclip is the **control plane** — the org chart, task board, budgets, audit
log. Agent *runtimes* run elsewhere and connect to Paperclip through adapters.
This doc covers the four runtimes you have in scope today:

| Runtime | Where it lives | Adapter type | How it connects |
|---|---|---|---|
| OpenClaw-HQ | Render (`Awhitter/openclaw-hq`) | `openclaw_gateway` (built-in) | WebSocket → Render service |
| Hermes Agent | host with `pip install hermes-agent` | `hermes_local` (built-in) | Subprocess spawn |
| unohee/OpenSwarm | host with `npm i -g @intrect/openswarm` | `openswarm_local` flavor `unohee` (built-in) | Subprocess spawn |
| VRSEN/OpenSwarm | host with `npm i -g @vrsen/openswarm` | `openswarm_local` flavor `vrsen` (built-in) | Subprocess spawn |

You configure adapters from the UI: **Settings → Adapter Manager** at
`/instance/settings/adapters`, and you hire agents from **Companies → Hire
Agent**. No source-tree edits required for any of them.

All four are available out of the box on this branch. You only have to install
the corresponding agent CLI/package on the host where Paperclip is running
(or on a remote target you point Paperclip at via SSH execution targets).

---

## 1. OpenClaw-HQ — built-in WebSocket gateway

`@paperclipai/adapter-openclaw-gateway` is built into core and speaks the
OpenClaw WebSocket gateway protocol. The OpenClaw-HQ Render service already
serves that protocol, so this is the cleanest of the four.

**Setup:**

1. **Companies → Hire Agent** → adapter type `openclaw_gateway`.
2. Fill in:
   - **URL**: the `wss://…` URL of your OpenClaw-HQ Render service
     (e.g. `wss://openclaw-hq.onrender.com/gateway`).
   - **Auth token**: matches `OPENCLAW_GATEWAY_TOKEN` on the OpenClaw-HQ side.
     If your HQ instance uses shared-password auth instead, paste the password
     into the `password` field.
   - Optional: pin a `devicePrivateKeyPem` so re-pairing isn't needed across
     restarts.
3. Save. Paperclip wakes OpenClaw-HQ on heartbeat.

**Session strategies** (`sessionKeyStrategy`):

- `issue` — one OpenClaw session per issue (per-issue memory)
- `fixed` — one shared session for the agent
- `run` — fresh session every heartbeat (no carry-over)

Full protocol reference: [`packages/adapters/openclaw-gateway/README.md`](../packages/adapters/openclaw-gateway/README.md).

The HQ service also has a nightly cron that pulls upstream `openclaw/openclaw`,
so the runtime side stays current without anyone touching it.

---

## 2. Hermes Agent — built-in subprocess

`hermes_local` ships in core as a built-in adapter (registered via the
`hermes-paperclip-adapter` dependency). The adapter spawns the `hermes` CLI
on the host.

**Prerequisites on the Paperclip host:**

```sh
pip install hermes-agent
# at least one provider API key, e.g. ANTHROPIC_API_KEY=...
```

**Hire an agent in Paperclip:**

1. **Companies → Hire Agent** → adapter type `hermes_local`.
2. Set:
   - `provider` (e.g. `anthropic`, `openrouter`)
   - `model` (e.g. `anthropic/claude-sonnet-4-5`)
   - `memoryScope`: `session` | `persistent` | `ephemeral`
   - `resumeStrategy`: `smart` (default), `always`, or `never`

**Render note:** the Render container does not have `hermes` pre-installed.
For v1, run Hermes-backed agents on a host you control (laptop, dedicated
VM, Fly machine) and let Paperclip-on-Render orchestrate via heartbeat
through that host's Paperclip API key. Or build a custom Dockerfile that
adds `python3 -m pip install hermes-agent` and rebuild.

**Optional upgrade — external plugin:** the npm package
`@henkey/hermes-paperclip-adapter` is a pin-newer version of the Hermes
adapter that overrides the built-in when installed via Adapter Manager.
Use that path if you want HenkDz's two-tier idle/max timeouts and
smart-resume behavior without waiting for an upstream Paperclip release.

---

## 3. unohee/OpenSwarm — built-in subprocess (flavor `unohee`)

[unohee/OpenSwarm](https://github.com/unohee/OpenSwarm) (`@intrect/openswarm`)
is an autonomous Linear+Discord-driven orchestrator with a Worker/Reviewer
pipeline. The `openswarm_local` adapter wakes one `openswarm exec` subprocess
per heartbeat.

**Prerequisites on the Paperclip host:**

```sh
npm install -g @intrect/openswarm
# Provider auth — at least one of:
export ANTHROPIC_API_KEY=...    # default Worker/Reviewer model
export OPENAI_API_KEY=...       # if using GPT-* / Codex
# Optional, for unohee's own daemon-mode features:
export LINEAR_API_KEY=...
export DISCORD_TOKEN=...
```

**Hire an agent in Paperclip:**

1. **Companies → Hire Agent** → adapter type `openswarm_local`.
2. Set:
   - `flavor`: `unohee` (default)
   - `cwd`: working directory the agent should operate inside
   - `pipeline`: `true` (default) → adds `--pipeline` so the
     Worker/Reviewer/Tester/Documenter chain runs
   - `localOnly`: `true` (default) → adds `--local` so we don't depend on
     unohee's daemon being up
   - `timeoutSec`: 1800 (default) — bump for long planning runs
   - `env`: provider keys you don't want sourced from the host shell
3. Save. Paperclip will spawn:

   ```
   openswarm exec "<rendered-paperclip-wake-prompt>" -p <cwd> --local --pipeline
   ```

   on heartbeat, stream stdout/stderr into the run transcript, and surface
   exit code + final stdout as the run result.

**Caveats:**

- The adapter does not yet ingest unohee's per-token cost (which lives in its
  own better-sqlite3 + LanceDB store). Paperclip budget enforcement on this
  adapter is best-effort.
- No session resume across heartbeats — each wake is a fresh `openswarm exec`.
  unohee's full daemon mode (`openswarm start` with `config.yaml`) is still
  the right path if you want continuous Linear+Discord control of the same
  agents; co-running them is fine.

---

## 4. VRSEN/OpenSwarm — built-in subprocess (flavor `vrsen`)

[VRSEN/openswarm](https://github.com/VRSEN/openswarm) (`@vrsen/openswarm`)
is a different project with the same name — 8 specialist agents
(Orchestrator, VA, Deep Research, Data Analyst, Slides, Docs, Image Gen,
Video Gen) on Agency Swarm, designed for one-prompt-to-deliverable runs.

The same `openswarm_local` adapter handles it via the `flavor: "vrsen"`
config switch.

**Prerequisites on the Paperclip host:**

```sh
# unohee and VRSEN both install a binary named `openswarm`, so pick one
# per host (or set adapterConfig.command to an absolute path):
npm install -g @vrsen/openswarm
# Provider auth: VRSEN's setup wizard handles most of this interactively the
# first time it runs. For headless deployment, export the same provider
# keys and any Composio token you've configured.
```

**Hire an agent in Paperclip:**

1. **Companies → Hire Agent** → adapter type `openswarm_local`.
2. Set:
   - `flavor`: `vrsen`
   - `cwd`: working directory
   - `timeoutSec`: 3600 — VRSEN deliverables (slide decks, video gen) can
     run for tens of minutes
3. Save. Paperclip will spawn:

   ```
   openswarm "<rendered-paperclip-wake-prompt>"
   ```

   on heartbeat (single positional argument; VRSEN's CLI shape).

**Caveats:**

- VRSEN expects an OpenAI key by default and tries to authenticate
  interactively; for Paperclip wakes you'll want to have run the setup
  wizard once on that host so creds are persisted.
- Same cost-ingestion caveat as unohee: VRSEN tracks usage in its own
  state, not in Paperclip.

---

## Heartbeat model recap

```
Paperclip (control plane)
  └─ heartbeat scheduler ticks
      └─ for each agent assigned to an active issue
          └─ adapter.execute(...) wakes the runtime:
              ├─ openclaw_gateway   → wss:// to OpenClaw-HQ on Render
              ├─ hermes_local       → spawn `hermes chat -q` on host
              ├─ openswarm_local    → spawn `openswarm exec` (unohee)
              │                       or `openswarm "<prompt>"` (vrsen)
              ├─ process            → spawn arbitrary command
              └─ http               → POST to your endpoint
```

Paperclip never holds the LLM keys for OpenClaw, Hermes, or OpenSwarm;
those live with the runtime. Paperclip only needs:

- the gateway URL + token (OpenClaw)
- the host with the CLI installed (Hermes / OpenSwarm)
- per-agent adapter config in the UI (no source-tree edits needed)

---

## Mental map of how this all connects on Render

```
┌───────────────────────────────────────────┐
│  Paperclip on Render (this repo)          │
│  - control plane API + UI                 │
│  - Postgres (managed add-on)              │
│  - heartbeat scheduler                    │
│  - Langfuse tracing (fork-curated)        │
└─────┬──────────┬───────────┬──────────────┘
      │ wss      │ subproc   │ subproc
      ▼          ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────────┐
│OpenClaw- │ │ Hermes   │ │ OpenSwarm    │
│HQ on     │ │ on host  │ │ (unohee or   │
│Render    │ │ (npm/pip)│ │  VRSEN)      │
│          │ │          │ │ on host      │
│  uses    │ │  uses    │ │  uses LLM    │
│  /data/  │ │  ANTHRO- │ │  provider of │
│  works-  │ │  PIC_KEY │ │  your choice │
│  pace    │ │          │ │              │
└──────────┘ └──────────┘ └──────────────┘
```

Hermes and OpenSwarm need a host where the CLI is installed. The Render
container will work for OpenClaw-only scenarios. For Hermes / OpenSwarm,
extend the Dockerfile or run those adapters from a self-hosted Paperclip
runner that talks back to the Render-hosted control plane.
