---
title: Own Your Agentic Code Reviews on Paperclip Cloud
summary: Run managed, sandbox-isolated GitHub PR review bots on Paperclip Cloud while keeping full ownership of your agents, models, skills, run traces, and costs.
---

Paperclip Cloud lets you run managed GitHub PR review bots without handing your prompts, model choice, or review history to a black-box SaaS vendor. Your Cloud stack handles verified HTTPS webhook ingress, durable retry queues, and isolated execution automatically, while you own the agent, the model or harness, the repository skills, the dedicated GitHub App, and every execution trace and per-PR cost receipt.

This guide covers four parts: what owning your agentic code reviews means in practice, how to launch a Cloud-hosted review bot in two minutes, how Cloud compares with self-hosted and `localhost` deployments (including exact webhook and tunnel requirements), and how to keep untrusted PR reviews contained.

## Prerequisites

- A Paperclip Cloud workspace (or self-hosted instance if you operate your own infrastructure).
- Enable **GitHub review bots** in instance **Experimental** settings before setup (this default-off toggle is independent of **Chat connectors**; hiding either does not pause delivery).

## 1. Managed infrastructure without black-box lock-in

Teams usually face an awkward trade-off for AI code review: pay a black-box review vendor whose prompts, model choices, and token costs you cannot inspect, or maintain your own webhook servers, CI YAML, and sandbox runners.

Paperclip Cloud splits infrastructure from ownership cleanly:

- **Paperclip Cloud manages:** Verified HTTPS webhook ingress on your stack's hostname, durable publication outbox and GitHub rate-limit recovery (up to eight durable attempts across restarts), and managed execution environments.
- **You own:**
  - **The GitHub App identity:** Installed directly on your GitHub account or organization—never shared across customers, never posting with your personal token.
  - **The model and harness:** Connect Codex, Claude Code, OpenRouter open models (such as DeepSeek or GLM), or any supported Paperclip agent and swap anytime without touching GitHub.
  - **The review rubric and `/` skills:** Keep your repository conventions in Paperclip instead of a vendor's hidden system prompt, whether running standalone or alongside existing review tools.
  - **Every trace and dollar spent:** Every review is an ordinary Paperclip task with full tool logs, coverage limitations, and exact per-PR cost.

## 2. Connect a Cloud-hosted GitHub Review Bot in 2 minutes

1. Open your Paperclip Cloud workspace and go to **Connectors → GitHub Code Review Bot**.
2. Select the Paperclip agent that will own this bot and click **Change `<agent>` to a low trust agent** if prompted to save the `low_trust_review` policy preset.
3. Choose **My account** or an organization, review the App name (which sets your `@app-slug` mention), and click **Continue to GitHub**.
4. Confirm App creation on GitHub and grant access to the repositories you want reviewed.
5. Confirm your GitHub identity once so your `@mentions` map to your Paperclip permissions. Paperclip Cloud automatically verifies installation access and GitHub's signed webhook ping over your stack's verified hostname—zero ngrok, zero reverse proxy, zero `.github/workflows` YAML.
6. In **Settings**, attach your `/` review skills, choose **When to run** (mentions-only or automatic on PR opens/pushes), and keep reviews advisory until you are ready to opt into a [GitHub Ruleset required check](/guides/board-operator/github-review-bots-required-checks).

## 3. Paperclip Cloud vs. self-hosted and `localhost` (webhook & tunnel reality)

If you prefer to run Paperclip yourself, webhook delivery depends on whether you enroll your local or self-hosted instance with Paperclip Cloud:

| Deployment mode | Public HTTPS / tunnel required? | How GitHub webhooks reach Paperclip | Sandbox isolation |
| --- | --- | --- | --- |
| **Paperclip Cloud (managed stack)** | **No** | Direct HTTPS to your stack's verified Cloud hostname | Managed by Paperclip Cloud |
| **Self-hosted / `localhost` + Paperclip Cloud connector** | **No** *(requires enrolling with Paperclip Cloud)* | Cloud receives signed webhook bytes on an opaque route, encrypts them to your instance's public key, and your instance polls outbound | Configure `sandbox` driver + `isolated_workspace` on your host |
| **Standalone self-hosted / `localhost` (without Cloud)** | **Yes** *(public HTTPS domain or tunnel required)* | GitHub delivers directly to `POST /api/chat-webhooks/:publicId/github` (requires an `https://` origin) | Configure `sandbox` driver + `isolated_workspace` on your host |

> **Self-hosted harness note:** Codex with managed MCP tools and the native Runner Codex backend require no server-side remote provider pack. On self-hosted instances, remote native ACPX (including Claude Code) and OpenCode currently require an operator-supplied, build-owned provider pack via `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`.

## 4. Keep untrusted PRs contained

Pull request diffs and comments are untrusted input. Use the `low_trust_review` preset on every review bot to enforce Paperclip API containment (task-scoped reads/mutations, blocked edits to privileged agent config or company skills, and disabled free-prose child-to-parent reporting). On self-hosted deployments, saving the `low_trust_review` preset is separate from runtime sandboxing—configure a `sandbox` driver and `isolated_workspace` mode before reviewing untrusted external pull requests.
