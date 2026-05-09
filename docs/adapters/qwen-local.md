---
title: Qwen Local (vLLM)
summary: Qwen-code CLI adapter pointed at a self-hosted vLLM endpoint (e.g. DGX over Tailscale)
---

The `qwen_local` adapter drives Alibaba's official `@qwen-code/qwen-code` CLI in OpenAI-compatible mode against a self-hosted vLLM endpoint. It targets DGX-class hardware reachable over Tailscale and supports per-agent concurrency suitable for 20–60 in-flight runs.

> **Canonical field reference:** `packages/adapters/qwen-local/src/index.ts` exports `agentConfigurationDoc`. This page mirrors that doc but adds operator setup. If they drift, the source-of-truth is the `.ts` file.

## When to use

- You serve a Qwen (or any OpenAI-compatible) model on vLLM
- The vLLM endpoint is reachable from the Paperclip host (typically via Tailscale)
- You want tool-calling / multi-turn agent behavior, not bare chat completions

Don't use if the endpoint isn't OpenAI-compatible (write a custom adapter), or if you only need one-shot HTTP chat (use the generic `http` adapter).

## Prerequisites

- vLLM serving the model on an OpenAI-compatible endpoint (`/v1/models`, `/v1/chat/completions`)
- `qwen` CLI on the Paperclip execution target: `npm install -g @qwen-code/qwen-code@0.15.9`
- Network reachability between Paperclip host and vLLM (Tailscale recommended)

## vLLM server setup

Recommended launch flags for the default model on DGX-class hardware:

```bash
vllm serve Qwen/Qwen3.6-35B-A3B-FP8 \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key sk-9999 \
  --max-model-len 32768 \
  --max-num-seqs 64 \
  --enable-prefix-caching \
  --kv-cache-dtype fp8 \
  --tensor-parallel-size <N>          # set to your GPU count
```

Notes:
- `--max-num-seqs 64` matches the 20–60 concurrent-runs target with headroom.
- `--enable-prefix-caching` is critical for agent loops that share long system prompts across turns.
- `--kv-cache-dtype fp8` pairs with the FP8 model weights to fit larger context per GPU.
- `--api-key sk-9999` is a soft-auth stub; the real boundary is the network ACL (see Security).

## Tailscale wiring

1. Install Tailscale on both the Paperclip host and the DGX node.
2. Join both to the same tailnet.
3. Bind vLLM to `0.0.0.0` (or specifically the tailscale interface) so it accepts traffic from the tailnet.
4. Use the DGX's MagicDNS name (`http://dgx:8000/v1`) or its 100.x.x.x address as `baseUrl`.
5. Restrict access via tailnet ACL — give the DGX a dedicated tag (e.g. `tag:llm-server`) and allow only the Paperclip host's tag inbound on port 8000.

## Adapter configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | string | **Yes** | vLLM OpenAI-compatible endpoint (e.g. `http://dgx:8000/v1`) |
| `apiKey` | string | **Yes** | Bearer token for the vLLM endpoint (use `sk-local` if vLLM is unauthenticated) |
| `model` | string | No | Served model id; defaults to `Qwen/Qwen3.6-35B-A3B-FP8` |
| `cwd` | string | No | Working directory for the agent process |
| `approvalMode` | string | No | qwen-code approval mode; defaults to `yolo` for unattended runs |
| `command` | string | No | Override the `qwen` binary path |
| `extraArgs` | string[] | No | Additional CLI args appended to every invocation |
| `timeoutSec` | number | No | Run timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | SIGTERM grace period in seconds |

The adapter routes the API key through `OPENAI_API_KEY` environment variable rather than a CLI flag, so it never appears in process listings (`ps`, `/proc`, audit logs).

## Smoke test

1. **Reach the endpoint directly:**
   ```bash
   curl http://dgx:8000/v1/models -H "Authorization: Bearer sk-9999"
   ```
   Expect a JSON array containing `Qwen/Qwen3.6-35B-A3B-FP8`.

