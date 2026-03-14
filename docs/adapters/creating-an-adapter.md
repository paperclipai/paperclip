---
title: Creating an Adapter
summary: Guide to building a custom adapter
---

Build a custom adapter to connect Paperclip to any agent runtime.

<Tip>
If you're using Claude Code, the `.agents/skills/create-agent-adapter` skill can guide you through the full adapter creation process interactively. Just ask Claude to create a new adapter and it will walk you through each step.
</Tip>

## Package Structure

```
packages/adapters/<name>/
  package.json
  tsconfig.json
  src/
    index.ts            # Shared metadata
    server/
      index.ts          # Server exports
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      index.ts          # UI exports
      parse-stdout.ts   # Transcript parser
      build-config.ts   # Config builder
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
```

## Step 2: Server Execute

`src/server/execute.ts` is the core. It receives an `AdapterExecutionContext` and returns an `AdapterExecutionResult`.

Key responsibilities:

1. Read config using safe helpers (`asString`, `asNumber`, etc.)
2. Build environment with `buildPaperclipEnv(agent)` plus context vars
3. Resolve session state from `runtime.sessionParams`
4. Render prompt with `renderTemplate(template, data)`
5. Spawn the process with `runChildProcess()` or call via `fetch()`
6. Parse output for usage, costs, session state, errors
7. Handle unknown session errors (retry fresh, set `clearSession: true`)

## Step 3: Environment Test

`src/server/test.ts` validates the adapter config before running.

Return structured diagnostics:

- `error` for invalid/unusable setup
- `warn` for non-blocking issues
- `info` for successful checks

## Step 4: UI Module

- `parse-stdout.ts` — converts stdout lines to `TranscriptEntry[]` for the run viewer
- `build-config.ts` — converts form values to `adapterConfig` JSON
- Config fields React component in `ui/src/adapters/<name>/config-fields.tsx`

## Step 5: CLI Module

`format-event.ts` — pretty-prints stdout for `paperclipai run --watch` using `picocolors`.

## Step 6: Register

Add the adapter to all three registries:

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

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
