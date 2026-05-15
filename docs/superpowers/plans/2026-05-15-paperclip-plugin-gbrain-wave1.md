# paperclip-plugin-gbrain Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the synchronous retain path of paperclip-plugin-gbrain — on `agent.run.finished`, ensure issue + agent pages exist in gbrain and append a timeline entry tagged with `{agentId, runId, companyId}`.

**Architecture:** A bundled kkroo-fork paperclip plugin that subscribes to `agent.run.finished`, calls gbrain MCP at `http://gbrain-mcp.paperclip.svc.cluster.local:3131/gbrain` over hand-rolled JSON-RPC, and writes idempotent page + timeline entries. No recall path, no fact-promotion, no tool surface — those are wave 2.

**Tech Stack:** TypeScript, `@paperclipai/plugin-sdk`, vitest, MCP Streamable HTTP (JSON-RPC), pnpm workspaces, the kkroo fork of `Blockcast/paperclip`.

**Source:** Design at `docs/superpowers/specs/2026-05-15-paperclip-plugin-gbrain-design.md` (committed sha `29fd8563` on branch `omar/gbrain-plugin-design`).

**Scope cap:** Wave 1 only. Wave 2 (recall + fact-promotion + gbrain_recall_cache tool) is a separate plan.

---

## File structure

All paths relative to repo root `/home/oramadan/src/paperclip/paperclip`.

| Path | Responsibility | Reasoning |
|---|---|---|
| `packages/plugins/paperclip-plugin-gbrain/package.json` | Workspace package metadata, paperclipPlugin entrypoints | Mirror `paperclip-plugin-ccrotate/package.json` exactly — same scripts, same SDK dep |
| `packages/plugins/paperclip-plugin-gbrain/tsconfig.json` | TS build config | Mirror ccrotate's; extends root tsconfig |
| `packages/plugins/paperclip-plugin-gbrain/src/manifest.ts` | Plugin id, version, event subscriptions, capabilities | Pure declarative; no I/O |
| `packages/plugins/paperclip-plugin-gbrain/src/identity.ts` | Agent UUID → slug, issue identifier → slug, page-type constants | Pure functions; no I/O, no SDK dep — fully unit-testable |
| `packages/plugins/paperclip-plugin-gbrain/src/gbrain-client.ts` | MCP-over-HTTP JSON-RPC client | One responsibility: transport. Accepts URL in constructor; no env reads, no logging side effects |
| `packages/plugins/paperclip-plugin-gbrain/src/pages.ts` | `ensureIssuePage`, `ensureAgentPage`, `addWorkedOnLink`, `addRunTimelineEntry` | Operates against a `GbrainClient` interface. Calls `identity.ts` for slug derivation |
| `packages/plugins/paperclip-plugin-gbrain/src/handlers.ts` | `handleRunFinished(ctx, event, deps)` — orchestrator for the retain path | Takes a `Deps` injection point so tests don't need real network |
| `packages/plugins/paperclip-plugin-gbrain/src/worker.ts` | `definePlugin` + `runWorker` entrypoint | Tiny — wires events to `handlers.ts`, constructs `GbrainClient` from config |
| `packages/plugins/paperclip-plugin-gbrain/src/__tests__/identity.test.ts` | identity slug derivation tests | vitest |
| `packages/plugins/paperclip-plugin-gbrain/src/__tests__/gbrain-client.test.ts` | client transport tests with mocked fetch | vitest |
| `packages/plugins/paperclip-plugin-gbrain/src/__tests__/pages.test.ts` | page-helper tests with mock client | vitest |
| `packages/plugins/paperclip-plugin-gbrain/src/__tests__/handlers.test.ts` | end-to-end handler test with mock deps | vitest |
| `Dockerfile` | Add COPY + build steps for the new plugin | Modify lines 56 + 164 region |
| `server/src/bootstrap/kkroo-bundled-plugins.ts` | Register local install path in `installKkrooLocalPlugins` | Modify ~line 265 region |

**Why this split:** each file has one clear purpose and a stable interface so tasks below can be implemented and reviewed in isolation. `identity.ts` and `gbrain-client.ts` are pure (no SDK or paperclip deps) — they're testable without any plugin runtime mocking.

---

