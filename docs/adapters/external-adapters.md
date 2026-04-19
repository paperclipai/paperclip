---
title: External Adapters
summary: Build, package, and distribute adapters as plugins without modifying Paperclip source
---

Paperclip supports external adapter plugins that can be installed from npm packages or local directories. External adapters work exactly like built-in adapters — they execute agents, parse output, and render transcripts — but they live in their own package and don't require changes to Paperclip's source code.

## Built-in vs External

| | Built-in | External |
|---|---|---|
| Source location | Inside `paperclip-fork/packages/adapters/` | Separate npm package or local directory |
| Registration | Hardcoded in three registries | Loaded at startup via plugin system |
| UI parser | Static import at build time | Dynamically loaded from API (see [UI Parser](/adapters/adapter-ui-parser)) |
| Distribution | Ships with Paperclip | Published to npm or linked via `file:` |
| Updates | Requires Paperclip release | Independent versioning |

## Quick Start

### Minimal Package Structure

```
my-adapter/
  package.json
  tsconfig.json
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      index.ts          # createServerAdapter() factory
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui-parser.ts        # Self-contained UI transcript parser
```

### package.json

```json
{
  "name": "my-paperclip-adapter",
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "paperclip": {
    "adapterUiParser": "1.0.0"
  },
  "exports": {
    ".": "./dist/index.js",
    "./server": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@paperclipai/adapter-utils": "^2026.325.0",
    "picocolors": "^1.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

Key fields:

| Field | Purpose |
|-------|---------|
| `exports["."]` | Entry point — must export `createServerAdapter` |
| `exports["./ui-parser"]` | Self-contained UI parser module (optional but recommended) |
| `paperclip.adapterUiParser` | Contract version for the UI parser (`"1.0.0"`) |
| `files` | Limits what gets published — only `dist/` |

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

## Server Module

The plugin loader calls `createServerAdapter()` from your package root. This function must return a `ServerAdapterModule`.

### src/index.ts

```ts
export const type = "my_adapter";     // snake_case, globally unique
export const label = "My Agent (local)";

export const models = [
  { id: "model-a", label: "Model A" },
];

export const agentConfigurationDoc = `# my_adapter configuration
Use when: ...
Don't use when: ...
`;

// Required by plugin-loader convention
export { createServerAdapter } from "./server/index.js";
```

### src/server/index.ts

```ts
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    // Omit this for adapters that should not receive a run-scoped
    // PAPERCLIP_API_KEY for same-company REST access.
    supportsLocalAgentJwt: true,
    models,
    agentConfigurationDoc,
  };
}
```

## Managed Local Agents and Board Access

External local adapters can let their child process use Paperclip's existing REST API without adding custom routes. This is the model used by managed coding agents and by the external Hermes adapter (`type: "hermes_local"`).

Adapter requirements:

- Export `createServerAdapter()` from the package root and return a complete `ServerAdapterModule`.
- Set `supportsLocalAgentJwt: true` so Paperclip can pass a run-scoped token as `ctx.authToken`.
- Read resolved adapter settings from `ctx.config`; read wake, task, comment, approval, and project-context data from `ctx.context`.
- Build the child process env from `buildPaperclipEnv(ctx.agent)`, then add `PAPERCLIP_RUN_ID`, wake fields, and adapter env values.
- Preserve an explicit `ctx.config.env.PAPERCLIP_API_KEY` when configured; otherwise set `PAPERCLIP_API_KEY` from `ctx.authToken`.

Common env keys for managed local agents:

| Env key | Purpose |
|---------|---------|
| `PAPERCLIP_API_URL` | Base Paperclip URL from `buildPaperclipEnv()` |
| `PAPERCLIP_API_KEY` | Run-scoped agent token, unless explicitly configured |
| `PAPERCLIP_RUN_ID` | Current heartbeat run id |
| `PAPERCLIP_AGENT_ID` | Current agent id |
| `PAPERCLIP_COMPANY_ID` | Current company id |
| `PAPERCLIP_TASK_ID` | Current issue/task id when the wake is task-scoped |
| `PAPERCLIP_WAKE_REASON` | Wake reason such as `issue_assigned` or `issue_commented` |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment id that triggered or guided the wake |
| `PAPERCLIP_WAKE_PAYLOAD_JSON` | Serialized Paperclip wake payload |
| `PAPERCLIP_PROJECT_CONTEXT_JSON` | Serialized project context helper payload when present |

Prompt or instruction bundles for such agents should teach the child process to call existing endpoints with bearer auth and a run id on writes:

```sh
# View self
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/me"

# View board state
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/dashboard"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?limit=50"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/projects"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/goals"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents"

# Add to the board
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"Follow up on Hermes finding","status":"todo"}' \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues"

# Add discussion
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"body":"I checked the board context and found the next step."}' \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments"

