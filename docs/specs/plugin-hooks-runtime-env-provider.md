# Runtime Env Provider plugin hook (MYO-80)

> **Status — Phase 1c.** The hook surface is registered alongside the
> wake-payload and skill-resolver hooks shipped in MYO-62. No call-site in
> core uses it yet (MYO-76 Phase 1B is the planned first consumer in
> `claude_local`). The registry surface is safe to merge in isolation.

## Why

Each new adapter that needs to inject per-run environment variables today
forks core: `claude_local` for Git identity, `codex_local` for the OpenAI
key, OpenClaw for whatever credential bundle a future runtime exposes. The
core-patch authorization template (`MYO-24` → `MYO-50` → `MYO-62`) was
designed exactly to absorb these one-offs into a hook the next adapter can
reuse without touching core. `runtimeEnvProvider` is the hook for per-run
env / runtime files.

## Surface

```ts
// server/src/services/plugin-hooks/types.ts
export interface RuntimeEnvProviderContext {
  readonly issue: PluginHookIssueContext;
  readonly agentId: string;
  readonly agentRole?: string;
  readonly companyId: string;
  readonly runId: string;
  readonly adapterType: string;
  readonly adapterConfig: Readonly<Record<string, unknown>>;
}

export interface RuntimeFileSpec {
  readonly path: string;     // relative to <runDir>; absolute / .. paths rejected
  readonly content: string;
  readonly mode?: number;    // POSIX octal, defaults to 0o600
}

export interface RuntimeEnvProviderResult {
  readonly env: Readonly<Record<string, string>>;
  readonly runtimeFiles?: readonly RuntimeFileSpec[];
}

export type RuntimeEnvProvider = (
  current: RuntimeEnvProviderResult,
  context: RuntimeEnvProviderContext,
) => Promise<RuntimeEnvProviderResult> | RuntimeEnvProviderResult;
```

The chain is invoked once per heartbeat, **before** the adapter spawns the
agent process:

```ts
import { applyRuntimeEnvProviderHooks } from "@paperclipai/server/services/plugin-hooks";

const { env, runtimeFiles } = await applyRuntimeEnvProviderHooks(registry, {
  issue,
  agentId,
  agentRole,
  companyId,
  runId,
  adapterType: "claude_local",
  adapterConfig,
});

// Adapter then merges `env` into the spawned process env and writes
// runtimeFiles into <runDir>/<path>.
```

## Semantics

| Concern | Behaviour |
| --- | --- |
| Default budget | `DEFAULT_RUNTIME_ENV_BUDGET_MS = 200`. Wider than wake/skill (50 / 20 ms) because providers may legitimately fetch a fresh PAT. |
| Per-handler timeout | `10 × budget` by default; configurable via `ApplyOptions.perHandlerTimeoutMs`. |
| Order | Priority asc, deterministic insertion seq tie-break. Same as the other hooks. |
| Conflicts (env) | Last-write-wins by priority order. |
| Conflicts (files) | Keyed by `path`, last-write-wins by priority order. |
| Predicate gating | Standard `when` predicates supported (`issueFieldEquals`, `agentRoleEquals`, `all/any/not`). |
| Empty registry | Returns `EMPTY_RUNTIME_ENV_RESULT` (frozen, shared). |
| Bad env key | Drops the entire hook return with `handler_returned_invalid` telemetry. Other hooks continue. |
| Bad file path (absolute, `..`, drive letter, NUL) | Drops that file with a `runtime_file_rejected` telemetry record. Other files in the same return are kept. |
| File mode | Defaults to `0o600`; explicit modes are clamped to the 12 POSIX bits. |

### Why the env-key validation is strict

Spawn implementations on Windows, macOS and Linux all disagree on what
characters they tolerate in env names. `[A-Za-z_][A-Za-z0-9_]*` is the
POSIX-portable subset. A plugin that ships a non-portable key is broken on
some platforms; we'd rather refuse it loudly with telemetry than ship a
partially-working credential to the spawned process.

### Why the path validation is strict

