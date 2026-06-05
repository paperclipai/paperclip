# Novita Sandbox Provider Plugin

Published Novita Agent Sandbox provider plugin for Paperclip.

This plugin registers a Paperclip `sandbox` environment provider with provider key `novita`.
It provisions [Novita Agent Sandbox](https://novita.ai/sandbox) instances and runs Paperclip
agent commands inside those sandboxes.

## Configuration

The environment uses core `driver: "sandbox"` with `provider: "novita"`.

| Field | Required | Description |
| --- | --- | --- |
| `apiKey` | No | Novita API key. If omitted, the plugin uses `NOVITA_API_KEY` from the worker environment. |
| `domain` | No | Optional Novita API domain override. |
| `template` | No | Novita sandbox template ID or name. Defaults to the SDK's base template. |
| `requestedCwd` | No | Workspace directory inside the sandbox. Defaults to `/home/user/paperclip-workspace`. |
| `timeoutMs` | No | Sandbox lifetime and default command timeout. Defaults to `300000`. |
| `requestTimeoutMs` | No | Novita SDK request timeout. Defaults to `30000`. |
| `secure` | No | Optional secure connection flag passed to the Novita SDK. |
| `autoPause` | No | Enables Novita auto-pause behavior when supported by the selected template. |
| `reuseLease` | No | Pause/resume the sandbox across runs instead of killing it on release. |

## Behavior

- `probe` creates a temporary Novita sandbox, verifies the workspace directory, detects `bash`/`sh`, then kills it.
- `acquireLease` creates a sandbox and returns the sandbox ID as Paperclip's provider lease ID.
- `resumeLease` reconnects to the sandbox ID and extends its timeout.
- `releaseLease` kills the sandbox by default. When `reuseLease` is enabled, it calls `betaPause()`.
- `destroyLease` always kills the sandbox.
- `execute` runs Paperclip commands through `sandbox.commands.run()`.

## Links

- Novita Agent Sandbox: https://novita.ai/sandbox
- Novita Sandbox docs: https://novita.ai/docs/guides/sandbox-overview
- Novita API keys: https://novita.ai/settings/key-management
