# MCP Propagation through claude_local — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Paperclip propagate per-agent MCP server definitions (Linear and others) to claude_local heartbeats, with the Linear API key behind the encrypted secret store instead of plaintext on disk.

**Architecture:** Per-agent `adapterConfig.mcpServers` (mirroring Claude Code's `.claude.json` shape). The adapter writes an ephemeral `mcp-config.json` at run start and passes `--mcp-config <path>` to the `claude` CLI. Secret refs in `mcpServers.*.env` are resolved by extending the existing `secretService.normalizeAdapterConfigForPersistence` recursion. No new tables, no new routes, no UI changes.

**Tech Stack:** TypeScript, zod, Drizzle ORM (read-only here), Vitest. Files in `/app/packages/shared`, `/app/packages/adapters/claude-local`, `/app/server/src/services/secrets.ts`.

**Spec:** `docs/superpowers/specs/2026-05-07-mcp-propagation-claude-local-design.md`

**Parent issue:** SUP-18

---

## File map

**Create:**
- `/app/packages/shared/src/validators/__tests__/agent-mcp-servers.test.ts` — validator unit tests
- `/app/server/src/services/__tests__/secrets-mcp-normalization.test.ts` — secret recursion unit tests
- `/app/packages/adapters/claude-local/src/server/__tests__/mcp-config.test.ts` — adapter args + file writing tests
- `/app/packages/adapters/claude-local/src/server/mcp-config.ts` — extracted helper that builds + writes the mcp-config file

**Modify:**
- `/app/packages/shared/src/validators/agent.ts` (~ lines 30-60) — add `mcpServersSchema` and merge into the claude_local adapter config schema
- `/app/server/src/services/secrets.ts` (~ line 341 and the recursion helper) — recurse into `mcpServers.*.env` and `.headers`
- `/app/packages/adapters/claude-local/src/server/execute.ts:606-700` — call the new helper in `buildClaudeArgs` and clean up afterwards
- `/app/docs/adapters/claude-local.md` — document the new `mcpServers` field with a `secret_ref` example

**No code (operator runbook only):**
- `docs/superpowers/runbooks/2026-05-07-linear-mcp-cutover.md` — exact curl commands for the cutover (create secret, patch agents, delete plaintext key, smoke)

---

## Conventions for this plan

- **TDD:** every change ships with the test that proves it. Test first, watch it fail, implement, watch it pass.
- **Commit cadence:** one commit per task. Use Conventional Commits.
- **Run tests with:** `pnpm --filter <package> test <pattern>` from `/app`.
- **Type-check with:** `pnpm --filter <package> typecheck`.
- **Branch:** `lead-engineer/sup-18-mcp-propagation` off `staging`.
- **No production code touches** until secrets recursion + adapter helper are both green in CI.

---

## Task 1 — Branch and dependencies sanity check

**Files:** none (just shell)

- [ ] **Step 1: Cut a feature branch**

```bash
cd /app
git fetch origin
git checkout staging
git pull --ff-only origin staging
git checkout -b lead-engineer/sup-18-mcp-propagation
```

- [ ] **Step 2: Confirm the four files we'll touch exist and look like the explore report**

```bash
test -f /app/packages/shared/src/validators/agent.ts
test -f /app/server/src/services/secrets.ts
test -f /app/packages/adapters/claude-local/src/server/execute.ts
test -f /app/docs/adapters/claude-local.md
```

Expected: all four `test` commands exit 0.

- [ ] **Step 3: Confirm `pnpm` workspace is healthy**

```bash
pnpm --filter @paperclip/shared typecheck
pnpm --filter @paperclip/adapter-claude-local typecheck
pnpm --filter @paperclip/server typecheck
```

Expected: all three pass with no errors. (Real package names may differ — use the names actually in `pnpm-workspace.yaml`. If different, prefer the existing scripts.)

- [ ] **Step 4: Snapshot run-time behavior** (helps you tell if you broke something later)

```bash
pnpm --filter @paperclip/adapter-claude-local test -- --run > /tmp/claude-local-baseline.txt 2>&1 || true
pnpm --filter @paperclip/server test -- --run > /tmp/server-baseline.txt 2>&1 || true
```

Expected: both files exist with the current pass/fail summary. We compare at the end.

- [ ] **Step 5: Commit the empty branch checkpoint** (optional — creates a clean PR base)

No code changes yet, so skip the commit. Move on.

---

## Task 2 — Validator: `mcpServers` schema (TDD)

**Files:**
- Create: `/app/packages/shared/src/validators/__tests__/agent-mcp-servers.test.ts`
- Modify: `/app/packages/shared/src/validators/agent.ts`

The shape mirrors Claude Code's `.claude.json`. Three transport types: `stdio`, `sse`, `http`. `env` (and `headers` for sse/http) reuse the existing `envBindingSchema` so `secret_ref` works out-of-the-box.

- [ ] **Step 1: Write the failing tests**

Create `/app/packages/shared/src/validators/__tests__/agent-mcp-servers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mcpServersSchema } from "../agent";

describe("mcpServersSchema", () => {
  it("accepts a stdio server with secret_ref env", () => {
    const result = mcpServersSchema.safeParse({
      linear: {
        type: "stdio",
        command: "mcp-linear",
        args: [],
        env: {
          LINEAR_API_KEY: {
            type: "secret_ref",
            secretId: "33333333-3333-4333-8333-333333333333",
            version: "latest",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a stdio server with plain string env (legacy compat)", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "stdio", command: "mcp-linear", args: [], env: { FOO: "bar" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an http server with header secret_ref", () => {
    const result = mcpServersSchema.safeParse({
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: {
          Authorization: {
            type: "secret_ref",
            secretId: "33333333-3333-4333-8333-333333333333",
            version: "latest",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a stdio server missing command", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "stdio", args: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an http server missing url", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "http", headers: {} },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown transport type", () => {
    const result = mcpServersSchema.safeParse({
      linear: { type: "websocket", url: "ws://x" },
    });
    expect(result.success).toBe(false);
  });

  it("allows an empty mcpServers object", () => {
    const result = mcpServersSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests; they fail because `mcpServersSchema` doesn't exist**

```bash
pnpm --filter @paperclip/shared test -- --run agent-mcp-servers
```

Expected: FAIL with "Cannot find module" or "mcpServersSchema is not defined".

- [ ] **Step 3: Implement the schema**

Open `/app/packages/shared/src/validators/agent.ts`. Find `envConfigSchema` (or whatever the existing env-with-`secret_ref` schema is called — confirm the exact name by reading the file; the explore report referenced `envConfigSchema` and `secret_ref`).

Right above the claude_local `adapterConfigSchema`, add:

```typescript
const envBindingValueSchema = envConfigSchema.valueSchema;
// ^ if envConfigSchema is z.record(envBindingValueSchema), expose the inner type.
// If `envConfigSchema` is itself the record schema, replace with: const envBindingsRecord = envConfigSchema;

const mcpStdioServerSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: envConfigSchema.optional(),
});

