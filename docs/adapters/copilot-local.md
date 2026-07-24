---
title: GitHub Copilot
summary: GitHub Copilot CLI local adapter setup and configuration
---

The `copilot_local` adapter runs GitHub Copilot CLI through its Agent Client Protocol (ACP) server. Paperclip keeps the ACP session available across heartbeats and exposes Copilot's structured text, status, and tool events in the run transcript.

## Prerequisites

- Node.js 22 or newer
- GitHub Copilot CLI installed (`npm install -g @github/copilot`)
- A GitHub account with a Copilot entitlement
- Enterprise policy that permits Copilot CLI
- A supported GitHub credential

Copilot checks credentials in this order:

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`
4. Stored Copilot OAuth credentials
5. The authenticated GitHub CLI account

GitHub CLI OAuth tokens (`gho_` or `ghu_`) and fine-grained `github_pat_` tokens with Copilot Requests permission are supported. Classic `ghp_` personal access tokens are not.

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Absolute working directory for the agent |
| `model` | string | No | Copilot model ID; `gpt-5.6-sol` is the verified default |
| `promptTemplate` | string | No | Prompt rendered for every heartbeat |
| `env` | object | No | Environment variables and secret references |
| `permissionMode` | string | No | ACP tool approval behavior |
| `stateDir` | string | No | ACP runtime state directory |
| `warmHandleIdleMs` | number | No | How long an idle persistent ACP process remains warm |
| `timeoutSec` | number | No | Heartbeat timeout |
| `graceSec` | number | No | Grace period before force termination |
| `extraArgs` | string[] | No | Additional Copilot CLI arguments |

## Sessions

The adapter uses Copilot's persistent ACP session support. Session identifiers are stored as opaque values and reused only when the configured working directory remains compatible.

The effective home follows `env.COPILOT_HOME`, the Paperclip server's `COPILOT_HOME`, or the normal `~/.copilot` directory, in that order, so existing Copilot CLI authentication and user-managed skills remain available.

## Environment Test

The environment test validates the local working directory, Node.js version, Copilot command, credential type, and ACP runtime. It then asks the configured model to respond with `hello`, which verifies authentication and model access without starting a normal heartbeat.

`copilot_local` currently supports local execution only. SSH and managed sandbox targets are rejected until their credential and Copilot-home provisioning behavior is defined.
