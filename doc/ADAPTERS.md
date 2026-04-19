# Adapter Authoring Guide

This guide covers how to create custom Paperclip adapters — the bridge between the Paperclip orchestration server and an AI agent runtime (CLI tool, HTTP service, WebSocket gateway, etc.).

## Overview

An adapter tells Paperclip how to:

1. **Execute** an agent — spawn a process, call an HTTP endpoint, or open a WebSocket connection.
2. **Test the environment** — verify that the runtime (CLI binary, API key, working directory) is correctly set up.
3. **Manage sessions** — optionally persist and resume conversation state across heartbeats.
4. **Manage skills** — optionally list and sync Paperclip skills into the agent's runtime.

Every adapter implements the `ServerAdapterModule` interface from `@paperclipai/adapter-utils`.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Paperclip Server                               │
│                                                 │
│  heartbeatService ──► registry.getServerAdapter()│
│       │                     │                   │
│       ▼                     ▼                   │
│  adapter.execute(ctx)   adapter.testEnvironment()│
│       │                                         │
│       ▼                                         │
│  AdapterExecutionResult                         │
│  (exit code, session, usage, cost)              │
└─────────────────────────────────────────────────┘
```

Adapters live in one of two locations:

- **External packages** (`packages/adapters/<name>/`) — for full-featured adapters with UI/CLI log parsing and skill support. Published as `@paperclipai/adapter-<name>`.
- **Built-in modules** (`server/src/adapters/<name>/`) — for simpler adapters that don't need separate packaging (e.g., `process`, `http`).

All adapters are registered in `server/src/adapters/registry.ts`.

## The `ServerAdapterModule` Interface

```typescript
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterSessionCodec,
  AdapterSkillContext,
  AdapterSkillSnapshot,
  AdapterModel,
  HireApprovedPayload,
  HireApprovedHookResult,
  ProviderQuotaResult,
} from "@paperclipai/adapter-utils";

interface ServerAdapterModule {
  // ── Required ──────────────────────────────────────────────
  type: string; // Unique identifier, e.g. "my_adapter"
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;

  // ── Optional ──────────────────────────────────────────────
  models?: AdapterModel[]; // Static model catalog
  listModels?: () => Promise<AdapterModel[]>; // Dynamic model discovery
  agentConfigurationDoc?: string; // Markdown docs for agent config UI
  supportsLocalAgentJwt?: boolean; // Accept Paperclip-issued JWTs

  // Session management
  sessionCodec?: AdapterSessionCodec; // Serialize/deserialize session params
  sessionManagement?: AdapterSessionManagement; // Session compaction policy

  // Skill management
  listSkills?: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills?: (ctx: AdapterSkillContext, desired: string[]) => Promise<AdapterSkillSnapshot>;

  // Lifecycle hooks
  onHireApproved?: (payload: HireApprovedPayload, config: Record<string, unknown>) => Promise<HireApprovedHookResult>;

