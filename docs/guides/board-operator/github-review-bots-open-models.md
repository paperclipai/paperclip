---
title: Review Your PRs With Open Models on OpenRouter
summary: Connect Paperclip GitHub Review Bots backed by open models like DeepSeek and GLM through OpenRouter with full run traces, custom skills, and per-PR cost visibility.
---

You can review GitHub pull requests with open models—including **DeepSeek** and **GLM** routed through **OpenRouter**—using the exact same dedicated GitHub App, structured `1–5` scoring, and run-trace visibility as any frontier-model bot. Because Paperclip separates the GitHub Review Bot connector from the underlying model and harness, you can point a review agent at an OpenRouter model in minutes, run it standalone or alongside your existing review tools, and swap models whenever a stronger or cheaper open checkpoint ships.

This tutorial covers four steps: why open models on OpenRouter fit PR reviews, how to configure an OpenRouter connection in Paperclip, how to run specialized DeepSeek and GLM bots on the same repository, and how to compare their findings, traces, and per-PR costs in Paperclip.

## Prerequisites

- Enable **GitHub review bots** in instance **Experimental** settings before setup (this default-off setting is independent of **Chat connectors**; hiding either does not pause delivery).
- Complete the core setup flow once using [GitHub Review Bots](/guides/board-operator/github-review-bots).
- An **OpenRouter** API key (`OPENROUTER_API_KEY` or an OpenRouter connection added under **Connectors** in Paperclip).
- **Harness compatibility:** OpenRouter works across Paperclip's **OpenCode**, **Pi**, **Codex**, **Claude**, and **Hermes** adapters (for OpenCode and Pi, configure an `openrouter/...` model ID such as `openrouter/deepseek/...` or `openrouter/z-ai/glm-...`). On self-hosted instances, remote native ACPX (including Claude) and OpenCode currently require an operator-supplied, build-owned provider pack via `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`; Codex with managed MCP tools and the native Runner Codex backend do not.

## 1. Why open models fit high-volume PR review

Black-box AI review vendors choose the model for you and bundle opaque per-seat pricing. Running open models through OpenRouter inside Paperclip changes the trade-off:

- **Pick the best open model for each job:** Run **DeepSeek** for sharp bug hunting and security checks, **GLM** for architecture and repository-rule compliance, or swap in newer open models from OpenRouter's live catalog without touching GitHub.
- **Pennies per PR with real receipts:** Every review runs as an ordinary Paperclip task showing exact tool calls, token counts, and per-PR cost (plus OpenRouter key credit caps if you want a hard spend ceiling).
- **Additive, never all-or-nothing:** Run your open-model bots standalone or right alongside existing review tools—each bot has its own GitHub App and stays advisory until a repository admin opts into a GitHub Ruleset.

## 2. Connect OpenRouter and create your review agents

1. In Paperclip, open **Connectors** and add your **OpenRouter** API key connection (when no explicit model allowlist is set, Paperclip loads OpenRouter's public model catalog automatically).
2. Create one or two focused review agents using a supported harness (for example, **Pi** or **OpenCode** with `OPENROUTER_API_KEY`):

| Agent | OpenRouter Model Family | Focus | Suggested Finding Categories |
| --- | --- | --- | --- |
| **Bug & Security Reviewer** (`deepseek-bug-bot`) | DeepSeek (`openrouter/deepseek/...`) | Auth checks, timing bugs, error handling, edge cases | `correctness`, `security`, `reliability` |
| **Architecture Reviewer** (`glm-arch-bot`) | GLM (`openrouter/z-ai/glm-...`) | Module boundaries, contract sync, repo rules | `correctness`, `maintainability` |

Keep each agent's instructions concise and attach your repository's `/` skills directly in the bot's **Settings → Instructions**.

## 3. Connect each bot as its own dedicated GitHub App

1. Open **Connectors → GitHub Code Review Bot** and choose your DeepSeek agent.
2. Click **Change `<agent>` to a low trust agent** if prompted (this saves the `low_trust_review` policy preset; on self-hosted setups, configure sandbox isolation separately before reviewing untrusted external PRs).
3. Name the App (for example, `acme-deepseek-review`), click **Continue to GitHub**, and install it on your target repositories.
4. Repeat steps 1–3 for your GLM agent (`acme-glm-review`) on the same repository if you want two specialists running in parallel.
5. In each bot's **Settings → When to run**, enable **Run automatically** on **New pull request** and **Updated commits** (or keep mentions-only with `@app-slug`).

## 4. Inspect findings, traces, and per-PR costs in Paperclip

Open a pull request on your enabled repository:

- **On GitHub:** Each open-model bot posts its own working summary comment, inline findings keyed to prevent duplicates, and commit-bound **Paperclip Review** check run.
- **In Paperclip → Reviews & Agent Runs:** Click **Details** on either check to inspect every file read, tool call, score rationale, and exact dollar cost side by side.
- **Swap models anytime:** When the next DeepSeek, GLM, or other open checkpoint lands on OpenRouter, update the model on your Paperclip agent—GitHub keeps sending webhooks to the same App with zero re-installation and zero Actions YAML.

## Next steps

- Turn a `5/5` open-model review into an opt-in required merge check with [Gate Merges on 5/5 Paperclip Reviews With GitHub Rulesets](/guides/board-operator/github-review-bots-required-checks).
- Prefer managed hosting and isolated sandboxes out of the box? Read [Own Your Agentic Code Reviews on Paperclip Cloud](/guides/board-operator/github-review-bots-cloud).
