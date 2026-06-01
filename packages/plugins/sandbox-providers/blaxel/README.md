# @paperclipai/plugin-blaxel

Blaxel sandbox provider plugin for Paperclip environments.

Provisions [Blaxel](https://blaxel.ai) microVM sandboxes as execution environments for Paperclip agents.

## Key Advantages over E2B

- **Snapshot-based scale-to-zero**: Sandboxes automatically hibernate when idle and snapshot their memory + filesystem state. No explicit `pause()` / `resume()` calls needed.
- **Sub-25ms resume**: When a hibernated sandbox is accessed, it resumes from snapshot in ~25ms — completely transparent to Paperclip.
- **No pause/unpause lifecycle**: Unlike E2B (which requires explicit `sandbox.pause()` and `Sandbox.connect()`), Blaxel handles hibernation and wakeup at the infrastructure level.
- **Idle TTL cleanup**: Sandboxes are automatically deleted after a configurable idle period, preventing orphaned resources.

## Configuration

| Field       | Type   | Default                    | Description                                                                            |
| ----------- | ------ | -------------------------- | -------------------------------------------------------------------------------------- |
| `apiKey`    | string | `$BL_API_KEY`              | Blaxel API key. Falls back to `BL_API_KEY` env var.                                   |
| `workspace` | string | `$BL_WORKSPACE`            | Blaxel workspace name. Falls back to `BL_WORKSPACE` env var.                          |
| `image`     | string | `blaxel/base-image:latest` | Container image for the sandbox.                                                       |
| `memory`    | number | `4096`                     | Memory in MB.                                                                          |
| `region`    | string | `$BL_REGION`               | Blaxel region (e.g. `us-pdx-1`, `eu-lon-1`, `us-was-1`).                             |
| `timeoutMs` | number | `300000`                   | Command execution timeout in milliseconds.                                             |
| `idleTtl`   | string | `30m`                      | How long a sandbox stays alive after last activity before cleanup (e.g. `30m`, `24h`). |

## How It Works

1. **Acquire Lease** → Creates a Blaxel sandbox with an idle TTL expiration policy
2. **Execute** → Runs commands inside the sandbox via `sandbox.process.exec()`
3. **Release Lease** → No-op! The sandbox stays alive and auto-hibernates when idle via Blaxel's scale-to-zero
4. **Resume Lease** → Reconnects to the sandbox; if hibernated, it resumes from snapshot in ~25ms
5. **Destroy Lease** → Explicitly deletes the sandbox (for force cleanup)

## Usage

Install the plugin from npm:

```sh
npm install @paperclipai/plugin-blaxel
```

Or add it to your Paperclip plugin configuration. The plugin registers a `blaxel` environment driver that can be selected in the Paperclip environment settings.