### Task 1: Scaffold the plugin package

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/package.json`
- Create: `packages/plugins/paperclip-plugin-gbrain/tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@kkroo/paperclip-plugin-gbrain",
  "version": "0.1.0",
  "description": "Paperclip plugin that retains agent run output to gbrain (graph brain) as timeline entries on issue pages, identity-tagged with agentId/runId/companyId.",
  "license": "MIT",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "scripts": {
    "prebuild": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Refresh workspace lockfile**

Run: `pnpm install --filter @kkroo/paperclip-plugin-gbrain...`
Expected: `+ @kkroo/paperclip-plugin-gbrain 0.1.0` plus the new package linked into `node_modules`.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/package.json \
        packages/plugins/paperclip-plugin-gbrain/tsconfig.json \
        pnpm-lock.yaml
git commit -m "feat(plugin-gbrain): scaffold workspace package"
```

---

### Task 2: Manifest declaration

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/src/manifest.ts`
- Create: `packages/plugins/paperclip-plugin-gbrain/src/index.ts`

- [ ] **Step 1: Write manifest.ts**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "kkroo.gbrain";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_GBRAIN_MCP_URL =
  "http://gbrain-mcp.paperclip.svc.cluster.local:3131/gbrain";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "gbrain",
  description:
    "Retain agent run output to gbrain (graph brain) as timeline entries on issue pages, identity-tagged with agentId/runId/companyId.",
  author: "kkroo",
  categories: ["automation", "connector"],
  capabilities: [
    "events.subscribe",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  eventSubscriptions: [
    { event: "agent.run.finished" },
  ],
  configSchema: {
    type: "object",
    properties: {
      gbrainMcpUrl: {
        type: "string",
        default: DEFAULT_GBRAIN_MCP_URL,
        description: "MCP Streamable-HTTP endpoint for gbrain.",
      },
      autoRetain: {
        type: "boolean",
        default: true,
        description: "Append a timeline entry on every successful agent run.",
      },
    },
  },
};

export default manifest;
```

- [ ] **Step 2: Write index.ts re-exports**

```ts
export { default as manifest } from "./manifest.js";
export { default as worker } from "./worker.js";
```

(Note: `worker.js` will be created in Task 7. Until then `tsc` will fail this re-export — that's expected; the build is gated to the final task.)

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/src/manifest.ts \
        packages/plugins/paperclip-plugin-gbrain/src/index.ts
git commit -m "feat(plugin-gbrain): manifest declaring agent.run.finished subscription"
```

---

### Task 3: identity.ts (slug derivation)

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/src/identity.ts`
- Create: `packages/plugins/paperclip-plugin-gbrain/src/__tests__/identity.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { issueSlug, agentSlug, factSlug, PAGE_TYPES } from "../identity.js";

describe("issueSlug", () => {
  it("formats identifier as issue/<identifier>", () => {
    expect(issueSlug("BLO-3220")).toBe("issue/BLO-3220");
    expect(issueSlug("PCL-1490")).toBe("issue/PCL-1490");
  });

  it("returns null when identifier is missing", () => {
    expect(issueSlug(null)).toBeNull();
    expect(issueSlug(undefined)).toBeNull();
    expect(issueSlug("")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(issueSlug("  BLO-3220 ")).toBe("issue/BLO-3220");
  });
});

describe("agentSlug", () => {
  it("lowercases and strips non-alphanumeric", () => {
    expect(agentSlug("CTO")).toBe("agent/cto");
    expect(agentSlug("MulticastEngineer")).toBe("agent/multicastengineer");
    expect(agentSlug("Release Engineer")).toBe("agent/releaseengineer");
  });

  it("collapses runs of separators", () => {
    expect(agentSlug("QA   Engineer")).toBe("agent/qaengineer");
    expect(agentSlug("Foo-Bar_Baz.Qux")).toBe("agent/foobarbazqux");
  });

  it("returns null when name is empty after normalization", () => {
    expect(agentSlug("   ")).toBeNull();
    expect(agentSlug("")).toBeNull();
    expect(agentSlug(null)).toBeNull();
  });
});

describe("factSlug", () => {
  it("formats uuid as fact/<uuid>", () => {
    expect(factSlug("11111111-2222-3333-4444-555555555555")).toBe(
      "fact/11111111-2222-3333-4444-555555555555",
    );
  });
});

describe("PAGE_TYPES", () => {
  it("exports stable type constants", () => {
    expect(PAGE_TYPES.ISSUE).toBe("issue");
    expect(PAGE_TYPES.AGENT).toBe("agent");
    expect(PAGE_TYPES.FACT).toBe("fact");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: `Cannot find module '../identity.js'` — module doesn't exist yet.

- [ ] **Step 3: Implement identity.ts**

```ts
export const PAGE_TYPES = {
  ISSUE: "issue",
  AGENT: "agent",
  FACT: "fact",
} as const;

export function issueSlug(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  return `issue/${trimmed}`;
}

export function agentSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  return `agent/${normalized}`;
}

export function factSlug(memoryUnitUuid: string): string {
  return `fact/${memoryUnitUuid}`;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: 13 tests passed across 4 describe blocks.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/src/identity.ts \
        packages/plugins/paperclip-plugin-gbrain/src/__tests__/identity.test.ts
git commit -m "feat(plugin-gbrain): pure slug derivation in identity.ts"
```

---

### Task 4: gbrain-client.ts (MCP transport)

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/src/gbrain-client.ts`
- Create: `packages/plugins/paperclip-plugin-gbrain/src/__tests__/gbrain-client.test.ts`

- [ ] **Step 1: Write failing tests for client**

Create `src/__tests__/gbrain-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GbrainClient, GbrainCallError } from "../gbrain-client.js";

describe("GbrainClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: GbrainClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new GbrainClient({
      url: "http://gbrain.test/gbrain",
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 1000,
    });
  });

  it("posts a JSON-RPC tools/call envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "{\"ok\":true}" }] },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("put_page", { slug: "issue/BLO-1", content: "x" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gbrain.test/gbrain");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["accept"]).toContain("application/json");

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "put_page", arguments: { slug: "issue/BLO-1", content: "x" } },
    });
    expect(typeof body.id).toBe("number");

    expect(out).toEqual({ ok: true });
  });

  it("throws GbrainCallError on JSON-RPC error response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Tool not found" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(client.call("nonexistent", {})).rejects.toBeInstanceOf(
      GbrainCallError,
    );
  });

  it("aborts after timeoutMs and throws GbrainCallError", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const start = Date.now();
    await expect(client.call("slow", {})).rejects.toBeInstanceOf(GbrainCallError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("returns the parsed text payload of the first content block", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "{\"slug\":\"issue/X\",\"created\":true}" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("put_page", {});
    expect(out).toEqual({ slug: "issue/X", created: true });
  });

  it("returns raw result when no content[0].text JSON is present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "image", data: "..." }] },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const out = await client.call("get_image", {});
    expect(out).toEqual({ content: [{ type: "image", data: "..." }] });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: `Cannot find module '../gbrain-client.js'`.

- [ ] **Step 3: Implement gbrain-client.ts**

```ts
export interface GbrainClientOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GbrainCallError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GbrainCallError";
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text?: string }> } | unknown;
  error?: { code: number; message: string };
}

export class GbrainClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: GbrainClientOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0" as const,
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new GbrainCallError(`HTTP ${resp.status} from ${this.url}`);
      }

      const json = (await resp.json()) as JsonRpcResponse;
      if (json.error) {
        throw new GbrainCallError(
          `JSON-RPC error ${json.error.code}: ${json.error.message}`,
        );
      }

      const result = json.result as
        | { content?: Array<{ type: string; text?: string }> }
        | undefined;
      const text = result?.content?.[0]?.text;
      if (typeof text === "string") {
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      return result as T;
    } catch (err) {
      if (err instanceof GbrainCallError) throw err;
      throw new GbrainCallError(
        err instanceof Error ? err.message : String(err),
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: all 5 client tests pass plus the 13 identity tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/src/gbrain-client.ts \
        packages/plugins/paperclip-plugin-gbrain/src/__tests__/gbrain-client.test.ts
git commit -m "feat(plugin-gbrain): minimal MCP JSON-RPC client with timeout"
```

---

### Task 5: pages.ts (ensure-page + timeline helpers)

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/src/pages.ts`
- Create: `packages/plugins/paperclip-plugin-gbrain/src/__tests__/pages.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/pages.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ensureIssuePage,
  ensureAgentPage,
  addWorkedOnLink,
  addRunTimelineEntry,
} from "../pages.js";

interface FakeClient {
  call: ReturnType<typeof vi.fn>;
}

describe("ensureIssuePage", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = { call: vi.fn() };
  });

  it("does nothing if get_page returns an existing page", async () => {
    client.call.mockResolvedValueOnce({ slug: "issue/BLO-1", exists: true });
    await ensureIssuePage(client, {
      identifier: "BLO-1",
      title: "Fix login",
      description: "Login is broken",
    });
    expect(client.call).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith("get_page", { slug: "issue/BLO-1" });
  });

  it("calls put_page when get_page returns null/missing", async () => {
    client.call.mockResolvedValueOnce(null);
    client.call.mockResolvedValueOnce({ slug: "issue/BLO-1", created: true });

    await ensureIssuePage(client, {
      identifier: "BLO-1",
      title: "Fix login",
      description: "Login is broken",
    });

    expect(client.call).toHaveBeenNthCalledWith(2, "put_page", {
      slug: "issue/BLO-1",
      type: "issue",
      title: "Fix login",
      content: "Login is broken",
    });
  });

  it("throws when identifier is missing", async () => {
    await expect(
      ensureIssuePage(client, { identifier: null, title: "x", description: "y" }),
    ).rejects.toThrow(/identifier/);
  });
});

