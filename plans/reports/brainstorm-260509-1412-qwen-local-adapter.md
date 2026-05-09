# Brainstorm — `qwen-local` Adapter for Paperclip

**Date:** 2026-05-09
**Branch:** master
**Scope:** Integrate self-hosted Qwen3 MoE (`Qwen/Qwen3.6-35B-A3B-FP8`) on a DGX, served via vLLM, as a first-class paperclip adapter.
**Status:** Design agreed pending user sign-off on Phase split.

---

## 1. Problem Statement

Paperclip orchestrates AI agents through **adapter packages** (`packages/adapters/*`), each wrapping an agent CLI (claude-local, codex-local, opencode-local, …). User runs `Qwen/Qwen3.6-35B-A3B-FP8` on a private DGX node behind Tailscale, served by vLLM with an OpenAI-compatible HTTP surface. Goal: a first-class `qwen-local` adapter that lets paperclip agents use Qwen as their brain — initially for chat/reasoning, eventually for the full agentic loop (tools, multi-turn, file edits).

**Constraints**
- DGX reachable on Tailnet only (private DNS / 100.x.x.x).
- vLLM auth: static bearer key `sk-9999`.
- Concurrency target: align with paperclip's per-agent default `maxConcurrentRuns = 20` (`packages/shared/src/constants.ts:75`); plan for 20–60 in-flight requests across the fleet.
- KISS / YAGNI: don't rebuild what an existing CLI already does.

**Note on model ID:** `Qwen/Qwen3.6-35B-A3B-FP8` does not match any verifiable Alibaba release (Qwen3 ships `Qwen3-30B-A3B`, `Qwen3-235B-A22B`). Likely typo, community fine-tune, or private build. Architecture is model-agnostic — adapter just passes `OPENAI_MODEL` through.

---

## 2. Approaches Evaluated

### Option A — Wrap `qwen-code` CLI (RECOMMENDED for Phase 1)
Alibaba's official agent CLI ([`QwenLM/qwen-code`](https://github.com/QwenLM/qwen-code)), Gemini-CLI fork, MIT, configured via `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`. Drop-in for vLLM.

**Pros**
- Reuses `opencode-local` adapter shape near 1:1 — proven blueprint, ~600–800 LOC.
- Agent loop, tool use, file edits, streaming, session resume all free.
- Low risk — clear exit ramp to Option C if needed.
- Ships in days, not weeks.

**Cons**
- Tied to qwen-code release cadence.
- Tool-call quality bounded by Qwen3 function-calling reliability (good, not Claude-tier).
- Adds a runtime install dependency (`npm install -g @qwen-code/qwen-code` or equivalent).

### Option B — Reuse `opencode-local` with custom OpenAI provider
Smallest change. Just register Qwen models in `opencode-local/src/server/models.ts` and wire env injection so `opencode` calls vLLM.

**Pros**
- ~1 day. No new package. No new UI surface.

**Cons**
- Not "first-class" — surfaces under OpenCode in UI.
- User explicitly asked for a dedicated adapter. Rejected on requirements grounds.

### Option C — Native TS agent loop in `qwen-local`
Build vLLM streaming client + tool dispatcher + edit/bash/grep tool implementations + multi-turn state directly in the adapter.

**Pros**
- Total control: prompt format, tool schema, retry policy, Qwen3 thinking-mode toggle.
- No external CLI dependency.

**Cons**
- 3–6 weeks. Recreates work already done by claude-code/codex/opencode/qwen-code.
- Becomes ongoing maintenance burden — paperclip team would own an agent CLI for one model family.
- Violates YAGNI until Phase 1 proves insufficient.

---

## 3. Recommended Solution

**Phase 1 — Ship Option A within ~1 week.** Then evaluate; only escalate to Option C if measured limits force it.

```
packages/adapters/qwen-local/
├── package.json                          # @paperclipai/adapter-qwen-local
├── src/
│   ├── index.ts                          # type/label/models/profiles (mirror opencode-local)
│   ├── cli/
│   │   ├── index.ts
│   │   └── format-event.ts
│   ├── server/
│   │   ├── index.ts
│   │   ├── execute.ts                    # spawn `qwen` CLI; inject env
│   │   ├── parse.ts                      # qwen-code stdout/JSON event parsing
│   │   ├── models.ts                     # static + dynamic model list from vLLM /v1/models
│   │   ├── runtime-config.ts             # base URL, api key, headers, timeouts
│   │   ├── skills.ts
│   │   └── test.ts
│   └── ui/
│       ├── index.ts
│       ├── build-config.ts               # form fields: baseUrl, apiKey, model, variant
│       └── parse-stdout.ts
```

### 3.1 Adapter type
- `type = "qwen_local"`, `label = "Qwen (local / vLLM)"`.
- `SANDBOX_INSTALL_COMMAND = "npm install -g @qwen-code/qwen-code"` (verify exact package name at impl time).
- `DEFAULT_QWEN_LOCAL_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"` (or whatever the served model id resolves to).
- Register in `server/src/adapters/registry.ts`.

### 3.2 Configuration surface (per-agent fields)
| Field | Purpose | Default |
|---|---|---|
| `baseUrl` | vLLM endpoint, Tailnet host | _required_, e.g. `http://dgx.tailnet:8000/v1` |
| `apiKey` | Static bearer | _required_, stored encrypted alongside other secrets |
| `model` | Served model id | `DEFAULT_QWEN_LOCAL_MODEL` |
| `variant` | Optional reasoning profile | none |
| `timeoutSec` | Run timeout | 600 |
| `graceSec` | SIGTERM grace | 10 |
| `extraArgs` | qwen-code passthrough | `[]` |
| `dangerouslySkipPermissions` | Headless approval bypass | `true` |