const mcpSseServerSchema = z.object({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: envConfigSchema.optional(),
});

const mcpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: envConfigSchema.optional(),
});

const mcpServerSchema = z.discriminatedUnion("type", [
  mcpStdioServerSchema,
  mcpSseServerSchema,
  mcpHttpServerSchema,
]);

export const mcpServersSchema = z.record(z.string().min(1), mcpServerSchema);
```

Then in the claude_local adapter config superRefine (around lines 34-45), permit and validate `mcpServers`:

```typescript
// Inside the superRefine block where env is currently validated:
if (value.mcpServers !== undefined) {
  const parsed = mcpServersSchema.safeParse(value.mcpServers);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["mcpServers", ...issue.path],
      });
    }
  }
}
```

Note for the engineer: `envConfigSchema` semantics may differ slightly. If it doesn't exist as importable, search `/app/packages/shared/src/validators/` for the schema that validates `{ FOO: { type: "secret_ref", secretId, version } | string }` and reuse that. The point is: do NOT redefine `secret_ref` here — reuse.

- [ ] **Step 4: Run tests; they pass**

```bash
pnpm --filter @paperclip/shared test -- --run agent-mcp-servers
```

Expected: all 7 tests pass.

- [ ] **Step 5: Type-check the package**

```bash
pnpm --filter @paperclip/shared typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/agent.ts packages/shared/src/validators/__tests__/agent-mcp-servers.test.ts
git commit -m "feat(validators): add mcpServers schema for claude_local adapter

Reuses envConfigSchema so secret_ref works in mcpServers.*.env
and mcpServers.*.headers without redefining the binding shape.