describe("ensureAgentPage", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = { call: vi.fn() };
  });

  it("derives slug from agent name and creates if missing", async () => {
    client.call.mockResolvedValueOnce(null);
    client.call.mockResolvedValueOnce({ slug: "agent/cto", created: true });

    await ensureAgentPage(client, { agentId: "a-1", agentName: "CTO" });

    expect(client.call).toHaveBeenNthCalledWith(1, "get_page", { slug: "agent/cto" });
    expect(client.call).toHaveBeenNthCalledWith(2, "put_page", {
      slug: "agent/cto",
      type: "agent",
      title: "CTO",
      content: "Agent CTO (id a-1)",
    });
  });

  it("throws when agent name produces empty slug", async () => {
    await expect(
      ensureAgentPage(client, { agentId: "a-1", agentName: "   " }),
    ).rejects.toThrow(/agent/);
  });
});

describe("addWorkedOnLink", () => {
  it("posts add_link with worked_on type", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    await addWorkedOnLink(client, { agentSlug: "agent/cto", issueSlug: "issue/BLO-1" });

    expect(client.call).toHaveBeenCalledWith("add_link", {
      from_slug: "agent/cto",
      to_slug: "issue/BLO-1",
      link_type: "worked_on",
    });
  });
});

describe("addRunTimelineEntry", () => {
  it("posts add_timeline_entry with full identity metadata", async () => {
    const client = { call: vi.fn().mockResolvedValue(null) };
    await addRunTimelineEntry(client, {
      issueSlug: "issue/BLO-1",
      body: "agent output excerpt",
      agentId: "a-1",
      runId: "r-1",
      companyId: "c-1",
      outcome: "succeeded",
      finishedAt: "2026-05-15T12:00:00Z",
    });

    expect(client.call).toHaveBeenCalledWith("add_timeline_entry", {
      slug: "issue/BLO-1",
      body: "agent output excerpt",
      occurred_at: "2026-05-15T12:00:00Z",
      metadata: {
        agentId: "a-1",
        runId: "r-1",
        companyId: "c-1",
        outcome: "succeeded",
        source: "paperclip-plugin-gbrain",
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: `Cannot find module '../pages.js'`.

- [ ] **Step 3: Implement pages.ts**

```ts
import { issueSlug, agentSlug, PAGE_TYPES } from "./identity.js";

export interface GbrainCallable {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
}

export async function ensureIssuePage(
  client: GbrainCallable,
  input: {
    identifier: string | null | undefined;
    title: string | null | undefined;
    description: string | null | undefined;
  },
): Promise<void> {
  const slug = issueSlug(input.identifier);
  if (!slug) {
    throw new Error("ensureIssuePage: identifier is required");
  }
  const existing = await client.call("get_page", { slug });
  if (existing) return;
  await client.call("put_page", {
    slug,
    type: PAGE_TYPES.ISSUE,
    title: input.title ?? input.identifier ?? slug,
    content: input.description ?? "",
  });
}

export async function ensureAgentPage(
  client: GbrainCallable,
  input: { agentId: string; agentName: string | null | undefined },
): Promise<void> {
  const slug = agentSlug(input.agentName);
  if (!slug) {
    throw new Error("ensureAgentPage: agent name produced empty slug");
  }
  const existing = await client.call("get_page", { slug });
  if (existing) return;
  await client.call("put_page", {
    slug,
    type: PAGE_TYPES.AGENT,
    title: input.agentName ?? slug,
    content: `Agent ${input.agentName ?? "(unnamed)"} (id ${input.agentId})`,
  });
}

export async function addWorkedOnLink(
  client: GbrainCallable,
  input: { agentSlug: string; issueSlug: string },
): Promise<void> {
  await client.call("add_link", {
    from_slug: input.agentSlug,
    to_slug: input.issueSlug,
    link_type: "worked_on",
  });
}

export async function addRunTimelineEntry(
  client: GbrainCallable,
  input: {
    issueSlug: string;
    body: string;
    agentId: string;
    runId: string;
    companyId: string;
    outcome: string;
    finishedAt: string;
  },
): Promise<void> {
  await client.call("add_timeline_entry", {
    slug: input.issueSlug,
    body: input.body,
    occurred_at: input.finishedAt,
    metadata: {
      agentId: input.agentId,
      runId: input.runId,
      companyId: input.companyId,
      outcome: input.outcome,
      source: "paperclip-plugin-gbrain",
    },
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: pages tests pass plus all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/src/pages.ts \
        packages/plugins/paperclip-plugin-gbrain/src/__tests__/pages.test.ts
git commit -m "feat(plugin-gbrain): ensure-page + timeline + link helpers"
```

---

### Task 6: handlers.ts (orchestrator)

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/src/handlers.ts`
- Create: `packages/plugins/paperclip-plugin-gbrain/src/__tests__/handlers.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/__tests__/handlers.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handleRunFinished } from "../handlers.js";

function makeEvent(overrides: Partial<{ payload: Record<string, unknown>; companyId: string }> = {}) {
  return {
    eventType: "agent.run.finished",
    companyId: overrides.companyId ?? "c-1",
    payload: overrides.payload ?? {
      runId: "r-1",
      agentId: "a-1",
      status: "succeeded",
      issueId: "i-1",
      issueTitle: "Fix login",
      issueDescription: "Login is broken",
      output: "agent did X, Y, Z",
      finishedAt: "2026-05-15T12:00:00Z",
    },
  };
}

describe("handleRunFinished", () => {
  it("ensures issue page, agent page, worked_on link, then timeline entry", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        calls.push([tool, args]);
        if (tool === "get_page") return null;
        return { ok: true };
      }),
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleRunFinished({
      event: makeEvent(),
      client,
      logger,
      autoRetain: true,
      lookupIssueIdentifier: vi.fn(async () => "BLO-1"),
      lookupAgentName: vi.fn(async () => "CTO"),
    });

    const tools = calls.map(([tool]) => tool);
    expect(tools).toEqual([
      "get_page",         // issue page check
      "put_page",         // issue page create
      "get_page",         // agent page check
      "put_page",         // agent page create
      "add_link",         // worked_on
      "add_timeline_entry",
    ]);
    const lastCall = calls[calls.length - 1][1];
    expect(lastCall).toMatchObject({
      slug: "issue/BLO-1",
      body: "agent did X, Y, Z",
      metadata: { agentId: "a-1", runId: "r-1", companyId: "c-1", outcome: "succeeded" },
    });
  });

  it("no-ops when autoRetain is false", async () => {
    const client = { call: vi.fn() };
    await handleRunFinished({
      event: makeEvent(),
      client,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      autoRetain: false,
      lookupIssueIdentifier: vi.fn(),
      lookupAgentName: vi.fn(),
    });
    expect(client.call).not.toHaveBeenCalled();
  });

  it("no-ops when payload status is not succeeded", async () => {
    const client = { call: vi.fn() };
    const evt = makeEvent({ payload: { runId: "r-1", agentId: "a-1", status: "failed" } });
    await handleRunFinished({
      event: evt,
      client,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      autoRetain: true,
      lookupIssueIdentifier: vi.fn(),
      lookupAgentName: vi.fn(),
    });
    expect(client.call).not.toHaveBeenCalled();
  });

  it("logs.warn and does not throw when client.call fails", async () => {
    const client = {
      call: vi.fn(async () => {
        throw new Error("gbrain down");
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      handleRunFinished({
        event: makeEvent(),
        client,
        logger,
        autoRetain: true,
        lookupIssueIdentifier: vi.fn(async () => "BLO-1"),
        lookupAgentName: vi.fn(async () => "CTO"),
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips when issue identifier cannot be resolved", async () => {
    const client = { call: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await handleRunFinished({
      event: makeEvent(),
      client,
      logger,
      autoRetain: true,
      lookupIssueIdentifier: vi.fn(async () => null),
      lookupAgentName: vi.fn(async () => "CTO"),
    });
    expect(client.call).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/skip/i),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: `Cannot find module '../handlers.js'`.

- [ ] **Step 3: Implement handlers.ts**

```ts
import { agentSlug, issueSlug } from "./identity.js";
import {
  addRunTimelineEntry,
  addWorkedOnLink,
  ensureAgentPage,
  ensureIssuePage,
  type GbrainCallable,
} from "./pages.js";

export interface RunFinishedEventShape {
  eventType: string;
  companyId: string;
  payload: Record<string, unknown>;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface HandleRunFinishedInput {
  event: RunFinishedEventShape;
  client: GbrainCallable;
  logger: Logger;
  autoRetain: boolean;
  /** Resolve human identifier (e.g. "BLO-3220") from issue UUID. */
  lookupIssueIdentifier(issueId: string): Promise<string | null>;
  /** Resolve human-readable agent name from agent UUID. */
  lookupAgentName(agentId: string): Promise<string | null>;
}

export async function handleRunFinished(input: HandleRunFinishedInput): Promise<void> {
  const { event, client, logger, autoRetain, lookupIssueIdentifier, lookupAgentName } =
    input;
  if (!autoRetain) return;

  const p = event.payload;
  const status = typeof p.status === "string" ? p.status : null;
  if (status !== "succeeded") return;

  const runId = typeof p.runId === "string" ? p.runId : null;
  const agentId = typeof p.agentId === "string" ? p.agentId : null;
  const issueId = typeof p.issueId === "string" ? p.issueId : null;
  const finishedAt = typeof p.finishedAt === "string" ? p.finishedAt : null;
  const issueTitleFromPayload = typeof p.issueTitle === "string" ? p.issueTitle : null;
  const issueDescFromPayload =
    typeof p.issueDescription === "string" ? p.issueDescription : null;
  const output = typeof p.output === "string" ? p.output : null;

  if (!runId || !agentId || !issueId || !finishedAt || !output) {
    logger.info("gbrain retain skip: missing required payload field", {
      runId,
      agentId,
      issueId,
      hasOutput: Boolean(output),
    });
    return;
  }

  try {
    const identifier = await lookupIssueIdentifier(issueId);
    const issuePageSlug = issueSlug(identifier);
    if (!issuePageSlug || !identifier) {
      logger.info("gbrain retain skip: issue identifier unresolved", { issueId });
      return;
    }

    const agentName = await lookupAgentName(agentId);
    const agentPageSlug = agentSlug(agentName);
    if (!agentPageSlug || !agentName) {
      logger.info("gbrain retain skip: agent name unresolved", { agentId });
      return;
    }

    await ensureIssuePage(client, {
      identifier,
      title: issueTitleFromPayload,
      description: issueDescFromPayload,
    });
    await ensureAgentPage(client, { agentId, agentName });
    await addWorkedOnLink(client, { agentSlug: agentPageSlug, issueSlug: issuePageSlug });
    await addRunTimelineEntry(client, {
      issueSlug: issuePageSlug,
      body: output,
      agentId,
      runId,
      companyId: event.companyId,
      outcome: status,
      finishedAt,
    });

    logger.info("gbrain retain wrote timeline entry", {
      runId,
      issueSlug: issuePageSlug,
      agentSlug: agentPageSlug,
    });
  } catch (err) {
    logger.warn("gbrain retain failed (non-fatal)", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain test`
Expected: all handler tests pass plus prior tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/src/handlers.ts \
        packages/plugins/paperclip-plugin-gbrain/src/__tests__/handlers.test.ts
git commit -m "feat(plugin-gbrain): run-finished handler with injected lookups"
```

---

### Task 7: worker.ts (plugin entrypoint)

**Files:**
- Create: `packages/plugins/paperclip-plugin-gbrain/src/worker.ts`

- [ ] **Step 1: Implement worker.ts**

```ts
import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import { GbrainClient } from "./gbrain-client.js";
import { handleRunFinished, type Logger } from "./handlers.js";
import { DEFAULT_GBRAIN_MCP_URL } from "./manifest.js";

interface GbrainConfig {
  gbrainMcpUrl?: string;
  autoRetain?: boolean;
}

async function getConfig(ctx: PluginContext): Promise<GbrainConfig> {
  return ((await ctx.config.get()) ?? {}) as GbrainConfig;
}

function makeLogger(ctx: PluginContext): Logger {
  return {
    info: (msg, fields) => ctx.logger.info(msg, fields ?? {}),
    warn: (msg, fields) => ctx.logger.warn(msg, fields ?? {}),
    error: (msg, fields) => ctx.logger.error(msg, fields ?? {}),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("gbrain plugin starting");

    ctx.events.on("agent.run.finished", async (event) => {
      const config = await getConfig(ctx);
      const client = new GbrainClient({
        url: config.gbrainMcpUrl ?? DEFAULT_GBRAIN_MCP_URL,
      });

      await handleRunFinished({
        event: {
          eventType: event.eventType,
          companyId: event.companyId,
          payload: event.payload as Record<string, unknown>,
        },
        client,
        logger: makeLogger(ctx),
        autoRetain: config.autoRetain !== false,
        lookupIssueIdentifier: async (issueId) => {
          const issue = await ctx.data.issues.get({ issueId });
          return issue?.identifier ?? null;
        },
        lookupAgentName: async (agentId) => {
          const agent = await ctx.data.agents.get({ agentId });
          return agent?.name ?? null;
        },
      });
    });

    ctx.logger.info("gbrain plugin ready");
  },
  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 2: Build the plugin**

Run: `pnpm --filter @kkroo/paperclip-plugin-gbrain build`
Expected: `dist/` populated with `manifest.js`, `worker.js`, `gbrain-client.js`, etc.

- [ ] **Step 3: Typecheck root**

Run: `pnpm --filter @paperclipai/server typecheck` (catches if our changes to bootstrap break)
Expected: same warning count as baseline, no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/paperclip-plugin-gbrain/src/worker.ts
git commit -m "feat(plugin-gbrain): worker entrypoint wiring SDK events to handlers"
```

> **Note on `ctx.data.issues.get` / `ctx.data.agents.get`:** The SDK exposes
> data accessors on `PluginContext.data`. If the exact path differs from what
> this plan assumes (`ctx.data.issues.get({issueId})`), look up the real path
> in `packages/plugins/sdk/src/types.ts` under the `PluginContext` interface
> and the `paperclip-plugin-linear` worker for an in-tree example (it reads
> issue records the same way). Adjust the two `lookupX` callbacks above
> accordingly; the rest of the plugin is unaffected.

---

### Task 8: Register the plugin in the kkroo image

**Files:**
- Modify: `Dockerfile`
- Modify: `server/src/bootstrap/kkroo-bundled-plugins.ts`

- [ ] **Step 1: Add Dockerfile COPY line**

Locate the block in `Dockerfile` around line 56:

```dockerfile
COPY packages/plugins/paperclip-plugin-linear/package.json packages/plugins/paperclip-plugin-linear/
COPY packages/plugins/paperclip-plugin-alertmanager/package.json packages/plugins/paperclip-plugin-alertmanager/
```

Add a line *after* the existing kkroo plugins (between linear and alertmanager is fine):

```dockerfile
COPY packages/plugins/paperclip-plugin-gbrain/package.json packages/plugins/paperclip-plugin-gbrain/
```

- [ ] **Step 2: Add Dockerfile build step**

Locate the block around line 164:

```dockerfile
RUN pnpm --filter @kkroo/paperclip-plugin-ccrotate build
RUN pnpm --filter @kkroo/paperclip-plugin-linear build
```

Add a line after the existing kkroo builds:

```dockerfile
RUN pnpm --filter @kkroo/paperclip-plugin-gbrain build
```

- [ ] **Step 3: Add bootstrap install entry**

In `server/src/bootstrap/kkroo-bundled-plugins.ts`, inside `installKkrooLocalPlugins`, after the existing ccrotate block (around line 265) add:

```ts
  // gbrain: bundled in-image (no npm publish), always install from local path.
  await installLocalPluginIfAbsent(ctx, {
    pluginKey: "kkroo.gbrain",
    absPath: resolve(process.cwd(), "packages/plugins/paperclip-plugin-gbrain"),
    displayName: "gbrain",
  });
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile server/src/bootstrap/kkroo-bundled-plugins.ts
git commit -m "feat(plugin-gbrain): wire into kkroo image build + bootstrap installer"
```

---

### Task 9: Push branch, open PR, wait for image build + deploy

**Files:** none (operational).

- [ ] **Step 1: Push branch**

```bash
git push -u blockcast omar/gbrain-plugin-wave1
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --base master --head omar/gbrain-plugin-wave1 \
  --title "feat(plugin-gbrain): wave 1 — auto-retain timeline entries on issue pages" \
  --body "$(cat <<'EOF'
## Summary
- New bundled plugin `@kkroo/paperclip-plugin-gbrain` subscribes to `agent.run.finished` and writes an `add_timeline_entry` on the issue's gbrain page tagged with `{agentId, runId, companyId}`.
- Wave 1 only: no recall path, no fact-promotion, no tool surface (wave 2 covers those).
- Design contract: `docs/superpowers/specs/2026-05-15-paperclip-plugin-gbrain-design.md`.

## Test plan
- [ ] CI: serialized server suites (1-4), e2e, canary
- [ ] After image build + helm bump, trigger a successful agent run
- [ ] Verify `paperclip-0` logs show `gbrain retain wrote timeline entry`
- [ ] Verify a timeline entry appears under `issue/<identifier>` via gbrain `/admin` UI

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected output: a `https://github.com/Blockcast/paperclip/pull/<N>` URL.

- [ ] **Step 3: Wait for CI**

```bash
gh pr checks <PR_NUMBER> --repo Blockcast/paperclip --watch
```

Expected: all required checks pass (shards 1-4 + e2e + canary + policy). `verify` may stall on self-hosted runners — that's acceptable per documented exception when all functional checks are green.

- [ ] **Step 4: Squash-merge**

```bash
gh pr merge <PR_NUMBER> --repo Blockcast/paperclip --squash --delete-branch
```

- [ ] **Step 5: Wait for Docker workflow to push image + auto-deploy**

```bash
gh run watch --repo Blockcast/paperclip --branch master \
  $(gh run list --repo Blockcast/paperclip --branch master --workflow=Docker --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: `Docker` workflow completes successfully and its `deploy` job runs `helm upgrade` to the new `sha-<7char>-k8s-vendored` tag.

- [ ] **Step 6: Verify live image**

```bash
kubectl -n paperclip get pod paperclip-0 -o jsonpath='{.spec.containers[?(@.name=="paperclip")].image}'
```

Expected: `registry.blockcast.net/paperclip:sha-<7char>-k8s-vendored` matching the merge commit sha.

- [ ] **Step 7: Confirm plugin loaded**

```bash
kubectl -n paperclip logs paperclip-0 -c paperclip --since=5m | grep -iE "gbrain plugin"
```

Expected: `[plugin] gbrain plugin starting` and `[plugin] gbrain plugin ready`.

---

### Task 10: Enable the plugin for Blockcast company

**Files:** none (DB / API operation).

- [ ] **Step 1: Look up plugin id**

```bash
kubectl -n paperclip exec paperclip-pg-0 -- psql -U paperclip -d paperclip -tAc "
SELECT id, plugin_key, status FROM plugins WHERE plugin_key='kkroo.gbrain';"
```

Expected: one row with `status='ready'`. Record the `id` (UUID).

- [ ] **Step 2: Enable for Blockcast company**

```bash
PCP_TOKEN=$(grep token ~/.paperclip/auth.json | cut -d'"' -f4)
curl -sS -H "Authorization: Bearer $PCP_TOKEN" -H "Content-Type: application/json" \
  https://paperclip.blockcast.net/api/companies/aaced805-3491-4ee5-9b14-cdf70cb81d47/plugins \
  -d '{"pluginKey":"kkroo.gbrain","enabled":true,"config":{"autoRetain":true}}'
```

Expected: a JSON response with `{ "ok": true }` (or equivalent). If the exact endpoint shape differs, refer to `paperclip-plugin-ccrotate` enablement docs or the `plugin_company_settings` table directly.

- [ ] **Step 3: Trigger a test run and verify**

Wake up an agent on any open Blockcast issue (e.g. POST to `/api/issues/<id>/wake`) and wait for it to finish successfully.

```bash
kubectl -n paperclip logs paperclip-0 -c paperclip --since=5m | grep "gbrain retain"
```

Expected: `gbrain retain wrote timeline entry` log line with `runId`, `issueSlug`, `agentSlug` fields.

- [ ] **Step 4: Confirm in gbrain admin UI**

```bash
kubectl -n paperclip port-forward svc/gbrain-mcp-admin 3130:3130 &
```

Open http://localhost:3130/admin (login token from `kubectl logs ... -c admin-ui --tail=200 | grep -A1 'Admin Token'`).
Browse to the issue page (slug `issue/<identifier>`) — confirm the timeline entry shows up with the run output and identity metadata.

---

## Self-review

**Spec coverage:**
- Architecture diagram (spec §2 sync path) → Tasks 5 (helpers) + 6 (handler) + 7 (worker) ✓
- Components file layout (spec §3) → Tasks 1 + 2 + 3 + 4 + 5 + 6 + 7 ✓
- Config schema (spec §4) → Task 2 manifest ✓
- MCP transport in-cluster URL, no auth (spec §2 Transport) → Task 4 + manifest default ✓
- Page conventions (spec §2.2) → Task 3 identity ✓
- Link conventions (spec §2.3) — only `worked_on` in wave 1 → Task 5 ✓
- Error handling: 15s timeout, never throw out of plugin (spec §5) → Task 4 + Task 6 ✓
- Idempotency: get_page then put_page (spec §5) → Task 5 ✓
- Identity binding via metadata (spec §1, §2) → Tasks 5 + 6 ✓
- Build & deploy (spec §8) → Tasks 8 + 9 ✓
- Out of scope items: recall, fact-promotion, gbrain_recall_cache, tool surface — correctly excluded from this plan; flagged for wave 2 ✓

**Placeholder scan:** no TBDs/TODOs in tasks; the one "look up the real path in SDK types" note in Task 7 is bounded by a clearly-described investigation and references in-tree examples. Acceptable.

**Type consistency:** `GbrainCallable` interface used in Tasks 5 + 6 + 7; `Logger` interface defined in Task 6 and consumed in Task 7; `RunFinishedEventShape` defined in Task 6 and consumed in Task 7. All consistent.

**Naming consistency:** `ensureIssuePage`, `ensureAgentPage`, `addWorkedOnLink`, `addRunTimelineEntry` are used identically in pages.ts (Task 5), handlers.ts (Task 6), and handlers.test.ts (Task 6). `PLUGIN_ID = "kkroo.gbrain"` consistent across manifest.ts (Task 2), Dockerfile/bootstrap (Task 8), and DB lookup (Task 10).

---

## Open follow-ups (for wave 2 plan)

These were flagged in the spec §9 as "resolve during plan phase" but explicitly belong to wave 2:

- Run-context injection for recall (gbrain_recall_cache tool OR SDK primitive)
- Plugin deferred-job primitive verification (`ctx.jobs.schedule`)
- Page-slug cross-company collision (companyId prefix or tag-based namespacing)
- Hindsight `metadata.runId` query API
- Failure-mode timeline entries (`agent.run.failed` handler)

These do NOT block wave 1.
