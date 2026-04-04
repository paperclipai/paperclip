---
title: Creating an Adapter
summary: Guide to building a custom adapter
---

Build a custom adapter to connect Paperclip to any agent runtime.

<Tip>
If you're using Claude Code, the `.agents/skills/create-agent-adapter` skill can guide you through the full adapter creation process interactively. Just ask Claude to create a new adapter and it will walk you through each step.
</Tip>

## Two Paths

| | Built-in | External Plugin |
|---|---|---|
| Source | Inside `paperclip-fork` | Separate npm package |
| Distribution | Ships with Paperclip | Independent npm publish |
| UI parser | Static import | Dynamic load from API |
| Registration | Edit 3 registries | Auto-loaded at startup |
| Best for | Core adapters, contributors | Third-party adapters, internal tools |

For most cases, **build an external adapter plugin**. It's cleaner, independently versioned, and doesn't require modifying Paperclip's source. See [External Adapters](/adapters/external-adapters) for the full guide.

The rest of this page covers the shared internals that both paths use.

## Package Structure

```
packages/adapters/<name>/    # built-in
  ── or ──
my-adapter/                   # external plugin
  package.json
  tsconfig.json
  src/
    index.ts            # Shared metadata
    server/
      index.ts          # Server exports (createServerAdapter)
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      index.ts          # UI exports (built-in only)
      parse-stdout.ts   # Transcript parser (built-in only)
      build-config.ts   # Config builder
    ui-parser.ts        # Self-contained UI parser (external — see [UI Parser Contract](/adapters/adapter-ui-parser))
    cli/
      index.ts          # CLI exports
      format-event.ts   # Terminal formatter
```

## Step 1: Root Metadata

`src/index.ts` is imported by all three consumers. Keep it dependency-free.

```ts
export const type = "my_agent";        // snake_case, globally unique
export const label = "My Agent (local)";
export const models = [
  { id: "model-a", label: "Model A" },
];
export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;

// Required for external adapters (plugin-loader convention)
export { createServerAdapter } from "./server/index.js";
```

## Step 2: Server Execute

`src/server/execute.ts` is the core. It receives an `AdapterExecutionContext` and returns an `AdapterExecutionResult`.

Key responsibilities:

1. Read config using safe helpers (`asString`, `asNumber`, etc.) from `@paperclipai/adapter-utils/server-utils`
2. Build environment with `buildPaperclipEnv(agent)` plus context vars
3. Resolve session state from `runtime.sessionParams`
4. Render prompt with `renderTemplate(template, data)`
5. Spawn the process with `runChildProcess()` or call via `fetch()`
6. Parse output for usage, costs, session state, errors
7. Handle unknown session errors (retry fresh, set `clearSession: true`)

### Available Helpers

| Helper | Source | Purpose |
|--------|--------|---------|
| `runChildProcess(cmd, opts)` | `@paperclipai/adapter-utils/server-utils` | Spawn with timeout, grace, streaming |
| `buildPaperclipEnv(agent)` | `@paperclipai/adapter-utils/server-utils` | Inject `PAPERCLIP_*` env vars |
| `renderTemplate(tpl, data)` | `@paperclipai/adapter-utils/server-utils` | `{{variable}}` substitution |
| `asString(v)` | `@paperclipai/adapter-utils` | Safe config value extraction |
| `asNumber(v)` | `@paperclipai/adapter-utils` | Safe number extraction |

### AdapterExecutionContext

```ts
interface AdapterExecutionContext {
  runId: string;
  agent: { id: string; companyId: string; name: string; adapterConfig: unknown };
  runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null };
  config: Record<string, unknown>;      // agent's adapterConfig
  context: Record<string, unknown>;      // task, wake reason, etc.
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}
```

### AdapterExecutionResult

```ts
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  sessionParams?: Record<string, unknown> | null;  // persist across heartbeats
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  clearSession?: boolean;  // set true to force fresh session on next wake
}
```

## Step 3: Environment Test

`src/server/test.ts` validates the adapter config before running.

Return structured diagnostics:

| Level | Meaning | Effect |
|-------|---------|--------|
| `error` | Invalid or unusable setup | Blocks execution |
| `warn` | Non-blocking issue | Shown with yellow indicator |
| `info` | Successful check | Shown in test results |

```ts
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: ctx.adapterType,
    status: "pass",  // "pass" | "warn" | "fail"
    checks: [
      { level: "info", message: "CLI v1.2.0 detected", code: "cli_detected" },
      { level: "warn", message: "No API key found", hint: "Set ANTHROPIC_API_KEY", code: "no_key" },
    ],
    testedAt: new Date().toISOString(),
  };
}
```

## Step 4: UI Module (Built-in Only)

For built-in adapters registered in Paperclip's source:

- `parse-stdout.ts` — converts stdout lines to `TranscriptEntry[]` for the run viewer
- `build-config.ts` — converts form values to `adapterConfig` JSON
- Config fields React component in `ui/src/adapters/<name>/config-fields.tsx`

For external adapters, use a self-contained `ui-parser.ts` instead. See the [UI Parser Contract](/adapters/adapter-ui-parser).

## Step 5: CLI Module

`format-event.ts` — pretty-prints stdout for `paperclipai run --watch` using `picocolors`.

```ts
export function formatStdoutEvent(line: string, debug: boolean): void {
  if (line.startsWith("[tool-done]")) {
    console.log(chalk.green(`  ✓ ${line}`));
  } else {
    console.log(`  ${line}`);
  }
}
```

## Step 6: Register (Built-in Only)

Add the adapter to all three registries:

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

For external adapters, registration is automatic — the plugin loader handles it.

## Session Persistence

If your agent runtime supports conversation continuity across heartbeats:

1. Return `sessionParams` from `execute()` (e.g., `{ sessionId: "abc123" }`)
2. Read `runtime.sessionParams` on the next wake to resume
3. Optionally implement a `sessionCodec` for validation and display

```ts
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) { /* validate raw session data */ },
  serialize(params) { /* serialize for storage */ },
  getDisplayId(params) { /* human-readable session label */ },
};
```

## Skills Injection

Make Paperclip skills discoverable to your agent runtime without writing to the agent's working directory:

1. **Best: tmpdir + flag** — create tmpdir, symlink skills, pass via CLI flag, clean up after
2. **Acceptable: global config dir** — symlink to the runtime's global plugins directory
3. **Acceptable: env var** — point a skills path env var at the repo's `skills/` directory
4. **Last resort: prompt injection** — include skill content in the prompt template

## Security

- Treat agent output as untrusted (parse defensively, never execute)
- Inject secrets via environment variables, not prompts
- Configure network access controls if the runtime supports them
- Always enforce timeout and grace period
- The UI parser module runs in a browser sandbox — zero runtime imports, no side effects

## Next Steps

- [External Adapters](/adapters/external-adapters) — build a standalone adapter plugin
- [UI Parser Contract](/adapters/adapter-ui-parser) — ship a custom run-log parser
- [How Agents Work](/guides/agent-developer/how-agents-work) — the heartbeat lifecycle
