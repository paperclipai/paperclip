---
title: Crush
summary: Run the Charmbracelet Crush coding agent locally
---

The `crush_local` adapter starts an installed [Crush](https://github.com/charmbracelet/crush) CLI for each Paperclip run. Crush supplies the coding tools and model provider connection; Paperclip supplies the assigned task context and records the run. The adapter uses `crush run` and resumes a saved Crush session only in the same working directory.

## Setup

1. Install Crush on the machine that executes the agent and confirm `crush --version` works.
2. Configure a model provider in Crush and verify `crush run "Say hello"` works in the intended workspace.
3. Create a Paperclip agent with adapter **Crush**, set its workspace and instructions, and optionally set `command` to the Crush executable's absolute path. Leave the model blank to use Crush's default.

Crush supports custom OpenAI-compatible providers. For example, NVIDIA's hosted API uses `https://integrate.api.nvidia.com/v1`. Configure it in Crush with an environment-backed API key, then select a model that supports the tools your task needs. The NVIDIA key belongs in Crush's provider configuration or a secret environment variable, not in a Paperclip prompt or issue. See [Crush provider configuration](https://github.com/charmbracelet/crush#custom-providers) and [NVIDIA API documentation](https://docs.api.nvidia.com/nim/reference/meta-llama2-70b-infer).

The Paperclip adapter does not configure or validate the provider's API key. Its environment test checks that the command is available and sends a short hello probe through Crush; that probe may consume provider quota.

## Behavior and limits

- The adapter passes the Paperclip task prompt as one argument to `crush run --quiet` and streams Crush's plain-text output to the run log.
- Paperclip links selected skills in a separate directory for each company and agent. It sets `CRUSH_SKILLS_DIR` for the Crush process.
- It records the last Crush session ID after a successful run and uses `--session` on the next run in the same directory. If the saved session is missing, it retries once without that ID.
- Configure unattended tool permissions in Crush before relying on automated runs.
- Select a local Paperclip environment. This adapter does not run in remote execution targets.
- Crush's plain-text output does not expose reliable token usage or cost, so Paperclip cannot report those values for this adapter.
