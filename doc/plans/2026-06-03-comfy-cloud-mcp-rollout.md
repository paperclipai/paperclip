# Comfy Cloud MCP Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Comfy Cloud MCP as a controlled media runtime capability for Codex, Paperclip, and Hermes without bypassing Paperclip budget, QA, secret, or publication gates.

**Architecture:** Codex receives a project-scoped, discovery-only MCP config in the Paperclip repo. Hermes receives a disabled MCP config entry that can be enabled only when `COMFY_CLOUD_API_KEY` is injected from the existing broker. Paperclip production generation remains behind existing YTF/Comfy budget and receipt gates until explicit generation tools are enabled.

**Tech Stack:** Codex MCP config TOML, Hermes `mcp_servers` YAML, Comfy Cloud MCP over HTTPS, `scripts/secret_broker.py`, Bitwarden alias `secret://media/comfy-cloud-api-key`, Paperclip YTF media budget/QA gates.

---

## Current State Applied

- Codex project config exists at `C:\Users\waldv\Desktop\Cockpit personnel\paperclip\.codex\config.toml`.
- Hermes local config has `mcp_servers.comfyui_cloud` at `C:\Users\waldv\.hermes\config.yaml` with `enabled: false`.
- No Comfy generation tool is enabled for Codex in phase 1.
- No Comfy API key is stored in repo, wiki, `.env`, or Hermes config.
- No Comfy job has been submitted as part of this rollout.

### Task 1: Codex Discovery-Only MCP

**Files:**
- Modify: `C:\Users\waldv\Desktop\Cockpit personnel\paperclip\.codex\config.toml`

- [x] **Step 1: Add Paperclip project-scoped MCP config**

```toml
[mcp_servers.comfyui_cloud]
url = "https://cloud.comfy.org/mcp"
env_http_headers = { "X-API-Key" = "COMFY_CLOUD_API_KEY" }
enabled = true
required = false
default_tools_approval_mode = "prompt"
enabled_tools = [
  "search_templates",
  "search_models",
  "search_nodes",
  "cql",
  "get_queue",
]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.comfyui_cloud.tools.search_templates]
approval_mode = "approve"

[mcp_servers.comfyui_cloud.tools.search_models]
approval_mode = "approve"

[mcp_servers.comfyui_cloud.tools.search_nodes]
approval_mode = "approve"

[mcp_servers.comfyui_cloud.tools.cql]
approval_mode = "approve"

[mcp_servers.comfyui_cloud.tools.get_queue]
approval_mode = "approve"
```

- [x] **Step 2: Verify Codex sees the server after restart**

Run from the Paperclip repo after restarting Codex:

```powershell
python C:\Users\waldv\LLM-Wiki\scripts\secret_broker.py run `
  --alias secret://media/comfy-cloud-api-key `
  --env COMFY_CLOUD_API_KEY `
  --runtime codex-windows `
  --action media_runtime `
  -- codex mcp list
```

Result 2026-06-03: `codex mcp list` and `codex mcp get comfyui_cloud` from the Paperclip repo list `comfyui_cloud`, URL `https://cloud.comfy.org/mcp`, `env_http_headers: X-API-Key=COMFY_CLOUD_API_KEY`, and the five discovery-only tools without printing the key. A first `codex exec` saw `mcp__comfyui_cloud/search_templates` but cancelled the tool call because discovery tools were still prompt-gated. The config now keeps `default_tools_approval_mode = "prompt"` and adds per-tool `approval_mode = "approve"` only for the five discovery tools. A second read-only `codex exec` passed: `search_templates(q="text to image", limit=3)` returned 3 templates, total `82`, including `Qwen Image 2512: 360 Panorama Image` and `Qwen Image: Illustration LoRA`. The current Codex desktop thread does not hot-reload new MCP tools; a new/restarted Codex app thread is still required for in-chat tool exposure.

- [x] **Step 3: Verify discovery-only tool behavior**

Ask Codex in the Paperclip repo:

```text
Use Comfy MCP only to search templates for text-to-image. Do not generate, upload, or submit a workflow.
```