  // Provider quota reporting
  getQuotaWindows?: () => Promise<ProviderQuotaResult>;
}
```

### Required: `type`

A unique string identifier for this adapter. Convention: `snake_case`, e.g. `"claude_local"`, `"my_tool"`. This value is stored in the agent's `adapterType` field in the database.

### Required: `execute(ctx)`

The core execution function. Paperclip calls this to run a heartbeat. You receive an `AdapterExecutionContext` and must return an `AdapterExecutionResult`.

### Required: `testEnvironment(ctx)`

Validates that the adapter's prerequisites are met (binary installed, API key present, working directory exists). Returns pass/warn/fail with diagnostic checks.

## Execution Context

The `execute` function receives:

```typescript
interface AdapterExecutionContext {
  runId: string; // Unique run identifier
  agent: {
    id: string;
    companyId: string;
    name: string;
    adapterType: string | null;
    adapterConfig: unknown; // Raw agent config from DB
  };
  runtime: {
    sessionId: string | null; // Legacy session ID
    sessionParams: Record<string, unknown> | null; // Session state from previous run
    sessionDisplayId: string | null; // Human-readable session ref
    taskKey: string | null; // Issue identifier, e.g. "PAP-42"
  };
  config: Record<string, unknown>; // Resolved adapter config
  context: Record<string, unknown>; // Execution context (workspace, env vars, etc.)
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>; // Stream logs to UI
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>; // Report invocation metadata
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>; // Report spawned process
  authToken?: string; // Paperclip JWT for the agent
}
```

### Key fields to use

| Field                       | Purpose                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `ctx.runId`                 | Pass to child processes as `PAPERCLIP_RUN_ID` env var         |
| `ctx.agent`                 | Agent identity — use for env vars and logging                 |
| `ctx.runtime.sessionParams` | Resume a previous session if your runtime supports it         |
| `ctx.config`                | Agent-specific configuration (model, cwd, env, etc.)          |
| `ctx.context`               | Server-provided context (prompt, workspace info, wake reason) |
| `ctx.onLog`                 | Stream stdout/stderr to the Paperclip UI in real time         |
| `ctx.authToken`             | Short-lived JWT the agent can use to call the Paperclip API   |

## Execution Result

Return this from `execute`:

```typescript
interface AdapterExecutionResult {
  // ── Required ──────────────────────────────────────
  exitCode: number | null; // Process exit code (0 = success)
  signal: string | null; // Signal that killed the process, if any
  timedOut: boolean; // Whether the run hit the timeout

  // ── Error reporting ───────────────────────────────
  errorMessage?: string | null;
  errorCode?: string | null;
  errorMeta?: Record<string, unknown>;

  // ── Session persistence ───────────────────────────
  sessionId?: string | null; // Legacy
  sessionParams?: Record<string, unknown> | null; // Opaque state for next run
  sessionDisplayId?: string | null; // Human-readable session ref
  clearSession?: boolean; // Force session reset

  // ── Billing / usage ───────────────────────────────
  provider?: string | null; // e.g. "anthropic", "openai"
  biller?: string | null;
  model?: string | null; // Model used for this run
  billingType?: AdapterBillingType | null;
  costUsd?: number | null; // Estimated cost
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };

  // ── Output ────────────────────────────────────────
  resultJson?: Record<string, unknown> | null; // Structured output
  summary?: string | null; // Human-readable summary
  runtimeServices?: AdapterRuntimeServiceReport[];
  question?: {
    // Interactive question for board
    prompt: string;
    choices: Array<{ key: string; label: string; description?: string }>;
  } | null;
}
```

### Session persistence

If your runtime supports session resumption (continuing a conversation across heartbeats):

1. On each run, check `ctx.runtime.sessionParams` for state from the previous run.
2. Return `sessionParams` in the result with whatever state you need to resume next time.
3. Return `sessionDisplayId` with a human-readable reference (e.g., the CLI session ID).
4. Return `clearSession: true` to force a fresh session on the next run.

## Environment Testing

The `testEnvironment` function validates prerequisites:

```typescript
interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  deployment?: {
    mode?: "local_trusted" | "authenticated";
    exposure?: "private" | "public";
    bindHost?: string | null;
    allowedHostnames?: string[];
  };
}

interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: Array<{
    code: string; // Machine-readable check ID
    level: "info" | "warn" | "error";
    message: string; // Human-readable result
    detail?: string | null;
    hint?: string | null; // Suggested fix
  }>;
  testedAt: string; // ISO timestamp
}
```

Common checks to implement:

- **Command exists**: Is the CLI binary installed and on PATH?
- **Working directory**: Does the configured `cwd` exist and is it accessible?
- **API key**: Is the required API key set in the environment?
- **Version**: Is the installed version compatible?

## Minimal Example: Built-in Adapter

The simplest adapter is a built-in module in `server/src/adapters/`. Here's the complete `process` adapter as a reference:

### `server/src/adapters/my-adapter/index.ts`

```typescript
import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const myAdapter: ServerAdapterModule = {
  type: "my_adapter",
  execute,
  testEnvironment,
  models: [{ id: "default", label: "Default Model" }],
  agentConfigurationDoc: `# my_adapter agent configuration

Adapter: my_adapter

Core fields:
- command (string, required): path to the CLI binary
- cwd (string, optional): working directory
- apiKey (string, optional): API key for authentication
- model (string, optional): model to use
`,
};
```

### `server/src/adapters/my-adapter/execute.ts`

```typescript
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, parseObject, buildPaperclipEnv, runChildProcess } from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  // 1. Extract configuration
  const command = asString(config.command, "my-tool");
  const cwd = asString(config.cwd, process.cwd());
  const model = asString(config.model, "default");

  // 2. Build environment variables
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent), // Injects PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, etc.
  };

  // Add custom env from config
  const envConfig = parseObject(config.env);
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  // 3. Build command arguments
  const args: string[] = [];

  // Add the prompt from context
  const prompt = asString(context.prompt, "");
  if (prompt) args.push("--prompt", prompt);
  if (model) args.push("--model", model);

  // 4. Report invocation metadata (shown in Paperclip UI)
  if (onMeta) {
    await onMeta({
      adapterType: "my_adapter",
      command,
      cwd,
      commandArgs: args,
    });
  }

  // 5. Run the process
  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec: asNumber(config.timeoutSec, 0),
    graceSec: asNumber(config.graceSec, 15),
    onLog,
  });

  // 6. Return the result
  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    errorMessage: proc.exitCode !== 0 ? `Process exited with code ${proc.exitCode}` : null,
    model,
    provider: "my-provider",
  };
}
```

### `server/src/adapters/my-adapter/test.ts`

```typescript
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "../types.js";
import { asString, parseObject, ensureAbsoluteDirectory, ensureCommandResolvable } from "../utils.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "my-tool");
  const cwd = asString(config.cwd, process.cwd());

  // Check working directory
  try {
    await ensureAbsoluteDirectory(cwd);
    checks.push({ code: "cwd_valid", level: "info", message: `Working directory: ${cwd}` });
  } catch {
    checks.push({ code: "cwd_invalid", level: "error", message: "Invalid working directory", detail: cwd });
  }

  // Check command is resolvable
  try {
    await ensureCommandResolvable(command, cwd);
    checks.push({ code: "command_found", level: "info", message: `Found: ${command}` });
  } catch {
    checks.push({
      code: "command_missing",
      level: "error",
      message: `Command not found: ${command}`,
      hint: "Install my-tool: npm install -g my-tool",
    });
  }

  const status = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return { adapterType: ctx.adapterType, status, checks, testedAt: new Date().toISOString() };
}
```

### Register in `registry.ts`

```typescript
import { myAdapter } from "./my-adapter/index.js";

// Add to the adaptersByType map:
const adaptersByType = new Map<string, ServerAdapterModule>(
  [
    // ... existing adapters ...
    myAdapter,
  ].map((a) => [a.type, a]),
);
```

## Full-Featured External Adapter Package

For adapters that need UI log parsing, CLI output formatting, and skill management, create an external package.

### Package structure

```
packages/adapters/my-adapter/
├── package.json
├── tsconfig.json
├── skills/                        # Optional: bundled skill definitions
│   └── paperclip/
│       └── SKILL.md
└── src/
    ├── index.ts                   # Main export: type, models, agentConfigurationDoc
    ├── server/
    │   ├── index.ts               # Server exports: execute, testEnvironment, etc.
    │   ├── execute.ts             # Execution logic
    │   ├── test.ts                # Environment testing
    │   └── skills.ts              # Optional: skill list/sync
    ├── ui/
    │   └── index.ts               # UI export: stdout line parser for transcript
    └── cli/
        └── index.ts               # CLI export: formatStdoutEvent for terminal
```

### `package.json`

```json
{
  "name": "@paperclipai/adapter-my-adapter",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server/index.ts",
    "./ui": "./src/ui/index.ts",
    "./cli": "./src/cli/index.ts"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/adapter-utils": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3"
  }
}
```

### Entry points

**`src/index.ts`** — metadata and config docs (imported by UI and server):

```typescript
import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "my_adapter";
export const label = "My Adapter";

