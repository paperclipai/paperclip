# Architecture — koenig-ai-org

## Bird's eye

```
                   ┌─────────────────────────────────────────────────┐
                   │              Local Mac (24/7 host)               │
                   │                                                 │
  ┌──────────┐    │   ┌─────────────────────────────────────────┐  │
  │ Vardaan  │◄──►│   │ Paperclip (npx paperclipai or pnpm dev) │  │
  │          │    │   │ ~/.paperclip embedded Postgres + state  │  │
  │ - paperc │    │   └────────┬────────────────────────────────┘  │
  │   lip UI │    │            │ adapter calls                      │
  │ - email  │    │   ┌────────▼────────────────────────────────┐  │
  │ - cli    │    │   │ This repo (koenig-ai-org)               │  │
  │ - obsi   │    │   │  vault/        companies/                │  │
  │   dian   │    │   │  adapters/     shared-skills/            │  │
  └──────────┘    │   │  watchdog/     observability/            │  │
                   │   └────────┬────────────────────────────────┘  │
                   │            │                                    │
                   │   ┌────────▼────────────────────────────────┐  │
                   │   │ CLI agents wired as adapters            │  │
                   │   │  claude · codex · gemini · opencode     │  │
                   │   │  aider · browser-use                    │  │
                   │   └────────┬────────────────────────────────┘  │
                   │            │                                    │
                   │   ┌────────▼────────────────────────────────┐  │
                   │   │ Watchdog (loop + USD circuit breaker)   │  │
                   │   │ Langfuse (traces + evals)               │  │
                   │   └─────────────────────────────────────────┘  │
                   └────────────────────┬─────────────────────────────┘
                                        │ HTTPS
                       ┌────────────────▼─────────────────────────┐
                       │ Koenig AI Academy                        │
                       │ academy.kspl.tech (Vercel)               │
                       │   learnovaBeast (academy/main branch)    │
                       │   NEW Convex deployment                  │
                       │   NEW Cloudflare R2 bucket               │
                       │   No WorkOS — anonymous + opt-in OTP     │
                       │   Convex /agents/* HTTP action            │
                       │     bearer-auth + Zod validation         │
                       └──────────────────────────────────────────┘
```

## How a content task flows

1. **Trigger** — daily cron (06:00 IST) OR Vardaan's instruction inbox (Paperclip / email / Slack / CLI)
2. **Research** — 4 vendor researchers run in parallel; each writes `vault/research/<vendor>/<date>.md`
3. **Synthesize** — Research Editor merges into `vault/research/_daily/<date>.md`
4. **Plan** — CEO reads daily, creates Paperclip tickets ("update Module 3 of Course X" / "launch new course Y" / "blog: launch announcement")
5. **Author** — Content Author writes a draft to `vault/courses/<slug>/draft.md`
6. **G0 Review** — Content Reviewer reads + factchecks against research sources; ✅ or ✏️
7. **Author iterates** until ✅
8. **Publish-prep** — Slide/Audio Producer drives Open-Notebook / `notebooklm-py` for slide+podcast (uploaded to R2)
9. **G1 Engineering** (only for code touchups in learnovaBeast)
10. **G2 QA** — browser-use walkthrough, test suite, content fact-check
11. **G3 CEO** — alignment + budget check
12. **G4 Human** — Vardaan approves via email / Slack / Paperclip UI
13. **Publish** — `learnova-publish` adapter calls Convex `agentApi.ts` HTTP action with bearer; the action validates Zod schema and writes via `internalMutation`
14. **Audit** — every step logs to `vault/decisions/` + Convex `agentRuns` + Langfuse trace

## Where agent state lives

| Layer | Where | Purpose | Lifetime |
|---|---|---|---|
| Token-context (per heartbeat) | Claude/Codex CLI | Model's working memory in one cycle | One heartbeat |
| Session state | `~/.paperclip` `agentTaskSessions` | Resume context next heartbeat | Until task done |
| Long-term agent memory | Convex vector index over `vault/` | RAG over research + course history | Persistent |
| Narrative memory | `vault/` markdown | Human + AI readable history | Persistent |
| Identity | `companies/.../agents/<role>/SOUL.md` + `skills/` | Who the agent is and how it behaves | Versioned |

## Failure modes & guards

| Mode | Guard |
|---|---|
| Cost runaway (Paperclip Issue #339) | Watchdog per-task USD cap + 80%/100% monthly auto-pause |
| Loop / no-progress (Issue #390) | Watchdog 5-consecutive-no-delta heuristic |
| Hallucinated completion | Content Reviewer (G0) + QA browser walkthrough (G2) |
| Stale facts | Researcher includes source URLs; Reviewer cross-checks |
| Convex schema drift | All writes go through Zod-validated `agentApi.ts` → `internalMutation` |
| SpamBrain (Google) | G0 + G4 satisfy "augmented content" criterion |
| Mac sleep | `caffeinate` launchd plist |
| `notebooklm-py` breaks | `open-notebook` adapter as drop-in fallback |
