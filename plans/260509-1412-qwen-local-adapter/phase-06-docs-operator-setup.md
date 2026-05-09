---
phase: 6
title: Docs + operator setup
status: completed
priority: P3
effort: 3h
dependencies:
  - 4
---

# Phase 6: Docs + operator setup

## Overview

Operator-facing doc covering DGX vLLM setup, Tailscale wiring, paperclip adapter config, troubleshooting, and the Phase-2 escalation criteria.

## Requirements

- Single doc page under `docs/`, ≤ 800 LOC.
- Covers: vLLM launch flags, Tailscale prerequisites, adapter config fields, smoke-test procedure, common errors.
- Cross-links to brainstorm report and plan dir.
- Updates `docs/codebase-summary.md` (or equivalent index) so the new adapter is discoverable.

## Architecture

Pure documentation. No code.

## Related Code Files

- Create: `docs/qwen-local-adapter.md`
- Modify: `docs/codebase-summary.md` (add 1-line entry under Adapters); `docs/system-architecture.md` (note new adapter under runtime catalog if such a section exists).

## Implementation Steps

1. Write `docs/qwen-local-adapter.md` with sections:
   - **Overview** — what it does, when to use.
   - **vLLM server setup** — recommended flags: `--max-num-seqs 64`, `--enable-prefix-caching`, `--max-model-len 32768`, `--kv-cache-dtype fp8`, `--api-key sk-9999`, `--tensor-parallel-size <N>`. Note FP8 model dtype.
   - **Tailscale wiring** — paperclip server + DGX both in tailnet; MagicDNS hostname OR `100.x.x.x`; bind vLLM to tailscale interface.
   - **Adapter configuration** — field-by-field table (baseUrl, apiKey, model, variant, timeoutSec, dangerouslySkipPermissions, extraArgs).
   - **Smoke test** — `curl http://<host>:8000/v1/models -H "Authorization: Bearer sk-9999"`; create test agent; trigger one-shot run.
   - **Concurrency tuning** — 20–60 in-flight ceiling derived from `AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 20`. Scaling path: additional vLLM replicas behind a load balancer.
   - **Troubleshooting** — connection refused, 401 on apiKey, OOM, slow first token (prefix cache cold).
   - **Security** — `sk-9999` is soft auth; Tailnet ACL is the real boundary. Recommend dedicated tailnet tag for the DGX node.
   - **Phase 2 trigger criteria** — quote from brainstorm report.
2. Add 1-line entry to `docs/codebase-summary.md` under adapters.
3. Add note in `docs/system-architecture.md` if it lists adapter runtimes.
4. Cross-link from `README.md` adapters table if such a table exists.

## Success Criteria

- [x] Doc renders correctly in markdown preview.
- [x] An operator unfamiliar with the project can stand up the adapter end-to-end using only this doc + the brainstorm report.
- [x] `docs/codebase-summary.md` includes the new adapter.

## Risk Assessment

- Risk: doc drifts from code as adapter evolves. Mitigation: add a top-of-file note pointing readers to `agentConfigurationDoc` in `src/index.ts` as the canonical field reference.