`<runDir>/<path>` is a host-controlled write. Any traversal lets a plugin
write arbitrary files into the host filesystem (`/etc/passwd`,
`~/.ssh/authorized_keys`). The validator rejects:

- absolute POSIX paths (`/...`)
- absolute Windows paths (`C:\...`, `\\...`)
- any segment equal to `.` or `..`
- any segment containing `\0`

Rejections are emitted to `onError({ reason: "runtime_file_rejected" })`
so plugin authors see them in the dev/CI log.

## Example plugin: `gh-identity-provider`

A plugin that resolves a per-agent GitHub PAT from a secret store and
exposes it as `GH_TOKEN` + the matching git author identity:

```ts
// packages/plugins/examples/plugin-gh-identity-provider/src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { resolveGitIdentity } from "./resolve.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("gh-identity-provider ready");
  },
  hooks: {
    runtimeEnvProvider: async (_current, context) => {
      const identity = await resolveGitIdentity({
        agentId: context.agentId,
        companyId: context.companyId,
        adapterType: context.adapterType,
      });
      if (!identity) return { env: {} };
      return {
        env: {
          GH_TOKEN: identity.token,
          GIT_AUTHOR_NAME: identity.userName,
          GIT_AUTHOR_EMAIL: identity.userEmail,
          GIT_COMMITTER_NAME: identity.userName,
          GIT_COMMITTER_EMAIL: identity.userEmail,
          GIT_CONFIG_GLOBAL: ".gitconfig",
        },
        runtimeFiles: [
          {
            path: ".gitconfig",
            content: `[user]\n  name = ${identity.userName}\n  email = ${identity.userEmail}\n`,
            mode: 0o600,
          },
        ],
      };
    },
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

> The `hooks.runtimeEnvProvider` field on `definePlugin()` is part of the
> SDK surface that lands with MYO-61. Until MYO-61 is merged, plugins
> register through the registry directly via
> `registry.register({ kind: "runtimeEnvProvider", … })` (see the
> `__tests__/plugin-hooks-runtime-env.test.ts` for working snippets).

## Predicate cookbook

Restrict a hook to a single adapter type:

```ts
{
  when: { issueFieldEquals: { field: "adapterType", value: "claude_local" } },
}
```

Only run for engineer-role agents in fast-action mode:

```ts
{
  when: {
    all: [
      { agentRoleEquals: "engineer" },
      { issueFieldEquals: { field: "fastAction", value: true } },
    ],
  },
}
```

## Phase plan

| Phase | Deliverable | Issue |
| --- | --- | --- |
| 1c | Hook surface in registry/apply, types, tests, docs | **MYO-80 (this PR)** |
| 2 | Wire `applyRuntimeEnvProviderHooks` into the adapter spawn flow (`packages/adapters/*/src/server/execute.ts`) | follow-up |
| 3 | Migrate `claude_local` Git identity injection (Phase 1B) onto the hook so it stops being adapter-specific | follow-up of MYO-76 |
| 4 | SDK exposure on `definePlugin({ hooks })` | merges with MYO-61 |
| 5 | First-party `gh-identity-provider` example plugin | follow-up |

## Acceptance traceability

- [x] Hook `runtimeEnvProvider` registrable via the MYO-62 registry —
  `register({ kind: "runtimeEnvProvider", ... })` and
  `registerManifestEntries({ declarations: { runtimeEnvProvider: ... } })`.
- [ ] `claude_local` consumes the hook instead of inline logic — *deferred
  to the Phase 2 wiring follow-up; safe in isolation since no call-site in
  core uses the hook yet.*
- [x] Plugin authoring doc updated with the hook — this file.
- [x] Integration test: plugin registers a provider that injects `FOO=bar`
  → exposed in the merged result. See
  `server/src/__tests__/plugin-hooks-runtime-env.test.ts` —
  *registers and merges env from a single hook (FOO=bar acceptance)*.
- [x] No future adapter needs to patch core to carry per-run env — once
  Phase 2 lands the hook in the spawn flow, codex_local / OpenClaw / future
  adapters can stay vanilla.