Result 2026-06-03: MCP `initialize + list_tools` passed through the broker-injected key. The server reported 18 total tools, while Paperclip Codex config exposes only `search_templates`, `search_models`, `search_nodes`, `cql`, and `get_queue`. A single read-only SDK `tools/call search_templates` with generic arguments `q="text to image", limit=3` returned `is_error=false`. A separate read-only `codex exec` call also completed `search_templates` through Codex's MCP tool surface. No generation, upload, workflow submission, asset input, or credit-consuming tool was called.

### Task 2: Hermes MCP Preparation

**Files:**
- Modify: `C:\Users\waldv\.hermes\config.yaml`

- [x] **Step 1: Add disabled Comfy MCP entry**

```yaml
mcp_servers:
  comfyui_cloud:
    enabled: false
    url: https://cloud.comfy.org/mcp
    headers:
      X-API-Key: ${COMFY_CLOUD_API_KEY}
    timeout: 180
    connect_timeout: 30
    supports_parallel_tool_calls: false
    tools:
      resources: false
      prompts: false
```

- [x] **Step 2: Enable only in a broker-injected Hermes launch**

Use the existing alias policy:

```powershell
python C:\Users\waldv\LLM-Wiki\scripts\secret_broker.py run `
  --alias secret://media/comfy-cloud-api-key `
  --env COMFY_CLOUD_API_KEY `
  --runtime codex-windows `
  --action media_runtime `
  --dry-run `
  -- powershell -NoProfile -Command "'probe'"
```

Result 2026-06-03: broker dry-run for `secret://media/comfy-cloud-api-key` passed with action `media_runtime`; action `media_generation` was refused as expected by the alias policy.

- [ ] **Step 3: Enable Hermes MCP only after a launcher exists**

Change `enabled: false` to `enabled: true` only inside a controlled launcher path that injects `COMFY_CLOUD_API_KEY` temporarily. Do not put the key in `C:\Users\waldv\.hermes\.env`.

Expected: Hermes `/reload-mcp` or restart discovers Comfy tools without logging the key.

### Task 3: Paperclip Production Gate

**Files:**
- Inspect before enabling generation: existing YTF Comfy budget and receipt scripts in the active Paperclip media workspace.

- [ ] **Step 1: Keep generation tools disabled until the gate is adapted**

Do not add these Codex MCP tools yet:

```text
partner_generate
submit_workflow
get_job_status
get_output
upload_file
use_previous_output
run_saved_workflow
save_workflow
cancel_job
```

Expected: Paperclip agents cannot spend Comfy credits through MCP during phase 1.

- [ ] **Step 2: Add a preflight wrapper before generation**

Before enabling generation tools, implement a wrapper or issue policy that requires:

```text
budget preflight PASS
ticket or issue id present
prompt/assets classified non-sensitive
telemetry acknowledged
receipt output path declared
publication disabled
```

Expected: no MCP generation can run without a Paperclip trace and budget decision.

- [ ] **Step 3: Add receipt requirements**

Every generated asset must record:

```text
provider=comfy_cloud_mcp
tool_name
prompt_hash
input_asset_hashes
job_or_prompt_id
output_asset_ids_or_urls
credit_estimate_or_observed_cost_when_available
beta_telemetry_ack=true
paperclip_issue_id
sha256_final_asset
qa_status
publication_allowed=false by default
```

Expected: generated assets are auditable and cannot be confused with public-ready YTF deliverables.

### Task 4: Phase 2 Enablement

**Files:**
- Modify: `C:\Users\waldv\Desktop\Cockpit personnel\paperclip\.codex\config.toml`
- Modify only after gate work: Paperclip YTF runtime policy files in the media workspace.

- [ ] **Step 1: Enable read/poll output tools**

Add only:

```toml
enabled_tools = [
  "search_templates",
  "search_models",
  "search_nodes",
  "cql",
  "get_queue",
  "get_job_status",
  "get_output"
]
```

Expected: Codex can inspect/poll existing jobs but still cannot submit new generation.

- [ ] **Step 2: Enable one bounded smoke generation**

Add `partner_generate` or `submit_workflow` for one manually approved smoke test.

Expected: one low-cost neutral image prompt runs, a receipt is written, and no upload/publication follows.

- [ ] **Step 3: Decide whether to keep MCP in production**

Keep MCP only if it improves reliability or speed over the existing Comfy/Kling scripts while preserving budget and QA gates.

Expected: either promote with gates or disable and keep the config as a documented beta experiment.
