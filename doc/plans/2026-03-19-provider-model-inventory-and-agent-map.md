# Provider/Model Inventory and Recommended Agent Map

Date: 2026-03-19
Issue: FRE-5
Instance: local hub (`http://127.0.0.1:3101`)

## What Was Tested

API coverage tested with agent auth:
- `GET /api/companies/:companyId/agent-configurations` -> 200
- `GET /api/companies/:companyId/agents` -> 200
- `GET /api/companies/:companyId/adapters/:type/models` (all installed adapters) -> 200
- `POST /api/companies/:companyId/adapters/:type/test-environment` (all installed adapters, empty config) -> 200

Note:
- `/api/llms/agent-configuration.txt` and `/api/llms/agent-icons.txt` returned 404 in this instance.

## Installed Adapters and Model Availability

- `codex_local`: 127 models discovered.
  - Sample: `gpt-5`, `gpt-5.3-codex`, `gpt-5.4`, `o3`, `o4-mini`, `codex-mini-latest`
  - Env test: `warn` (missing `OPENAI_API_KEY`), hello probe succeeds.

- `opencode_local`: 299 models discovered.
  - Sample: `qwen3-coder-next`, `glm-5`, `kimi-k2.5`, `MiniMax-M2.5`
  - Env test: `pass`.

- `cursor`: 39 models discovered.
  - Sample: `auto`, `composer-1.5`, `gpt-5.3-codex-low`
  - Env test: `fail` (`agent` command missing, no `CURSOR_API_KEY`).

- `claude_local`: 5 models.
  - Sample: `claude-opus-4-6`, `claude-sonnet-4-6`
  - Env test: `fail` (hello probe fails, `ANTHROPIC_API_KEY` missing).

- `gemini_local`: 6 models.
  - Sample: `gemini-2.5-pro`, `gemini-2.5-flash`
  - Env test: `fail` (hello probe fails; likely auth not configured).

- `hermes_local`: 7 models.
  - Sample: `anthropic/claude-sonnet-4`, `openai/gpt-4.1`, `google/gemini-2.5-pro`
  - Env test: `fail` (`hermes` CLI missing).

- `pi_local`: 0 models currently.
  - Env test: `fail` (`pi` command missing + model required).

- `openclaw_gateway`: 0 static models.
  - Env test: `fail` (WebSocket URL required).

- `process`: 0 static models.
  - Env test: `fail` (command required).

- `http`: 0 static models.
  - Env test: `fail` (URL required).

## Recommended Agent Creation Plan (Now)

Primary recommendation: use `codex_local` and `opencode_local` first, because they currently have the strongest model availability and passing/successful probes.

1. CEO Agent
- Adapter: `codex_local`
- Model: `gpt-5.4` (strategy quality)
- Fallback: `gpt-5`

2. CTO Agent
- Adapter: `codex_local`
- Model: `gpt-5.3-codex`
- Fallback: `gpt-5.3-codex-spark`

3. Founding Engineer Agent
- Adapter: `codex_local`
- Model: `gpt-5.3-codex`
- Fallback: `o4-mini`

4. Research/Scouting Agent
- Adapter: `opencode_local`
- Model: `qwen3-coder-next`
- Fallback: `glm-5`

5. Ops Automation Agent
- Adapter: `opencode_local`
- Model: `kimi-k2.5`
- Fallback: `MiniMax-M2.5`

## Recommended Agent Creation Plan (After Auth/CLI Fixes)

6. CMO/Copy Agent (after Anthropic auth)
- Adapter: `claude_local`
- Model: `claude-sonnet-4-6`

7. Multimodal/Product Insight Agent (after Gemini auth)
- Adapter: `gemini_local`
- Model: `gemini-2.5-pro`

8. Cursor-native Specialist (after Cursor CLI/API setup)
- Adapter: `cursor`
- Model: `composer-1.5`

## Immediate Unblock Checklist

- Configure `OPENAI_API_KEY` for Codex adapters in managed secrets/env.
- Configure Claude auth (`ANTHROPIC_API_KEY` or CLI login) and rerun env probe.
- Configure Gemini CLI auth and rerun env probe.
- Install/configure `agent` (Cursor CLI), `pi`, and `hermes` binaries if those adapters are required.
- If OpenClaw is planned, set gateway WebSocket URL in adapter config.

## Acceptance Evidence

- Live model list and environment probe executed for all installed adapter types.
- Recommendations include both immediate deployable path and post-auth expansion path.
