---
name: "update-cli-config"
description: "View and modify Codex CLI configuration settings in ~/.cursor/cli-config.json. Use when the user wants to change CLI settings, configure permissions, switch approval mode, enable vim mode, toggle display options, configure sandbox, or manage any CLI preferences."
metadata:
  surfaces:
    - cli
key: "paperclipai/optional/agency-agents/update-cli-config"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "update"
  - "cli"
  - "config"
defaultInstall: false
---
# Codex CLI Configuration

This skill explains how to view and modify Codex CLI settings stored in `~/.cursor/cli-config.json`.

## Config File Location

The config file is `~/.cursor/cli-config.json`.

Projects can layer overrides via `.cursor/cli.json` files. The CLI walks from the git root to the current working directory and merges each `.cursor/cli.json` it finds (deeper files take precedence). Project overrides only affect the current session; they are not written back to the home config.

## How to Modify

Read `~/.cursor/cli-config.json`, apply changes, and write it back. The file is standard JSON. Changes take effect after restarting the CLI.

## Available Settings

### `permissions` (required)
Tool permission rules. Each entry is a string pattern.
- `allow`: string[] — patterns for allowed tool calls (e.g. `"Shell(**)"`, `"Mcp(server-name, tool-name)"`)
- `deny`: string[] — patterns for denied tool calls

### `editor`
- `vimMode`: boolean — enable vim keybindings in the CLI input
- `defaultBehavior`: `"ide"` | `"agent"` — default behavior mode

### `display` (optional)
- `showLineNumbers`: boolean (default: false) — show line numbers in code output
- `showThinkingBlocks`: boolean (default: false) — show model thinking/reasoning blocks
- `showStatusIndicators`: boolean (default: false) — show status indicators in the UI

### `channel` (optional)
Release channel: `"prod"` | `"staging"` | `"lab"` | `"static"`

### `maxMode` (optional)
boolean (default: false) — enable max mode for higher-quality model responses

### `approvalMode` (optional)
Controls tool approval behavior:
- `"allowlist"` (default) — require approval for tools not in the allow list
- Run Everything — auto-approve all tool calls (same as `--force` / `--yolo`; set approval mode to the non-allowlist value)

### `sandbox` (optional)
Sandbox execution environment settings:
- `mode`: `"disabled"` | `"enabled"` (default: `"disabled"`)
- `networkAccess`: `"user_config_only"` | `"user_config_with_defaults"` | `"allow_all"` — controls network access from sandbox
- `networkAllowlist`: string[] — domains the sandbox is allowed to reach

### `network` (optional)
- `useHttp1ForAgent`: boolean (default: false) — use HTTP/1.1 instead of HTTP/2 for agent connections (enables SSE-based streaming)

### `bedrock` (optional)
AWS Bedrock integration settings:
- `enabled`: boolean (default: false)
- `mode`: `"access-key"` | `"team-role"` (default: `"access-key"`)
- `region`: string — AWS region
- `testModel`: string — model to use for testing
- `teamRoleArn`: string — IAM role ARN for team mode
- `teamExternalId`: string — external ID for STS assume-role

### `attribution` (optional)
Controls how agent work is attributed in git:
- `attributeCommitsToAgent`: boolean (default: true) — attribute commits to the agent
- `attributePRsToAgent`: boolean (default: true) — attribute PRs to the agent

### `webFetchDomainAllowlist` (optional)
string[] — domains the web fetch tool is allowed to access (e.g. `"docs.github.com"`, `"*.example.com"`, `"*"`)

## Fields You Should NOT Modify

These are internal/cached state and should not be edited manually:
- `version` — config schema version
- `model` / `selectedModel` / `modelParameters` / `hasChangedDefaultModel` — managed by the model picker
- `privacyCache` — cached privacy mode state
- `authInfo` — cached authentication info
- `showSandboxIntro` — one-time UI flag
- `conversationClassificationScoredConversations` — internal cache
