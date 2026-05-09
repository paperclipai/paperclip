# Qwen Local Adapter Phase 1: CLI Wrapping Strategy

**Date:** 2026-05-09 14:45
**Severity:** Medium
**Component:** adapters/qwen-local, runtime registry, agent execution
**Status:** Resolved (Phase 1 complete; Phase 2 backlog)

## What Shipped

11 core files landed across two worktrees:
- `packages/adapters/qwen-local/`: runtime-config, parse, execute, models, test, ui/build-config
- Server registry wiring: adapters/registry.ts, builtin-adapter-types.ts, workspace deps
- 26 tests (24 offline unit + 2 gated remote)
- Docs: qwen-local.md operator guide, cross-reference updates (agents-runtime.md, architecture.md, managing-agents.md)

Qwen3.6-35B-A3B-FP8 now routable via OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL env vars. vLLM inference path: Tailscale encrypted tunnel, soft-auth via "sk-9999" API key (hard boundary is tailnet ACL).

## The Brutal Truth

No end-to-end verification. Server runtime never spun up to actually hit `/api/adapters` and confirm qwen_local appears in the registry. Only typecheck validated wiring. Parser tolerates unknown stream-json events because we never captured a real qwen-code fixture. This is a ticking clock—if vLLM's stdout format drifts, we find out in production.

The environment-only API key strategy avoids `/proc` leakage, but it means no way to override per-session without killing the agent process. Session resume scaffolding is pass-through; real heartbeat recovery is Phase 2.5.

## Key Decisions

**Why wrap CLI vs native loop:**
Qwen's official @qwen-code v0.15.9 CLI is stable. Wrapping it trades per-turn subprocess overhead for zero maintenance of inference orchestration. If profiling reveals this is the bottleneck (unlikely—network latency dominates), Phase 2 pivots to native. Ship first, optimize second.

**Why env-only API key:**
Prevents secret from leaking into `ps aux`, /proc/*/cmdline, or audit logs. No socket-level replay attack surface. Matches security posture of other env-driven adapters.

**Why no version pin in registry's getRuntimeCommandSpec:**
Matches opencode-local pattern. Pinning would require upstream change to buildNpmRuntimeCommandSpec—out of Phase 1 scope. @qwen-code drift is a Phase 2 concern.

**Why listModels not in registry:**
Registry's listModels() takes no args; listQwenModels needs per-agent {baseUrl, apiKey}. Static models[] covers v0.1. Per-agent dashboard refresh is future. No blocker—agents infer model from execution responses.

## Gaps Not Closed

- No CI smoke test on live execute() (needs CLI provisioned; remote tests exercise HTTP layer only)
- Session codec is scaffold only
- Skill symlink sync deferred (requiresMaterializedRuntimeSkills: false)

## Next Steps

1. **Immediate:** Spin up server, curl /api/adapters, verify qwen_local entry
2. **Before dogfood:** Capture real qwen-code stream-json, harden parser fixtures
3. **Phase 2:** Measure concurrency ceiling at 20–60 in-flight runs; profile subprocess overhead
4. **Phase 2.5:** Session resume, per-agent model list refresh

**Unresolved:** Does @qwen-code v0.15.9 promise stream-json stability across minor versions? If not, vendor the event schema or pin tighter.