# Update work status
curl -s -X PATCH \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}' \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID"
```

### src/server/execute.ts

The core execution function. Receives an `AdapterExecutionContext` and returns an `AdapterExecutionResult`.

```ts
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, agent, runtime, context, onLog, onMeta } = ctx;

  // 1. Read config with safe helpers
  const cwd = String(config.cwd ?? "/tmp");
  const command = String(config.command ?? "my-agent");
  const timeoutSec = Number(config.timeoutSec ?? 300);

  // 2. Build environment with Paperclip vars injected
  const env = buildPaperclipEnv(agent);

  // 3. Render prompt template
  const prompt = config.promptTemplate
    ? renderTemplate(String(config.promptTemplate), {
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
        runId: ctx.runId,
        taskId: context.taskId ?? "",
        taskTitle: context.taskTitle ?? "",
      })
    : "Continue your work.";

  // 4. Spawn process
  const result = await runChildProcess(command, {
    args: [prompt],
    cwd,
    env,
    timeout: timeoutSec * 1000,
    graceMs: 10_000,
    onStdout: (chunk) => onLog("stdout", chunk),
    onStderr: (chunk) => onLog("stderr", chunk),
  });

  // 5. Return structured result
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    // Include session state for persistence
    sessionParams: { /* ... */ },
  };
}
```

#### Available Helpers from `@paperclipai/adapter-utils`

| Helper | Purpose |
|--------|---------|
| `runChildProcess(command, opts)` | Spawn a child process with timeout, grace period, and streaming callbacks |
| `buildPaperclipEnv(agent)` | Inject `PAPERCLIP_*` environment variables |
| `renderTemplate(template, data)` | `{{variable}}` substitution in prompt templates |
| `asString(v)`, `asNumber(v)`, `asBoolean(v)` | Safe config value extraction |

### src/server/test.ts

Validates the adapter configuration before running. Returns structured diagnostics.

```ts
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks = [];

  // Example: check CLI is installed
  checks.push({
    level: "info",
    message: "My Agent CLI v1.2.0 detected",
    code: "cli_detected",
  });

  // Example: check working directory
  const cwd = String(ctx.config.cwd ?? "");
  if (!cwd.startsWith("/")) {
    checks.push({
      level: "error",
      message: `Working directory must be absolute: "${cwd}"`,
      hint: "Use /home/user/project or /workspace",
      code: "invalid_cwd",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: checks.some(c => c.level === "error") ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
```

Check levels:

| Level | Meaning | Effect |
|-------|---------|--------|
| `info` | Informational | Shown in test results |
| `warn` | Non-blocking issue | Shown with yellow indicator |
| `error` | Blocks execution | Prevents agent from running |

## Installation

### From npm

```sh
# Via the Paperclip UI
# Settings → Adapters → Install from npm → "my-paperclip-adapter"

# Or via API
curl -X POST http://localhost:3102/api/adapters \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "my-paperclip-adapter"}'
```

### From local directory

```sh
curl -X POST http://localhost:3102/api/adapters \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/home/user/my-adapter"}'
```

Local adapters are symlinked into Paperclip's adapter directory. Changes to the source are picked up on server restart.

### Via adapter-plugins.json

For development, you can also edit `~/.paperclip/adapter-plugins.json` directly:

```json
[
  {
    "packageName": "my-paperclip-adapter",
    "localPath": "/home/user/my-adapter",
    "type": "my_adapter",
    "installedAt": "2026-03-30T12:00:00.000Z"
  }
]
```

## Optional: Session Persistence

If your agent runtime supports sessions (conversation continuity across heartbeats), implement a session codec:

```ts
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return r.sessionId ? { sessionId: String(r.sessionId) } : null;
  },
  serialize(params) {
    return params?.sessionId ? { sessionId: String(params.sessionId) } : null;
  },
  getDisplayId(params) {
    return params?.sessionId ? String(params.sessionId) : null;
  },
};
```

Include it in `createServerAdapter()`:

```ts
return { type, execute, testEnvironment, sessionCodec, /* ... */ };
```

## Optional: Skills Sync

If your agent runtime supports skills/plugins, implement `listSkills` and `syncSkills`:

```ts
return {
  type,
  execute,
  testEnvironment,
  async listSkills(ctx) {
    return {
      adapterType: ctx.adapterType,
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    };
  },
  async syncSkills(ctx, desiredSkills) {
    // Install desired skills into the runtime
    return { /* same shape as listSkills */ };
  },
};
```

## Optional: Model Detection

If your runtime has a local config file that specifies the default model:

```ts
async function detectModel() {
  // Read ~/.my-agent/config.yaml or similar
  return {
    model: "anthropic/claude-sonnet-4",
    provider: "anthropic",
    source: "~/.my-agent/config.yaml",
    candidates: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
  };
}

return { type, execute, testEnvironment, detectModel: () => detectModel() };
```

## Publishing

```sh
npm run build
npm publish
```

Other Paperclip users can then install your adapter by package name from the UI or API.

## Security

- Treat agent output as untrusted — parse defensively, never `eval()` agent output
- Inject secrets via environment variables, not in prompts
- Configure network access controls if the runtime supports them
- Always enforce timeout and grace period — don't let agents run forever
- The UI parser module runs in a browser sandbox — it must have zero runtime imports and no side effects

## Next Steps

- [UI Parser Contract](/adapters/adapter-ui-parser) — add a custom run-log parser so the UI renders your adapter's output correctly
- [Creating an Adapter](/adapters/creating-an-adapter) — full walkthrough of adapter internals
- [How Agents Work](/guides/agent-developer/how-agents-work) — understand the heartbeat lifecycle your adapter serves
