---
title: GitHub Copilot Local
summary: GitHub Copilot SDK local adapter setup and configuration
---

The `copilot_local` adapter runs GitHub Copilot locally through the official `@github/copilot-sdk`. It is a good fit when you want GitHub-hosted model access, Copilot session resume, and the same local-agent workflow as the other built-in coding adapters without shelling out to `copilot -p` for every run.

## Prerequisites

- GitHub Copilot access on the host
- Either:
  - the bundled CLI that ships with `@github/copilot-sdk` (default), or
  - an explicit `command` override pointing at a compatible Copilot CLI binary
- Copilot authenticated on the host, or `GH_TOKEN` / `GITHUB_TOKEN` set with Copilot access

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the SDK session. Prefer Paperclip execution workspaces when available. |
| `instructionsFilePath` | string | No | Absolute path to a markdown file that Paperclip prepends to each Copilot run prompt. |
| `model` | string | No | Copilot model override. Leave unset to use Paperclip's default `gpt-5.4`. |
| `promptTemplate` | string | No | Prompt used for every heartbeat run. |
| `bootstrapPromptTemplate` | string | No | Setup prompt used only when Paperclip starts a fresh Copilot session. |
| `env` | object | No | Environment variables for the Copilot SDK process. Paperclip secret refs are supported in the UI/API. |
| `command` | string | No | Optional CLI executable override for the SDK. Leave unset to use the SDK's bundled Copilot CLI. |
| `extraArgs` | string[] | No | Additional CLI args inserted before SDK-managed flags. |
| `timeoutSec` | number | No | Session wait timeout in seconds (`0` disables the timeout). |
| `graceSec` | number | No | Retained for config compatibility. Ignored by SDK-backed execution. |

## Authentication

Paperclip does not manage Copilot sign-in for you. Use one of these patterns on the host that runs the agent:

- Sign in once to GitHub Copilot and reuse that local auth state
- Provide `GH_TOKEN` or `GITHUB_TOKEN` in the adapter environment

The UI **Test Environment** action reports whether the SDK can connect, whether Copilot auth is ready, whether model discovery succeeds, and whether a live hello probe can complete.

## Model Selection

Paperclip now prefers live Copilot model discovery through the SDK and falls back to the shipped catalog if discovery is unavailable. You can:

- Leave `model` unset to use the default `gpt-5.4`
- Pick from the discovered or fallback list in the UI/API
- Enter a custom model id if your Copilot environment exposes one that is not yet in Paperclip's shipped catalog

## Session Persistence

Paperclip stores the Copilot session id between heartbeats and resumes it through the SDK when the working directory still matches. If the stored session is no longer valid, Paperclip falls back to a fresh session automatically.

## Runtime Skills and Instructions

- Paperclip runtime skills are materialized into a temporary bundle and passed through the SDK's `skillDirectories` support
- `instructionsFilePath` is prepended to each run prompt so the Copilot session keeps the same Paperclip-specific guardrails and local context

## Environment Test

The environment test checks:

- The configured working directory is valid
- The configured command override is resolvable, or that the bundled SDK CLI path can be used
- Whether `GH_TOKEN` / `GITHUB_TOKEN` is present
- Whether the SDK can connect, report auth status, and list models
- A live Copilot hello probe so you can catch auth or runtime readiness problems early