### 3.3 Execute pipeline (`server/execute.ts`)
1. Resolve cwd, instructions, prompt template (mirror `opencode-local/execute.ts`).
2. Inject env: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, plus any qwen-code-specific flags.
3. Spawn `qwen run --format json …` (verify exact CLI surface — qwen-code may differ from opencode).
4. Stream stdout into `parse.ts` → emit normalized adapter events.
5. On exit, write quota/cost via vLLM `usage` block (Qwen returns OpenAI-style `prompt_tokens` / `completion_tokens`).

### 3.4 Cost / quota
- vLLM returns token counts; adapter computes a synthetic cost (or zero) and reports via existing `quota.ts` shape.
- Recommend defaulting to **zero $-cost** for self-hosted runs but tracking tokens — paperclip already supports cost-per-run in DB.

### 3.5 vLLM server tuning (advisory; not adapter code)
For the documented 20–60 in-flight ceiling against an A3B MoE on DGX:
- `--max-num-seqs 64` — covers ceiling with headroom.
- `--enable-prefix-caching` — agent loops re-send tool history; massive win.
- `--max-model-len` set to actual context need (Qwen3 supports 128K+; running full context blows KV cache — clip to e.g. 32K unless workloads need more).
- `--tensor-parallel-size` per DGX GPU layout.
- FP8 KV cache (`--kv-cache-dtype fp8`) if memory pressured.
- Health endpoint behind Tailscale ACL; key `sk-9999` is *only* a soft barrier — Tailnet ACL is the real auth boundary.

### 3.6 Tailscale specifics
- Adapter does plain HTTP to Tailnet hostname; no TLS termination needed if both nodes on same tailnet.
- Document operator setup: ensure paperclip server node is in tailnet, MagicDNS on, DGX exposes vLLM on `0.0.0.0:8000` bound to tailscale interface only.
- No code change beyond `baseUrl` accepting `100.x.x.x` / MagicDNS hostnames — Node `fetch` handles it natively.

### 3.7 Tests
- `models.test.ts` — model id validation.
- `parse.test.ts` — qwen-code event parsing.
- `runtime-config.test.ts` — env injection, baseUrl normalization.
- `execute.remote.test.ts` — gated integration test against a live vLLM (skipped when env var unset).
- `test.ts` — adapter-level smoke.

---

## 4. Phase 2 (Conditional — Option C native loop)

Trigger criteria (any one):
- Tool-call success rate < 85% on golden eval set.
- qwen-code blocks an upstream feature paperclip needs.
- > 20% latency overhead vs direct vLLM calls measured.

Phase 2 swaps `execute.ts` internals (vLLM streaming client + tool dispatcher) while keeping the adapter's public contract identical — UI, registry, config schema unchanged.

---

## 5. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Model id `Qwen3.6-35B-A3B-FP8` not real / different name | High | Confirm with served `/v1/models` before merge; adapter passes string through unchanged. |
| Tool-call format mismatch (Qwen3 vs OpenAI strict) | Med | Lean on qwen-code's prompt tuning; eval on top 10 paperclip workloads. |
| vLLM saturation at 60 in-flight × multi-turn | Med | Tune `max-num-seqs`, prefix caching; document scaling path (additional vLLM replica + LB). |
| Tailscale outage isolates paperclip from DGX | Med | Standard adapter timeout/retry; surface as run failure, not crash. |
| `sk-9999` leaked from adapter logs | Low | Treat apiKey as secret in UI (`type=password`), redact in logs. |
| qwen-code CLI breaking changes | Med | Pin version in `SANDBOX_INSTALL_COMMAND`; integration test catches regressions. |

---

## 6. Success Metrics

- ✅ Paperclip agent configured with `qwen_local` adapter completes a non-trivial multi-turn task end-to-end against the DGX vLLM.
- ✅ ≥ 20 concurrent runs sustainable without vLLM 5xx storms.
- ✅ Token usage + cost reported per run.
- ✅ All adapter unit tests green; integration test green when `QWEN_LOCAL_BASE_URL` env set.
- ✅ Docs entry in `docs/` describing operator setup (Tailnet + vLLM flags + adapter config).

---

## 7. Next Steps

1. User approves Phase 1 scope.
2. `/ck:plan` to break Phase 1 into implementable phases (scaffolding → execute → parse → ui → tests → docs).
3. Confirm exact qwen-code CLI surface (`qwen run --help`) and pin version.
4. Confirm true HF model id served by the DGX vLLM.
5. Implement under a feature branch; integration-test against the live DGX endpoint.

---

## 8. Unresolved Questions

- Exact HF model id served by vLLM (user-supplied string is unverified).
- qwen-code CLI's actual argument shape and JSON event schema — needs hands-on once branch starts.
- Should adapter expose Qwen3 "thinking mode" as a config toggle, or always-off for agent workloads?
- Cost reporting: token-only (recommended) vs. synthetic $-cost based on a configurable per-token rate?
- Eval set: which existing paperclip workloads do we use as the golden suite for Phase 1 → Phase 2 trigger criteria?