export const models: AdapterModel[] = [
  { id: "model-v1", label: "Model v1" },
  { id: "model-v2", label: "Model v2 (latest)" },
];

export const agentConfigurationDoc = `# my_adapter agent configuration

Adapter: my_adapter

Core fields:
- cwd (string, optional): default working directory
- model (string, optional): model id (default: model-v2)
- apiKey (string, optional): API key (or set MY_ADAPTER_API_KEY env var)
`;
```

**`src/server/index.ts`** — server-side exports:

```typescript
export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listSkills, syncSkills } from "./skills.js"; // if supported
```

**`src/ui/index.ts`** — parse stdout lines into transcript entries for the board UI:

```typescript
import type { StdoutLineParser, TranscriptEntry } from "@paperclipai/adapter-utils";

export const parseStdoutLine: StdoutLineParser = (line: string, ts: string): TranscriptEntry[] => {
  // Parse your adapter's stdout format into TranscriptEntry objects.
  // The UI renders these as a conversation transcript.
  try {
    const event = JSON.parse(line);
    if (event.type === "assistant") {
      return [{ kind: "assistant", ts, text: event.content }];
    }
    if (event.type === "tool_call") {
      return [{ kind: "tool_call", ts, name: event.name, input: event.input }];
    }
  } catch {
    // Not JSON — treat as plain text
  }
  return [{ kind: "stdout", ts, text: line }];
};
```

**`src/cli/index.ts`** — format stdout events for terminal display:

```typescript
import type { CLIAdapterModule } from "@paperclipai/adapter-utils";

export const cliModule: CLIAdapterModule = {
  type: "my_adapter",
  formatStdoutEvent(line: string, debug: boolean): void {
    // Format and print to console for `paperclipai heartbeat run` CLI output.
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant") {
        process.stdout.write(event.content);
      } else if (debug) {
        console.log("[debug]", line);
      }
    } catch {
      process.stdout.write(line);
    }
  },
};
```

## Session Management

For adapters whose runtimes support continuing conversations across runs:

### Session codec

A `sessionCodec` normalizes the session state stored between runs:

```typescript
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  // Deserialize raw DB value into structured params
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    return {
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
      cwd: typeof obj.cwd === "string" ? obj.cwd : null,
    };
  },

  // Serialize params for DB storage
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    return { sessionId: params.sessionId, cwd: params.cwd };
  },

  // Human-readable session label for UI
  getDisplayId(params: Record<string, unknown> | null): string | null {
    return (params?.sessionId as string) ?? null;
  },
};
```

### Session compaction

Register your adapter's session management policy in `packages/adapter-utils/src/session-compaction.ts`:

```typescript
{
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",  // or "unknown"
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 200,          // Rotate after N runs
    maxRawInputTokens: 500_000,   // Rotate after N input tokens
    maxSessionAgeHours: 48,       // Rotate after N hours
  },
}
```

- `nativeContextManagement: "confirmed"` — the runtime handles its own context window (e.g., Claude Code). Paperclip will not force rotation.
- `nativeContextManagement: "unknown"` — Paperclip may rotate sessions based on the compaction policy to prevent context overflow.

## Skill Management

If your adapter's runtime supports skill files (markdown instructions injected into the agent), implement `listSkills` and `syncSkills`:

```typescript
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";

export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  // Discover currently installed skills in the runtime's skill directory
  const skillDir = path.join(homeDir, ".my-tool/skills");
  // ... scan directory, build entries ...

  return {
    adapterType: ctx.adapterType,
    supported: true,
    mode: "ephemeral", // or "persistent"
    desiredSkills: [],
    entries: [
      /* ... AdapterSkillEntry[] ... */
    ],
    warnings: [],
  };
}

