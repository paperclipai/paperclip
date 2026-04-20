# Easy Agent Creation + Auto Adapter Config Design

**Date:** 2026-03-24
**Status:** Approved

## Problem

Creating a new agent requires manual adapter configuration, environment variable setup, and credential binding. Users must understand adapter types, proxy URLs, and API key management. This is error-prone and time-consuming.

## Goals

- One-click agent creation from role templates (card grid UI)
- Auto-configure adapter, credentials, env vars, permissions based on role + model choice
- Per-agent model provider toggle: Claude (direct) or Qwen (via proxy)
- Smart defaults: strategic roles default to Claude, others to Qwen
- Show real model names in Paperclip UI (Qwen instead of Claude when using proxy)
- Advanced override available but hidden by default

## Design

### New Agent Creation Flow

Card grid with role templates. Each card has:
- Role icon, name, short description
- Model provider dropdown (Claude/Qwen) with smart default
- Click card → confirmation popup with pre-filled name + "Create" button
- Optional "Advanced" section for overrides (specific model, reports-to, credential, heartbeat)

### Auto-Configuration

| Setting | Claude | Qwen |
|---|---|---|
| Adapter type | claude_local | claude_local (same) |
| Credential | Default claude_oauth | Default qwen_api_key |
| Env vars | Auto from credential | Auto from credential (proxy injected) |
| Permissions | From AGENT_ROLE_DEFAULT_PERMISSIONS | Same |
| Heartbeat | Enabled, 300s | Same |

### Model Display in UI

Detect credential type and show real model name:
- qwen_api_key + opus → "Qwen3 Coder Plus"
- qwen_api_key + sonnet → "Qwen3 Coder Next"
- qwen_api_key + haiku → "Qwen3.5 Plus"
- claude_oauth → show Claude model as-is

### Smart Defaults

- Claude: CEO, CTO, CFO
- Qwen: CMO, PM, Engineer, QA, Designer, DevOps, Researcher, General