2. **Drive the CLI by hand** (proves auth + env wiring before involving Paperclip):
   ```bash
   OPENAI_BASE_URL=http://dgx:8000/v1 \
   OPENAI_API_KEY=sk-9999 \
   OPENAI_MODEL=Qwen/Qwen3.6-35B-A3B-FP8 \
   qwen "say hello" -o stream-json --auth-type openai --bare -y
   ```

3. **Through Paperclip:** create a `qwen_local` agent in the dashboard with the fields above, then trigger a one-shot run from the issue UI. Use the "Test Environment" button to verify `qwen` is on PATH.

## Concurrency tuning

- Per-agent default: 20 in-flight runs (`AGENT_DEFAULT_MAX_CONCURRENT_RUNS` in `packages/shared/src/constants.ts`). Multiple agents add up — N agents × 20 = N×20 worst case.
- Match `--max-num-seqs` on vLLM to your expected fleet ceiling.
- Scaling path beyond a single DGX: run a second vLLM replica on another node, put both behind a load balancer (HAProxy / Envoy), point `baseUrl` at the LB. Stateless requests, so round-robin is fine.
- The adapter doesn't enforce a global LLM cap — concurrency is gated only at the agent level.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `connection refused` | vLLM not reachable from Paperclip host | `curl` from the Paperclip host; check tailnet status with `tailscale ping dgx` |
| HTTP 401 | `apiKey` mismatch | Verify the value matches vLLM's `--api-key` flag exactly |
| HTTP 404 on `/models` | Wrong `baseUrl` (missing `/v1`) | Endpoint must end in `/v1`, not `/` |
| OOM on first request | `--max-model-len` too high or KV cache too small | Lower `--max-model-len` or shrink `--max-num-seqs` |
| Slow first token | Prefix cache cold | Expected after process restart; warms within a few requests |
| `qwen: command not found` | CLI not installed on execution target | `npm install -g @qwen-code/qwen-code@0.15.9` |
| Run hangs at 100% CPU | Approval prompt not bypassed | Confirm `approvalMode: "yolo"` (default) or pass `--approval-mode yolo` via `extraArgs` |

## Security

- `sk-9999` (or any vLLM `--api-key`) is **soft auth** — it's a single shared secret with no rotation, no per-client scoping. Treat it as a tripwire, not a wall.
- The real security boundary is the **tailnet ACL**. Tag the DGX node (e.g. `tag:llm-server`) and restrict inbound port 8000 to the Paperclip host's tag.
- The adapter never passes the API key as a CLI flag — only via `OPENAI_API_KEY` env var, so it stays out of process listings and shell history.
- For multi-tenant deployments, run separate vLLM instances per tenant with distinct keys, or front vLLM with a per-tenant proxy.

## Phase 2 escalation criteria

The current adapter wraps the qwen-code CLI as a subprocess. Phase 2 (native agent loop, no CLI) is triggered when any of these proves out:

- CLI subprocess overhead becomes a measurable bottleneck (e.g. >100ms per turn at the 60-concurrent target)
- We need streaming behaviors qwen-code's stream-json doesn't expose (e.g. partial tool-call deltas, custom interleaving)
- qwen-code releases break our parser more than once per quarter
- We want first-class session-resume across heartbeats (Phase 2.5 partial; Phase 2 full)

Until then, the wrapper approach trades per-turn latency for zero maintenance of an inference loop.

## References

- Adapter source: `packages/adapters/qwen-local/`
- Server registry entry: `server/src/adapters/registry.ts` (search `qwen_local`)
- Brainstorm context: `plans/reports/brainstorm-260509-1412-qwen-local-adapter.md`
- Implementation plan: `plans/260509-1412-qwen-local-adapter/`
- vLLM docs: <https://docs.vllm.ai>
- qwen-code: <https://github.com/QwenLM/qwen-code>