export async function syncSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  // Install/remove skills to match the desired set.
  // Most adapters use symlinks from the Paperclip skill source to the runtime's skill directory.
  // ...
  return listSkills(ctx);
}
```

Skill sync modes:

- `"ephemeral"` — skills are symlinked before each run and cleaned up after (most adapters use this).
- `"persistent"` — skills are installed once and remain until explicitly removed.
- `"unsupported"` — adapter does not support skills.

## Adapter Utilities

The `@paperclipai/adapter-utils` package and `server/src/adapters/utils.ts` provide helpers:

| Utility                                   | Purpose                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| `buildPaperclipEnv(agent)`                | Build standard `PAPERCLIP_*` env vars from agent identity |
| `runChildProcess(runId, cmd, args, opts)` | Spawn a child process with log streaming and timeout      |
| `asString(val, default)`                  | Safely extract string from config                         |
| `asNumber(val, default)`                  | Safely extract number from config                         |
| `asStringArray(val)`                      | Safely extract string array from config                   |
| `parseObject(val)`                        | Safely parse unknown to `Record<string, unknown>`         |
| `ensureAbsoluteDirectory(path)`           | Validate directory exists                                 |
| `ensureCommandResolvable(cmd, cwd, env?)` | Validate command is on PATH                               |
| `redactEnvForLogs(env)`                   | Redact sensitive env vars for metadata reporting          |

## Paperclip Environment Variables

Adapters should inject these env vars into the agent process (use `buildPaperclipEnv`):

| Variable                    | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `PAPERCLIP_AGENT_ID`        | Agent's UUID                                     |
| `PAPERCLIP_COMPANY_ID`      | Company UUID                                     |
| `PAPERCLIP_RUN_ID`          | Current run UUID                                 |
| `PAPERCLIP_API_URL`         | Paperclip API base URL                           |
| `PAPERCLIP_API_KEY`         | Short-lived JWT for API access                   |
| `PAPERCLIP_TASK_ID`         | Issue ID that triggered this run (if applicable) |
| `PAPERCLIP_WAKE_REASON`     | Why this run was triggered                       |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this run (if applicable)  |

## Testing Your Adapter

### Environment test

```bash
# Via the Paperclip board UI: Agent Settings → Test Environment
# Or via CLI:
pnpm paperclipai agent test-env --agent-id <agent-id>
```

### Manual heartbeat

```bash
# Trigger a single heartbeat run for your agent:
pnpm paperclipai heartbeat run --agent-id <agent-id>
```

### Integration checklist

- [ ] `execute()` returns `exitCode: 0` on success
- [ ] Logs stream to UI via `onLog()` in real time
- [ ] `testEnvironment()` catches missing binary / bad config
- [ ] Session params round-trip correctly across runs (if applicable)
- [ ] `PAPERCLIP_*` env vars are injected into the agent process
- [ ] `agentConfigurationDoc` accurately describes all config fields
- [ ] Adapter is registered in `registry.ts`
- [ ] Agent can call Paperclip API using `authToken` / `PAPERCLIP_API_KEY`

## Existing Adapters Reference

| Adapter          | Type               | Transport       | Session | Skills | Description             |
| ---------------- | ------------------ | --------------- | ------- | ------ | ----------------------- |
| Claude Local     | `claude_local`     | Process (CLI)   | Yes     | Yes    | Claude Code CLI         |
| Codex Local      | `codex_local`      | Process (CLI)   | Yes     | Yes    | OpenAI Codex CLI        |
| Cursor Local     | `cursor`           | Process (CLI)   | Yes     | Yes    | Cursor Agent CLI        |
| Gemini Local     | `gemini_local`     | Process (CLI)   | Yes     | Yes    | Google Gemini CLI       |
| OpenCode Local   | `opencode_local`   | Process (CLI)   | Yes     | Yes    | Multi-provider OpenCode |
| Pi Local         | `pi_local`         | Process (CLI)   | Yes     | Yes    | Pi AI coding agent      |
| Hermes Local     | `hermes_local`     | Process (CLI)   | Yes     | No     | Hermes agent            |
| OpenClaw Gateway | `openclaw_gateway` | WebSocket       | Yes     | No     | Remote agent gateway    |
| Process          | `process`          | Process (shell) | No      | No     | Generic shell command   |
| HTTP             | `http`             | HTTP POST       | No      | No     | Webhook invocation      |

Use the `process` adapter as a minimal starting point and `claude_local` as a reference for a full-featured implementation.