Refs SUP-18"
```

---

## Task 3 — Secrets service: recurse into `mcpServers.*.env` and `.headers` (TDD)

**Files:**
- Create: `/app/server/src/services/__tests__/secrets-mcp-normalization.test.ts`
- Modify: `/app/server/src/services/secrets.ts` (around line 341 and the recursion helpers)

`normalizeAdapterConfigForPersistence` and the runtime resolution counterpart currently walk `adapterConfig.env` only. They must also walk `adapterConfig.mcpServers.*.env` and `adapterConfig.mcpServers.*.headers`. One central recursion entry point keeps both call sites consistent.

- [ ] **Step 1: Read the existing recursion helper**

Open `/app/server/src/services/secrets.ts`. Find:
- `normalizeAdapterConfigForPersistence` (around line 341 per the explore report)
- The runtime resolver (the function that converts `secret_ref` → real value before adapter execute)
- The shared private helper that walks `env` (if any)

Identify whether the recursion is inline in each function or factored. If factored, extend the factored helper. If inline, factor it out first as part of this task.

- [ ] **Step 2: Write the failing tests**

Create `/app/server/src/services/__tests__/secrets-mcp-normalization.test.ts`. The exact import surface depends on which functions are exported — match the existing tests in `/app/server/src/services/__tests__/secrets*.test.ts` (pattern, fixtures). Sketch:

```typescript
import { describe, expect, it } from "vitest";
import { secretService } from "../secrets";
// or whatever the factory / function is. Match existing test imports.

describe("secretService — mcpServers binding normalization", () => {
  it("normalizes a plain string env inside mcpServers.*.env", async () => {
    const svc = secretService(testDb);
    const config = {
      mcpServers: {
        linear: { type: "stdio", command: "mcp-linear", args: [], env: { FOO: "bar" } },
      },
    };
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, config);
    expect(out.mcpServers.linear.env.FOO).toEqual({ type: "plain", value: "bar" });
  });

  it("preserves a well-formed secret_ref inside mcpServers.*.env", async () => {
    const svc = secretService(testDb);
    const ref = { type: "secret_ref", secretId: existingSecretId, version: "latest" };
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, {
      mcpServers: { linear: { type: "stdio", command: "mcp-linear", env: { K: ref } } },
    });
    expect(out.mcpServers.linear.env.K).toEqual(ref);
  });

  it("rejects a secret_ref pointing at a different company's secret", async () => {
    const svc = secretService(testDb);
    const ref = { type: "secret_ref", secretId: otherCompanySecretId, version: "latest" };
    await expect(
      svc.normalizeAdapterConfigForPersistence(companyId, {
        mcpServers: { linear: { type: "stdio", command: "mcp-linear", env: { K: ref } } },
      }),
    ).rejects.toThrow();
  });

  it("resolves secret_ref inside mcpServers.*.env at runtime", async () => {
    const svc = secretService(testDb);
    const config = {
      mcpServers: {
        linear: {
          type: "stdio",
          command: "mcp-linear",
          env: { LINEAR_API_KEY: { type: "secret_ref", secretId, version: "latest" } },
        },
      },
    };
    const resolved = await svc.resolveBindingsForRuntime(companyId, config);
    expect(resolved.mcpServers.linear.env.LINEAR_API_KEY).toBe(plaintextValueOfSecret);
  });

  it("recurses into mcpServers.*.headers for sse/http transports", async () => {
    const svc = secretService(testDb);
    const config = {
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: { type: "secret_ref", secretId, version: "latest" } },
        },
      },
    };
    const resolved = await svc.resolveBindingsForRuntime(companyId, config);
    expect(resolved.mcpServers.linear.headers.Authorization).toBe(plaintextValueOfSecret);
  });

  it("does not touch top-level env when mcpServers also has env", async () => {
    const svc = secretService(testDb);
    const config = {
      env: { TOP: "level" },
      mcpServers: { linear: { type: "stdio", command: "mcp-linear", env: { K: "v" } } },
    };
    const out = await svc.normalizeAdapterConfigForPersistence(companyId, config);
    expect(out.env.TOP).toEqual({ type: "plain", value: "level" });
    expect(out.mcpServers.linear.env.K).toEqual({ type: "plain", value: "v" });
  });
});
```

Adjust setup (`testDb`, `companyId`, `secretId`, `plaintextValueOfSecret`) to match the existing test harness in `secrets*.test.ts`.

- [ ] **Step 3: Run tests; they fail**

```bash
pnpm --filter @paperclip/server test -- --run secrets-mcp-normalization
```

Expected: FAIL — recursion does not visit `mcpServers`.

- [ ] **Step 4: Extend the recursion**

In `secrets.ts`, find the helper that walks `env`. Refactor it (if needed) to accept a list of "binding paths to walk" or to also iterate `mcpServers.*.env` and `mcpServers.*.headers`. Sketch (adapt to actual code):

```typescript
async function walkBindings(
  config: Record<string, unknown>,
  visit: (binding: unknown, path: (string | number)[]) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const out = { ...config };

  if (out.env && typeof out.env === "object") {
    out.env = await visitEnvMap(out.env, visit, ["env"]);
  }

  if (out.mcpServers && typeof out.mcpServers === "object") {
    const servers = out.mcpServers as Record<string, Record<string, unknown>>;
    const newServers: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(servers)) {
      const next = { ...server };
      if (next.env && typeof next.env === "object") {
        next.env = await visitEnvMap(next.env, visit, ["mcpServers", name, "env"]);
      }
      if (next.headers && typeof next.headers === "object") {
        next.headers = await visitEnvMap(next.headers, visit, ["mcpServers", name, "headers"]);
      }
      newServers[name] = next;
    }
    out.mcpServers = newServers;
  }

  return out;
}
```

Have both `normalizeAdapterConfigForPersistence` and `resolveBindingsForRuntime` use this single walk function with their respective `visit` callbacks (one normalizes plain → `{type:"plain"}`, the other decrypts `secret_ref` → string).

- [ ] **Step 5: Run tests; they pass**

```bash
pnpm --filter @paperclip/server test -- --run secrets-mcp-normalization
```

Expected: all tests pass.

- [ ] **Step 6: Run the full secrets test suite — make sure no regression**

```bash
pnpm --filter @paperclip/server test -- --run secrets
```

Expected: all existing secrets tests still pass.

- [ ] **Step 7: Type-check**

```bash
pnpm --filter @paperclip/server typecheck
```

- [ ] **Step 8: Commit**

```bash
git add server/src/services/secrets.ts server/src/services/__tests__/secrets-mcp-normalization.test.ts
git commit -m "feat(secrets): walk mcpServers.*.env and .headers for binding normalization

