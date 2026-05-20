# Spec: Hermes Agent Isolation & Default Configuration

## Problem

When multiple `hermes_local` agents run on the same Paperclip instance, they share:
- The same `HERMES_HOME` directory (`~/.hermes`)
- The same working directory (server root `.`)
- The same session database (`~/.hermes/state.db`)
- The same skills directory

This causes:
1. Session contamination between agents
2. File conflicts when agents work simultaneously
3. No isolation of git configs, SSH keys, or tool configs per agent
4. Debugging difficulty — all logs mixed together

## Solution

Automatically configure per-agent isolation when creating `hermes_local` agents:

### 1. Per-Agent Workspace Directory

Create a dedicated workspace for each Hermes agent:

```
~/.paperclip/instances/default/workspaces/hermes/<agent-id>/
  ├── sessions/       # Hermes session DB (state.db)
  ├── skills/         # Agent-specific skills
  ├── cache/          # Hermes cache
  └── home/           # Subprocess HOME (git, ssh, gh configs)
```

### 2. Automatic Environment Injection

When the `hermes_local` adapter executes, automatically inject these env vars if not explicitly set by the user:

| Env Var | Value | Purpose |
|---------|-------|---------|
| `HERMES_HOME` | `~/.paperclip/instances/default/workspaces/hermes/<agent-id>` | Isolates sessions, skills, cache |
| `HOME` | `~/.paperclip/instances/default/workspaces/hermes/<agent-id>/home` | Isolates git, ssh, gh configs |

### 3. Automatic Working Directory

Set `cwd` to the agent's workspace directory so all file operations are isolated by default.

### 4. Implementation

#### File: `server/src/adapters/registry.ts`

In the `hermesLocalAdapter.execute` function, before calling `executeHermesLocal`:

```typescript
const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);
    if (!normalizedCtx.authToken) return executeHermesLocal(normalizedCtx);

    const existingConfig = (normalizedCtx.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const existingEnv =
      typeof existingConfig.env === "object" && existingConfig.env !== null && !Array.isArray(existingConfig.env)
        ? (existingConfig.env as Record<string, string>)
        : {};

    // ── Auto-isolate Hermes agents ──────────────────────────────────────
    const agentId = ctx.agent?.id ?? "";
    const hermesHome = existingEnv.HERMES_HOME
      ?? `${process.env.PAPERCLIP_HOME ?? "~/.paperclip"}/instances/default/workspaces/hermes/${agentId}`;
    const subprocessHome = existingEnv.HOME
      ?? `${hermesHome}/home`;

    // Ensure directories exist
    await fs.promises.mkdir(hermesHome, { recursive: true });
    await fs.promises.mkdir(subprocessHome, { recursive: true });

    const isolatedEnv = {
      ...existingEnv,
      HERMES_HOME: hermesHome,
      HOME: subprocessHome,
    };

    const isolatedConfig = {
      ...existingConfig,
      env: isolatedEnv,
      cwd: existingConfig.cwd ?? hermesHome,
    };

    // ... rest of existing logic using isolatedConfig
  },
};
```

#### File: `packages/shared/src/validators/agent.ts`

Add to the Hermes adapter config schema:

```typescript
const hermesIsolationSchema = z.object({
  enabled: z.boolean().default(true),
  hermesHome: z.string().optional(),
  subprocessHome: z.string().optional(),
});

// In adapterConfigSchema for hermes_local:
z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  isolation: hermesIsolationSchema.optional(),
  // ... existing fields
})
```

### 5. Migration Path

For existing agents:
1. On first heartbeat after upgrade, detect shared `HERMES_HOME`
2. Auto-migrate: create per-agent directory, copy relevant sessions
3. Log migration event in activity log

### 6. User Override

Users can still override isolation by explicitly setting:
- `adapterConfig.env.HERMES_HOME` — custom Hermes home
- `adapterConfig.env.HOME` — custom subprocess home
- `adapterConfig.cwd` — custom working directory

### 7. OpenCode Agents (Implemented)

For `opencode_local` agents, similar isolation is configured:

```
~/.paperclip/instances/default/workspaces/opencode/<agent-id>/
  ├── sessions/
  └── cache/
```

Set via `adapterConfig.env.OPENCODE_HOME` and `adapterConfig.cwd` in the registry wrapper at `server/src/adapters/registry.ts`.

## Acceptance Criteria

- [x] New `hermes_local` agents automatically get isolated `HERMES_HOME`
- [x] New `hermes_local` agents automatically get isolated `cwd`
- [x] Existing agents migrate on first heartbeat
- [x] User can override isolation via `adapterConfig.env`
- [ ] Activity log records isolation setup
- [x] OpenCode agents get isolated `OPENCODE_HOME` and `cwd`
- [x] Works with both local and Docker deployments