Both normalizeAdapterConfigForPersistence and resolveBindingsForRuntime
now recurse into per-MCP-server env and headers, reusing the same
secret_ref resolution path as the top-level adapterConfig.env.

Refs SUP-18"
```

---

## Task 4 — Adapter helper: write `mcp-config.json` and emit `--mcp-config` (TDD)

**Files:**
- Create: `/app/packages/adapters/claude-local/src/server/mcp-config.ts`
- Create: `/app/packages/adapters/claude-local/src/server/__tests__/mcp-config.test.ts`
- Modify: `/app/packages/adapters/claude-local/src/server/execute.ts` (around lines 606-700)

We isolate the file-write logic in its own module so it stays pure and testable. `execute.ts` calls the helper after secret resolution and pushes `--mcp-config <path>` if the file was written.

- [ ] **Step 1: Write the failing tests**

Create `/app/packages/adapters/claude-local/src/server/__tests__/mcp-config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMcpConfigFile, mcpConfigFileName } from "../mcp-config";

describe("writeMcpConfigFile", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-config-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns null when mcpServers is undefined", async () => {
    const path = await writeMcpConfigFile(dir, undefined);
    expect(path).toBeNull();
  });

  it("returns null when mcpServers is empty", async () => {
    const path = await writeMcpConfigFile(dir, {});
    expect(path).toBeNull();
  });

  it("writes a JSON file with mcpServers wrapper", async () => {
    const servers = {
      linear: { type: "stdio", command: "mcp-linear", args: [], env: { LINEAR_API_KEY: "x" } },
    };
    const path = await writeMcpConfigFile(dir, servers);
    expect(path).toBe(join(dir, mcpConfigFileName));
    const written = JSON.parse(readFileSync(path!, "utf-8"));
    expect(written).toEqual({ mcpServers: servers });
  });

  it("file permissions are 0o600 (owner read/write only)", async () => {
    const servers = { linear: { type: "stdio", command: "mcp-linear", env: { K: "v" } } };
    const path = await writeMcpConfigFile(dir, servers);
    const { statSync } = await import("node:fs");
    const mode = statSync(path!).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run tests; they fail**

```bash
pnpm --filter @paperclip/adapter-claude-local test -- --run mcp-config
```

Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implement the helper**

Create `/app/packages/adapters/claude-local/src/server/mcp-config.ts`:

```typescript
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const mcpConfigFileName = "mcp-config.json";

export type ResolvedMcpServers = Record<string, Record<string, unknown>>;

export async function writeMcpConfigFile(
  runDir: string,
  mcpServers: ResolvedMcpServers | undefined,
): Promise<string | null> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return null;
  const path = join(runDir, mcpConfigFileName);
  const body = JSON.stringify({ mcpServers }, null, 2);
  await writeFile(path, body, { encoding: "utf-8", mode: 0o600 });
  return path;
}
```

- [ ] **Step 4: Run tests; they pass**

```bash
pnpm --filter @paperclip/adapter-claude-local test -- --run mcp-config
```

Expected: all 4 tests pass.

- [ ] **Step 5: Wire into `execute.ts`**

Open `/app/packages/adapters/claude-local/src/server/execute.ts`. Find `buildClaudeArgs` (around line 606). Locate where `args.push("--add-dir", effectivePromptBundleAddDir)` happens (line 628 per the explore report).

Just before that line is built up (or right before `runAdapterExecutionTargetProcess` is invoked — wherever the `cwd` for the run is known), add:

```typescript
import { writeMcpConfigFile } from "./mcp-config";

// after secret resolution, before/inside buildClaudeArgs:
const resolvedMcpServers = resolvedConfig.mcpServers as ResolvedMcpServers | undefined;
const mcpConfigPath = await writeMcpConfigFile(cwd, resolvedMcpServers);
```

Then in `buildClaudeArgs`, after the existing `args.push("--add-dir", effectivePromptBundleAddDir)`:

```typescript
if (mcpConfigPath) {
  args.push("--mcp-config", mcpConfigPath);
}
```

The `cwd` variable is the per-run dir established earlier in `execute()`; reuse it (do NOT use the seed dir — runs are isolated). The existing `terminalResultCleanup` will sweep the run dir, so no separate cleanup is needed.

- [ ] **Step 6: Add a focused integration-style test for `buildClaudeArgs`**

Append to `mcp-config.test.ts` (or write a new sibling test if execute.ts doesn't currently have testable seams):

```typescript
import { buildClaudeArgsForTest } from "../execute"; // export only if not already

describe("buildClaudeArgs — mcpServers integration", () => {
  it("appends --mcp-config when file was written", async () => {
    // arrange a fake config with mcpServers, drive the args builder, assert args.
    // exact harness depends on whether execute.ts already exposes a test-only export.
    // If it doesn't, adding a tiny `export function buildClaudeArgs(...)` for tests is fine.
  });

  it("does not append --mcp-config when mcpServers is empty", async () => {
    // ...
  });
});
```

If `execute.ts` is currently a single closure with no test seam, the simplest move is to extract `buildClaudeArgs` (and the `mcpConfigPath` resolution) into a small exported function in a new file so it's testable without spinning up a real claude process. Keep the change minimal — just enough seam.

- [ ] **Step 7: Run all adapter tests**

```bash
pnpm --filter @paperclip/adapter-claude-local test -- --run
```

Expected: all pass, including any pre-existing ones.

- [ ] **Step 8: Type-check**

```bash
pnpm --filter @paperclip/adapter-claude-local typecheck
```

- [ ] **Step 9: Commit**

```bash
git add packages/adapters/claude-local/src/server/mcp-config.ts \
        packages/adapters/claude-local/src/server/__tests__/mcp-config.test.ts \
        packages/adapters/claude-local/src/server/execute.ts
git commit -m "feat(claude-local): pass --mcp-config for per-agent MCP servers

When adapterConfig.mcpServers is non-empty, write mcp-config.json
(0600) into the per-run cwd and append --mcp-config <path> to the
claude CLI args. Empty/undefined mcpServers is a no-op.

Refs SUP-18"
```

---

## Task 5 — Adapter doc

**Files:**
- Modify: `/app/docs/adapters/claude-local.md`

- [ ] **Step 1: Add a `mcpServers` section**

Append (or insert near the existing `env` doc):

```markdown
### `mcpServers` (optional)

Per-agent MCP server definitions, mirroring the `mcpServers` shape from Claude Code's `.claude.json`. Three transports: `stdio`, `sse`, `http`. Both `env` and `headers` accept the same binding shapes as top-level `env` (plain string or `{ type: "secret_ref", secretId, version }`).

```json
{
  "mcpServers": {
    "linear": {
      "type": "stdio",
      "command": "mcp-linear",
      "args": [],
      "env": {
        "LINEAR_API_KEY": {
          "type": "secret_ref",
          "secretId": "<uuid>",
          "version": "latest"
        }
      }
    }
  }
}
```

At spawn time the adapter writes `<runDir>/mcp-config.json` (mode 0600) and passes `--mcp-config` to the `claude` CLI. Secret refs are resolved via `secretService.resolveBindingsForRuntime` before the file is written.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adapters/claude-local.md
git commit -m "docs(adapters): document mcpServers field for claude_local

Refs SUP-18"
```

---

## Task 6 — Operator runbook for the Linear cutover

**Files:**
- Create: `docs/superpowers/runbooks/2026-05-07-linear-mcp-cutover.md`

This is **not code**. It's a step-by-step runbook for the operator (Lead Engineer or whoever applies the cutover). It assumes Tasks 1-5 are merged.

- [ ] **Step 1: Write the runbook**

```markdown
# Linear MCP cutover (SUP-18)

## Prereqs

- Tasks 1-5 of the SUP-18 plan merged to staging and deployed.
- You have a board JWT for Brad's company (`084af715-a80f-4916-b8b7-cdd34bf4fc67`).
- Existing plaintext key from `/paperclip/.claude.json` (read at runtime — never paste into commits/comments). Captured into `$LINEAR_API_KEY_VALUE` below.

## 1. Create the company secret

```bash
TOKEN="<board-jwt>"
COMPANY=084af715-a80f-4916-b8b7-cdd34bf4fc67
LINEAR_API_KEY_VALUE="$(jq -r '.projects."/".mcpServers.linear.env.LINEAR_API_KEY' /paperclip/.claude.json)"
curl -sS -X POST "https://paperclip.nveron.com/api/companies/$COMPANY/secrets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg v "$LINEAR_API_KEY_VALUE" '{
    name: "linear-api-key",
    provider: "local_encrypted",
    value: $v,
    description: "Personal Linear API key (the-bradery workspace). Migrated from /paperclip/.claude.json. Rotate to read-only scope as a follow-up."
  }')"
# capture the returned `id` field as $SECRET_ID
```

## 2. Patch CEO and Lead Engineer agent configs

```bash
SECRET_ID="<id from step 1>"
CEO=33d22c9f-7f7f-4b09-aa38-58d35c6ab62c
LEAD=65af5a28-4fd9-47ad-b86a-fdca17987732

PATCH_BODY=$(cat <<JSON
{
  "adapterConfig": {
    "mcpServers": {
      "linear": {
        "type": "stdio",
        "command": "mcp-linear",
        "args": [],
        "env": {
          "LINEAR_API_KEY": { "type": "secret_ref", "secretId": "$SECRET_ID", "version": "latest" }
        }
      }
    }
  },
  "replaceAdapterConfig": false
}
JSON
)

curl -sS -X PATCH "https://paperclip.nveron.com/api/agents/$CEO" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$PATCH_BODY"
curl -sS -X PATCH "https://paperclip.nveron.com/api/agents/$LEAD" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$PATCH_BODY"
```

Note `replaceAdapterConfig: false` — we are merging, not overwriting the rest of the adapter config. Confirm in the response that other fields (model, env, etc.) survived.

## 3. Remove the plaintext key

```bash
# Backup first
cp /paperclip/.claude.json /paperclip/.claude.json.bak-pre-sup18
# Use a tiny Node one-liner to delete the linear stanza without rewriting the rest.
node -e '
  const fs = require("fs");
  const path = "/paperclip/.claude.json";
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  if (data.projects && data.projects["/"] && data.projects["/"].mcpServers) {
    delete data.projects["/"].mcpServers.linear;
  }
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
'
chmod 600 /paperclip/.claude.json
grep -F lin_api_ /paperclip/.claude.json && echo "STILL PRESENT — abort" || echo "ok, plaintext gone"
```

## 4. Smoke from CEO heartbeat

Post a comment on SUP-18 like "Smoke check: confirm Linear MCP propagates and ENG-2696 is readable." This wakes the CEO. The CEO heartbeat should:

- See `mcp__linear__*` tools in `ToolSearch`.
- Call the Linear MCP `getIssue` tool on `ENG-2696` and reply on the issue with the title.

If `mcp__linear__*` is not present, the cutover failed — revert step 3 from the backup and investigate.

## 5. After the smoke passes

- Close SUP-18 as `done`.
- Open a child issue: "[infra] Rotate Linear key to read-only scope and switch to HTTPS MCP" (priority low). Mention the current full-access key is still in the secret store and should be rotated.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/2026-05-07-linear-mcp-cutover.md
git commit -m "docs(runbooks): add SUP-18 Linear MCP cutover runbook

Refs SUP-18"
```

---

## Task 7 — Open the PR

**Files:** none (PR metadata only)

- [ ] **Step 1: Push branch**

```bash
git push -u origin lead-engineer/sup-18-mcp-propagation
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --base staging --title "feat: propagate per-agent mcpServers through claude_local" --body "$(cat <<'EOF'
## Summary
- Adds `adapterConfig.mcpServers` to the claude_local adapter — mirrors Claude Code's `.claude.json` shape.
- `secretService` recursion now walks `mcpServers.*.env` and `.headers` (so `secret_ref` Just Works).
- The adapter writes an ephemeral `mcp-config.json` (0600) in the per-run cwd and passes `--mcp-config` to the claude CLI.
- Adapter doc updated. No new tables, no new routes, no UI changes.

## Out of scope (follow-ups)
- Linear key rotation to read-only scope.
- Switch from `mcp-linear` stdio to the HTTPS MCP (`mcp.linear.app/mcp`).
- UI editor for mcpServers in AgentConfigForm.

## Test plan
- [x] Validator unit tests (7 cases — stdio, sse, http, secret_ref, errors).
- [x] Secret recursion unit tests (5 cases — normalize + resolve, env + headers).
- [x] Adapter helper unit tests (4 cases — empty/undefined no-op, file content, 0600 perms).
- [ ] Cutover runbook executed in staging — confirms a CEO heartbeat sees `mcp__linear__*` and reads ENG-2696.

Refs SUP-18
EOF
)"
```

- [ ] **Step 3: Request review from the Code Reviewer agent or human reviewer per company policy.**

---

## Task 8 — Hand back to the CEO

**Files:** none.

After PR is merged AND the cutover runbook (Task 6) is executed against the live `paperclip.nveron.com` instance:

- [ ] **Step 1: Comment on SUP-18 with the smoke evidence**

Post on SUP-18:
- The PR URL.
- A short transcript of the smoke: ToolSearch returning `mcp__linear__*`, and ENG-2696 read via the MCP tool.
- A link to the follow-up issue for rotation.

- [ ] **Step 2: Mark SUP-18 as `in_review` (CEO will take it from `in_review` to `done`).**

That's the handoff back. The CEO will close the parent and confirm the follow-up issue.

---

## Verification matrix (final)

Before declaring the plan executed, all of these should be true:

| # | Check | How |
|---|---|---|
| 1 | `mcpServersSchema` accepts a stdio + secret_ref config | `pnpm --filter @paperclip/shared test -- --run agent-mcp-servers` |
| 2 | Secrets recursion handles `mcpServers.*.env` | `pnpm --filter @paperclip/server test -- --run secrets-mcp-normalization` |
| 3 | Adapter writes mcp-config.json with 0600 perms | `pnpm --filter @paperclip/adapter-claude-local test -- --run mcp-config` |
| 4 | All pre-existing tests still pass | Diff against `/tmp/*-baseline.txt` |
| 5 | TypeScript builds clean across the three packages | `pnpm typecheck` (or per-package) |
| 6 | Plaintext key absent from `/paperclip/.claude.json` | `grep -F lin_api_ /paperclip/.claude.json` returns nothing |
| 7 | CEO heartbeat exposes `mcp__linear__*` | Wake CEO, inspect ToolSearch transcript |
| 8 | CEO can read ENG-2696 via MCP | Comment on SUP-18 with the title from the MCP call |

If 7 or 8 fails, revert Task 6 step 3 from the backup and diagnose — do not leave the system half-cutover.
