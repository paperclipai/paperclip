# Pushover Watch Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Paperclip plugin (`@paperclipai/plugin-pushover-watch`) that listens to `issue.updated`, `issue.comment.created`, and `approval.created` events for the WHITESTAG and Health Insights companies and emits Apple-Watch-bound Pushover notifications for five specific triggers (CEO/CHO task done, in_review handover to Walter, blocked + Walter-mention, comment mention of Walter, pending board approval).

**Architecture:** Single Paperclip plugin worker, scaffolded via `@paperclipai/create-paperclip-plugin`. Stateless functional core (`mentions.ts`, `transitions.ts`, `pushover-client.ts`) wrapped by event handlers (`triggers.ts`) wired up in `worker.ts`. State is held in `ctx.state` keyed by `scopeKind: "issue"` for transition detection, plus a per-company bootstrap marker. Per-company behaviour is driven by an instance config with a `companies[]` array (no runtime per-company plugin install).

**Tech Stack:** TypeScript, `@paperclipai/plugin-sdk` (worker SDK + testing harness), Vitest, esbuild (worker bundle), rollup (not used — no UI). Pushover API via `ctx.http.fetch`.

**Spec:** [docs/superpowers/specs/2026-05-11-pushover-watch-plugin-design.md](../specs/2026-05-11-pushover-watch-plugin-design.md)

---

## File Map

| File | Responsibility |
|---|---|
| `packages/plugins/pushover-watch/src/manifest.ts` | `PaperclipPluginManifestV1` with capabilities, `instanceConfigSchema`, `entrypoints.worker`. |
| `packages/plugins/pushover-watch/src/config-schema.ts` | TS types mirroring the JSON-schema config (no Zod, just types). |
| `packages/plugins/pushover-watch/src/mentions.ts` | Pure: parse `[@Name](user://<uuid>)` mentions. |
| `packages/plugins/pushover-watch/src/transitions.ts` | Pure: `matchesT1/T2/T3` predicates over `CachedIssueState`. |
| `packages/plugins/pushover-watch/src/pushover-client.ts` | Thin wrapper around `ctx.http.fetch` to POST `api.pushover.net/1/messages.json`. |
| `packages/plugins/pushover-watch/src/bootstrap.ts` | Per-company bootstrap: seed `ctx.state` cache for all open issues, set marker. |
| `packages/plugins/pushover-watch/src/triggers.ts` | Event handlers (`handleIssueUpdated`, `handleCommentCreated`, `handleApprovalCreated`) that resolve secrets, compose payload, dispatch via `sendPushover`. |
| `packages/plugins/pushover-watch/src/worker.ts` | `definePlugin({ setup })` + `runWorker(plugin, import.meta.url)`. |
| `packages/plugins/pushover-watch/src/index.ts` | Re-exports manifest for the scaffold/host loader. |
| `packages/plugins/pushover-watch/tests/mentions.test.ts` | Unit tests for mention parser. |
| `packages/plugins/pushover-watch/tests/transitions.test.ts` | Unit tests for transition predicates. |
| `packages/plugins/pushover-watch/tests/pushover-client.test.ts` | Unit tests for the HTTP wrapper with a mocked `ctx.http.fetch`. |
| `packages/plugins/pushover-watch/tests/triggers.test.ts` | Unit tests for handler dispatch (mocked ctx). |
| `packages/plugins/pushover-watch/tests/worker.spec.ts` | Integration test via `createTestHarness` from `@paperclipai/plugin-sdk/testing`. |

---

## Task 1: Scaffold the plugin package

**Files:**
- Create (via scaffold): `packages/plugins/pushover-watch/` (full skeleton)

- [ ] **Step 1: Build the scaffold tool**

Run from the repo root:

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
```

Expected: build completes; `packages/plugins/create-paperclip-plugin/dist/index.js` exists.

- [ ] **Step 2: Run the scaffold**

```bash
node packages/plugins/create-paperclip-plugin/dist/index.js \
  @paperclipai/plugin-pushover-watch \
  --output ./packages/plugins
```

Expected: a new directory `packages/plugins/plugin-pushover-watch/` (or similar — verify exact folder name written by the scaffold; if it differs from `pushover-watch`, rename it to `packages/plugins/pushover-watch` before proceeding).

- [ ] **Step 3: Rename the folder if needed and verify the layout**

```bash
ls packages/plugins/pushover-watch/
```

Expected: `package.json`, `src/{manifest.ts,worker.ts,index.ts}`, `tests/`, `esbuild.config.mjs`, `rollup.config.mjs` (rollup is present but will be unused — UI is out of scope).

- [ ] **Step 4: Install workspace dependencies**

```bash
pnpm install
```

Expected: lockfile updates with the new workspace package.

- [ ] **Step 5: Smoke-build the scaffolded skeleton**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch typecheck
pnpm --filter @paperclipai/plugin-pushover-watch test
pnpm --filter @paperclipai/plugin-pushover-watch build
```

Expected: all three pass on the unmodified scaffold output.

- [ ] **Step 6: Commit the scaffold**

```bash
git add packages/plugins/pushover-watch pnpm-lock.yaml
git commit -m "feat(pushover-watch): scaffold plugin package

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Replace the scaffolded manifest

**Files:**
- Modify: `packages/plugins/pushover-watch/src/manifest.ts`

- [ ] **Step 1: Overwrite the manifest**

Replace the entire contents of `packages/plugins/pushover-watch/src/manifest.ts` with:

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "whitestag.pushover-watch",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Pushover Watch Notifications",
  description:
    "Sends Apple Watch notifications via Pushover for CEO-done tasks and board-wait states. Multi-company-aware via instance config.",
  author: "WHITESTAG",
  categories: ["notifications"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.comments.read",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      pushoverUserKeyRef: {
        type: "string",
        title: "Pushover User Key (secret reference UUID)",
      },
      pushoverAppTokenRef: {
        type: "string",
        title: "Pushover App Token (secret reference UUID)",
      },
      boardUserId: {
        type: "string",
        title: "Board User ID",
        default: "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9",
      },
      clickbackBaseUrl: {
        type: "string",
        format: "uri",
        title: "Paperclip Web Base URL",
        default: "https://company.whitestag.ai",
      },
      dryRun: { type: "boolean", default: false },
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            companyId: { type: "string", format: "uuid" },
            issuePrefix: { type: "string" },
            topAgentIds: { type: "array", items: { type: "string", format: "uuid" } },
            enabled: { type: "boolean", default: true },
          },
          required: ["companyId", "issuePrefix", "topAgentIds"],
        },
        default: [
          {
            companyId: "9cebf3cf-efe8-4597-a400-f06488900a87",
            issuePrefix: "WHI",
            topAgentIds: ["506c873e-3a40-4483-9a45-0eb0fa1554bb"],
            enabled: true,
          },
          {
            companyId: "158c4959-4973-4cb0-8066-55ec0f35625e",
            issuePrefix: "HEA",
            topAgentIds: ["6ddf2bfa-fe1c-4e26-a316-091b6ef3c182"],
            enabled: true,
          },
        ],
      },
    },
    required: ["pushoverUserKeyRef", "pushoverAppTokenRef", "boardUserId", "companies"],
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch typecheck
```

Expected: no errors. If `PaperclipPluginManifestV1` rejects one of the capability strings, search the SDK exports (`packages/plugins/sdk/src/index.ts`) for `PLUGIN_CAPABILITIES` and align the names.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pushover-watch/src/manifest.ts
git commit -m "feat(pushover-watch): manifest with capabilities and instance config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Define TS config types

**Files:**
- Create: `packages/plugins/pushover-watch/src/config-schema.ts`

- [ ] **Step 1: Write the config types**

Create `packages/plugins/pushover-watch/src/config-schema.ts`:

```ts
export type CompanyConfig = {
  companyId: string;
  issuePrefix: string;
  topAgentIds: string[];
  enabled?: boolean;
};

export type PluginConfig = {
  pushoverUserKeyRef: string;
  pushoverAppTokenRef: string;
  boardUserId: string;
  clickbackBaseUrl: string;
  dryRun?: boolean;
  companies: CompanyConfig[];
};

export type CachedIssueState = {
  status:
    | "backlog"
    | "todo"
    | "in_progress"
    | "in_review"
    | "done"
    | "blocked"
    | "cancelled";
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: string;
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch typecheck
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pushover-watch/src/config-schema.ts
git commit -m "feat(pushover-watch): config + cached-issue-state types

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Mention parser (TDD)

**Files:**
- Test: `packages/plugins/pushover-watch/tests/mentions.test.ts`
- Create: `packages/plugins/pushover-watch/src/mentions.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/pushover-watch/tests/mentions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findMentionedUsers, commentMentionsUser } from "../src/mentions.js";

const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";

describe("findMentionedUsers", () => {
  it("returns empty set on empty body", () => {
    expect(findMentionedUsers("")).toEqual(new Set());
  });

  it("returns empty set on body without mentions", () => {
    expect(findMentionedUsers("Just a comment, no pings.")).toEqual(new Set());
  });

  it("extracts a single mention", () => {
    const body = `Hey [@Walter](user://${WALTER}), please review.`;
    expect(findMentionedUsers(body)).toEqual(new Set([WALTER]));
  });

  it("extracts multiple distinct mentions", () => {
    const body = `[@A](user://aaa) and [@B](user://bbb)`;
    expect(findMentionedUsers(body)).toEqual(new Set(["aaa", "bbb"]));
  });

  it("deduplicates the same user mentioned twice", () => {
    const body = `[@A](user://aaa) and [@A again](user://aaa)`;
    expect(findMentionedUsers(body)).toEqual(new Set(["aaa"]));
  });

  it("ignores bare @-mentions without the markdown link", () => {
    expect(findMentionedUsers("Hey @Walter, no link")).toEqual(new Set());
  });
});

describe("commentMentionsUser", () => {
  it("returns true when the user is mentioned", () => {
    const body = `[@Walter](user://${WALTER}) review please`;
    expect(commentMentionsUser(body, WALTER)).toBe(true);
  });

  it("returns false when the user is not mentioned", () => {
    const body = `[@Other](user://other-id) review please`;
    expect(commentMentionsUser(body, WALTER)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- mentions
```

Expected: FAIL — `mentions.js` not found.

- [ ] **Step 3: Implement**

Create `packages/plugins/pushover-watch/src/mentions.ts`:

```ts
const MENTION_PATTERN = /\[@[^\]]+\]\(user:\/\/([a-zA-Z0-9_-]+)\)/g;

export function findMentionedUsers(body: string): Set<string> {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_PATTERN)) {
    ids.add(m[1]);
  }
  return ids;
}

export function commentMentionsUser(body: string, userId: string): boolean {
  return findMentionedUsers(body).has(userId);
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- mentions
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pushover-watch/src/mentions.ts packages/plugins/pushover-watch/tests/mentions.test.ts
git commit -m "feat(pushover-watch): mention parser with tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Transition predicates (TDD)

**Files:**
- Test: `packages/plugins/pushover-watch/tests/transitions.test.ts`
- Create: `packages/plugins/pushover-watch/src/transitions.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/pushover-watch/tests/transitions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchesT1, matchesT2, matchesT3 } from "../src/transitions.js";
import type { CachedIssueState } from "../src/config-schema.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";

function state(over: Partial<CachedIssueState> = {}): CachedIssueState {
  return {
    status: "in_progress",
    assigneeAgentId: null,
    assigneeUserId: null,
    updatedAt: "2026-05-11T10:00:00.000Z",
    ...over,
  };
}

describe("matchesT1 — CEO/CHO task done", () => {
  it("fires when status moves to done with assignee in topAgentIds", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: CEO });
    const next = state({ status: "done", assigneeAgentId: CEO });
    expect(matchesT1(prev, next, [CEO])).toBe(true);
  });

  it("does not fire when status was already done", () => {
    const prev = state({ status: "done", assigneeAgentId: CEO });
    const next = state({ status: "done", assigneeAgentId: CEO });
    expect(matchesT1(prev, next, [CEO])).toBe(false);
  });

  it("does not fire when assignee is not in topAgentIds", () => {
    const prev = state({ status: "in_progress", assigneeAgentId: "other-agent" });
    const next = state({ status: "done", assigneeAgentId: "other-agent" });
    expect(matchesT1(prev, next, [CEO])).toBe(false);
  });

  it("does not fire when status is not done", () => {
    const prev = state({ status: "todo", assigneeAgentId: CEO });
    const next = state({ status: "in_progress", assigneeAgentId: CEO });
    expect(matchesT1(prev, next, [CEO])).toBe(false);
  });
});

describe("matchesT2 — in_review handover to board user", () => {
  it("fires when status moves to in_review with board user as assignee", () => {
    const prev = state({ status: "in_progress" });
    const next = state({ status: "in_review", assigneeUserId: WALTER });
    expect(matchesT2(prev, next, WALTER)).toBe(true);
  });

  it("does not fire when assignee is a different user", () => {
    const prev = state({ status: "in_progress" });
    const next = state({ status: "in_review", assigneeUserId: "other-user" });
    expect(matchesT2(prev, next, WALTER)).toBe(false);
  });

  it("does not fire when status was already in_review", () => {
    const prev = state({ status: "in_review", assigneeUserId: WALTER });
    const next = state({ status: "in_review", assigneeUserId: WALTER });
    expect(matchesT2(prev, next, WALTER)).toBe(false);
  });
});

describe("matchesT3 — blocked transition (mention check is caller's job)", () => {
  it("fires on transition into blocked", () => {
    const prev = state({ status: "in_progress" });
    const next = state({ status: "blocked" });
    expect(matchesT3(prev, next)).toBe(true);
  });

  it("does not fire when already blocked", () => {
    const prev = state({ status: "blocked" });
    const next = state({ status: "blocked" });
    expect(matchesT3(prev, next)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- transitions
```

Expected: FAIL — `transitions.js` not found.

- [ ] **Step 3: Implement**

Create `packages/plugins/pushover-watch/src/transitions.ts`:

```ts
import type { CachedIssueState } from "./config-schema.js";

export function matchesT1(
  prev: CachedIssueState,
  next: CachedIssueState,
  topAgentIds: string[],
): boolean {
  if (next.status !== "done") return false;
  if (prev.status === "done") return false;
  if (!next.assigneeAgentId) return false;
  return topAgentIds.includes(next.assigneeAgentId);
}

export function matchesT2(
  prev: CachedIssueState,
  next: CachedIssueState,
  boardUserId: string,
): boolean {
  if (next.status !== "in_review") return false;
  if (prev.status === "in_review") return false;
  return next.assigneeUserId === boardUserId;
}

export function matchesT3(
  prev: CachedIssueState,
  next: CachedIssueState,
): boolean {
  if (next.status !== "blocked") return false;
  if (prev.status === "blocked") return false;
  return true;
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- transitions
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pushover-watch/src/transitions.ts packages/plugins/pushover-watch/tests/transitions.test.ts
git commit -m "feat(pushover-watch): transition predicates T1/T2/T3 with tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Pushover client (TDD with mocked ctx.http)

**Files:**
- Test: `packages/plugins/pushover-watch/tests/pushover-client.test.ts`
- Create: `packages/plugins/pushover-watch/src/pushover-client.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/pushover-watch/tests/pushover-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { sendPushover } from "../src/pushover-client.js";

function makeCtx(fetchImpl: (url: string, opts: any) => Promise<Response>) {
  return {
    http: { fetch: vi.fn(fetchImpl) },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as any;
}

describe("sendPushover", () => {
  it("POSTs the expected form-encoded payload to api.pushover.net", async () => {
    const ctx = makeCtx(async () => new Response("{}", { status: 200 }));

    const res = await sendPushover(ctx, {
      userKey: "u-key",
      appToken: "a-token",
      title: "[WHI] CEO erledigt: Cleanup",
      message: "issue body…",
      url: "https://company.whitestag.ai/WHI/issues/WHI-1",
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    });

    expect(res).toEqual({ ok: true, status: 200 });
    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = ctx.http.fetch.mock.calls[0];
    expect(calledUrl).toBe("https://api.pushover.net/1/messages.json");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("token")).toBe("a-token");
    expect(body.get("user")).toBe("u-key");
    expect(body.get("title")).toBe("[WHI] CEO erledigt: Cleanup");
    expect(body.get("priority")).toBe("0");
  });

  it("returns ok:false on non-2xx and logs a warning", async () => {
    const ctx = makeCtx(async () => new Response("nope", { status: 401 }));

    const res = await sendPushover(ctx, {
      userKey: "u",
      appToken: "t",
      title: "x",
      message: "y",
      url: "https://example.com",
      urlTitle: "open",
      priority: 0,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "pushover_send_failed",
      expect.objectContaining({ status: 401 }),
    );
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- pushover-client
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/plugins/pushover-watch/src/pushover-client.ts`:

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";

export type SendParams = {
  userKey: string;
  appToken: string;
  title: string;
  message: string;
  url: string;
  urlTitle: string;
  priority: 0 | 1;
};

export type SendResult = { ok: boolean; status?: number };

export async function sendPushover(
  ctx: PluginContext,
  params: SendParams,
): Promise<SendResult> {
  const body = new URLSearchParams({
    token: params.appToken,
    user: params.userKey,
    title: params.title,
    message: params.message,
    url: params.url,
    url_title: params.urlTitle,
    priority: String(params.priority),
  });

  const res = await ctx.http.fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    ctx.logger.warn("pushover_send_failed", { status: res.status });
    return { ok: false, status: res.status };
  }
  return { ok: true, status: res.status };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- pushover-client
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pushover-watch/src/pushover-client.ts packages/plugins/pushover-watch/tests/pushover-client.test.ts
git commit -m "feat(pushover-watch): pushover HTTP client with tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Bootstrap routine (TDD)

**Files:**
- Test: `packages/plugins/pushover-watch/tests/bootstrap.test.ts`
- Create: `packages/plugins/pushover-watch/src/bootstrap.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/pushover-watch/tests/bootstrap.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { bootstrapCompany } from "../src/bootstrap.js";

function makeCtx() {
  const stateStore = new Map<string, unknown>();
  const stateKey = (s: any) =>
    `${s.scopeKind}:${s.scopeId ?? "_"}:${s.stateKey}`;

  return {
    state: {
      get: vi.fn(async (s: any) => stateStore.get(stateKey(s)) ?? null),
      set: vi.fn(async (s: any, v: unknown) => {
        stateStore.set(stateKey(s), v);
      }),
      delete: vi.fn(async (s: any) => {
        stateStore.delete(stateKey(s));
      }),
    },
    issues: {
      list: vi.fn(async () => [
        {
          id: "iss-1",
          status: "in_progress",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-05-11T09:00:00.000Z"),
        },
        {
          id: "iss-2",
          status: "in_review",
          assigneeAgentId: null,
          assigneeUserId: "user-1",
          updatedAt: new Date("2026-05-11T09:30:00.000Z"),
        },
      ]),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as any;
}

describe("bootstrapCompany", () => {
  it("seeds state for all open issues and sets the bootstrap marker", async () => {
    const ctx = makeCtx();
    await bootstrapCompany(ctx, {
      companyId: "company-1",
      issuePrefix: "WHI",
      topAgentIds: ["agent-1"],
    });

    // marker
    const marker = await ctx.state.get({
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "pushover-watch:bootstrap-done",
    });
    expect(marker).not.toBeNull();

    // issue states
    const iss1 = await ctx.state.get({
      scopeKind: "issue",
      scopeId: "iss-1",
      stateKey: "pushover-watch:last-seen",
    });
    expect(iss1).toMatchObject({
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });

    const iss2 = await ctx.state.get({
      scopeKind: "issue",
      scopeId: "iss-2",
      stateKey: "pushover-watch:last-seen",
    });
    expect(iss2).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
    });
  });

  it("is idempotent — does nothing on the second call", async () => {
    const ctx = makeCtx();
    await bootstrapCompany(ctx, {
      companyId: "company-1",
      issuePrefix: "WHI",
      topAgentIds: ["agent-1"],
    });
    ctx.issues.list.mockClear();
    await bootstrapCompany(ctx, {
      companyId: "company-1",
      issuePrefix: "WHI",
      topAgentIds: ["agent-1"],
    });
    expect(ctx.issues.list).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- bootstrap
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/plugins/pushover-watch/src/bootstrap.ts`:

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CompanyConfig, CachedIssueState } from "./config-schema.js";

const OPEN_STATUSES: ReadonlyArray<CachedIssueState["status"]> = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];

export async function bootstrapCompany(
  ctx: PluginContext,
  company: CompanyConfig,
): Promise<void> {
  const marker = await ctx.state.get({
    scopeKind: "company",
    scopeId: company.companyId,
    stateKey: "pushover-watch:bootstrap-done",
  });
  if (marker) {
    ctx.logger.info("pushover_watch_bootstrap_skipped", {
      companyId: company.companyId,
    });
    return;
  }

  let totalSeeded = 0;
  for (const status of OPEN_STATUSES) {
    const issues = await ctx.issues.list({
      companyId: company.companyId,
      status,
      limit: 1000,
    });
    for (const issue of issues) {
      const cached: CachedIssueState = {
        status: issue.status as CachedIssueState["status"],
        assigneeAgentId: issue.assigneeAgentId ?? null,
        assigneeUserId: issue.assigneeUserId ?? null,
        updatedAt:
          issue.updatedAt instanceof Date
            ? issue.updatedAt.toISOString()
            : String(issue.updatedAt),
      };
      await ctx.state.set(
        {
          scopeKind: "issue",
          scopeId: issue.id,
          stateKey: "pushover-watch:last-seen",
        },
        cached,
      );
      totalSeeded += 1;
    }
  }

  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: company.companyId,
      stateKey: "pushover-watch:bootstrap-done",
    },
    { at: new Date().toISOString() },
  );

  ctx.logger.info("pushover_watch_bootstrap_done", {
    companyId: company.companyId,
    seeded: totalSeeded,
  });
}
```

Note: `ctx.issues.list` accepts a single `status` (per `PluginIssuesClient.list` in the SDK), so the bootstrap loops over the four open statuses.

- [ ] **Step 4: Adjust the test to match the looped call shape**

The test mock `ctx.issues.list` returns the same two issues for each of the four calls. That's fine — `state.set` is idempotent on the same key, so the final state still matches. No test change needed if the assertions pass; if they fail because the issues appear four times, change the mock to return rows only on `status === "in_progress"` and `status === "in_review"`:

```ts
issues: {
  list: vi.fn(async ({ status }: { status: string }) => {
    if (status === "in_progress") return [{ id: "iss-1", status: "in_progress", assigneeAgentId: "agent-1", assigneeUserId: null, updatedAt: new Date("2026-05-11T09:00:00.000Z") }];
    if (status === "in_review") return [{ id: "iss-2", status: "in_review", assigneeAgentId: null, assigneeUserId: "user-1", updatedAt: new Date("2026-05-11T09:30:00.000Z") }];
    return [];
  }),
},
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- bootstrap
```

Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pushover-watch/src/bootstrap.ts packages/plugins/pushover-watch/tests/bootstrap.test.ts
git commit -m "feat(pushover-watch): per-company bootstrap of state cache

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Event handlers — issue.updated (T1–T3)

**Files:**
- Test: `packages/plugins/pushover-watch/tests/triggers.test.ts`
- Create: `packages/plugins/pushover-watch/src/triggers.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugins/pushover-watch/tests/triggers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleIssueUpdated } from "../src/triggers.js";
import type { PluginConfig, CachedIssueState } from "../src/config-schema.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";
const WHI = "9cebf3cf-efe8-4597-a400-f06488900a87";

function baseConfig(): PluginConfig {
  return {
    pushoverUserKeyRef: "key-uuid",
    pushoverAppTokenRef: "token-uuid",
    boardUserId: WALTER,
    clickbackBaseUrl: "https://company.whitestag.ai",
    dryRun: false,
    companies: [
      { companyId: WHI, issuePrefix: "WHI", topAgentIds: [CEO], enabled: true },
    ],
  };
}

function makeCtx(prev: CachedIssueState | null) {
  const stateStore = new Map<string, unknown>();
  if (prev) stateStore.set("issue:iss-1:last-seen", prev);
  return {
    state: {
      get: vi.fn(async (s: any) => stateStore.get(`${s.scopeKind}:${s.scopeId}:${s.stateKey.split(":").slice(-1)[0]}`) ?? null),
      set: vi.fn(async () => {}),
    },
    http: { fetch: vi.fn(async () => new Response("{}", { status: 200 })) },
    secrets: { resolve: vi.fn(async (ref: string) => `resolved-${ref}`) },
    issues: { listComments: vi.fn(async () => []) },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as any;
}

function event(over: any) {
  return {
    eventId: "evt-1",
    eventType: "issue.updated",
    occurredAt: "2026-05-11T10:00:00.000Z",
    companyId: WHI,
    entityId: "iss-1",
    entityType: "issue",
    payload: {
      id: "iss-1",
      identifier: "WHI-42",
      title: "Cleanup",
      status: "done",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      ...over,
    },
  };
}

describe("handleIssueUpdated", () => {
  it("fires T1 when CEO task moves to done", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    await handleIssueUpdated(ctx, baseConfig(), event({}));

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] CEO erledigt:/);
    expect(body.get("url")).toBe("https://company.whitestag.ai/WHI/issues/WHI-42");
    expect(body.get("priority")).toBe("0");
  });

  it("does not fire when prev state is unknown (post-bootstrap-gap safety)", async () => {
    const ctx = makeCtx(null);
    await handleIssueUpdated(ctx, baseConfig(), event({}));
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("fires T2 when status moves to in_review and assigneeUserId is the board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    await handleIssueUpdated(
      ctx,
      baseConfig(),
      event({ status: "in_review", assigneeUserId: WALTER }),
    );
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] Review-Handover:/);
  });

  it("fires T3 when status moves to blocked AND latest comment mentions board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    ctx.issues.listComments = vi.fn(async () => [
      {
        id: "c-1",
        body: `Waiting on [@Walter](user://${WALTER})`,
        authorAgentId: "agent-x",
        authorUserId: null,
        createdAt: new Date(),
      },
    ]);
    await handleIssueUpdated(ctx, baseConfig(), event({ status: "blocked" }));
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] Blockiert, braucht dich:/);
    expect(body.get("priority")).toBe("1");
  });

  it("does NOT fire T3 when latest comment doesn't mention board user", async () => {
    const prev: CachedIssueState = {
      status: "in_progress",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      updatedAt: "2026-05-11T09:00:00.000Z",
    };
    const ctx = makeCtx(prev);
    ctx.issues.listComments = vi.fn(async () => [
      { id: "c-1", body: "no mentions", authorAgentId: "x", authorUserId: null, createdAt: new Date() },
    ]);
    await handleIssueUpdated(ctx, baseConfig(), event({ status: "blocked" }));
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});
```

(Note: the `state.get` key shape in `makeCtx` is simplified — implementation will use a stable composite. Test key matches the `issue:iss-1:last-seen` form.)

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- triggers
```

Expected: FAIL — `triggers.js` not found.

- [ ] **Step 3: Implement triggers.ts (issue.updated only for now)**

Create `packages/plugins/pushover-watch/src/triggers.ts`:

```ts
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type {
  PluginConfig,
  CompanyConfig,
  CachedIssueState,
} from "./config-schema.js";
import { matchesT1, matchesT2, matchesT3 } from "./transitions.js";
import { commentMentionsUser } from "./mentions.js";
import { sendPushover, type SendParams } from "./pushover-client.js";

type IssueUpdatedPayload = {
  id: string;
  identifier: string | null;
  title: string;
  status: CachedIssueState["status"];
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function issueStateKey(issueId: string) {
  return {
    scopeKind: "issue" as const,
    scopeId: issueId,
    stateKey: "pushover-watch:last-seen",
  };
}

function findCompany(config: PluginConfig, companyId: string): CompanyConfig | undefined {
  return config.companies.find((c) => c.companyId === companyId && c.enabled !== false);
}

function issueUrl(config: PluginConfig, company: CompanyConfig, identifier: string | null): string {
  if (!identifier) return config.clickbackBaseUrl;
  return `${config.clickbackBaseUrl}/${company.issuePrefix}/issues/${identifier}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function dispatch(
  ctx: PluginContext,
  config: PluginConfig,
  send: SendParams,
): Promise<void> {
  if (config.dryRun) {
    ctx.logger.info("pushover_watch_dry_run", { send });
    return;
  }
  await sendPushover(ctx, send);
}

async function resolveCredentials(
  ctx: PluginContext,
  config: PluginConfig,
): Promise<{ userKey: string; appToken: string }> {
  const [userKey, appToken] = await Promise.all([
    ctx.secrets.resolve(config.pushoverUserKeyRef),
    ctx.secrets.resolve(config.pushoverAppTokenRef),
  ]);
  return { userKey, appToken };
}

export async function handleIssueUpdated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent<IssueUpdatedPayload>,
): Promise<void> {
  const company = findCompany(config, event.companyId);
  if (!company) return;

  const issueId = event.entityId;
  if (!issueId) return;

  const prev = (await ctx.state.get(issueStateKey(issueId))) as CachedIssueState | null;

  const next: CachedIssueState = {
    status: event.payload.status,
    assigneeAgentId: event.payload.assigneeAgentId,
    assigneeUserId: event.payload.assigneeUserId,
    updatedAt: event.occurredAt,
  };

  await ctx.state.set(issueStateKey(issueId), next);

  if (!prev) return; // unknown issue — seed only, no notification

  const url = issueUrl(config, company, event.payload.identifier);

  // T1: CEO/CHO done
  if (matchesT1(prev, next, company.topAgentIds)) {
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(ctx, config, {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] CEO erledigt: ${truncate(event.payload.title, 80)}`,
      message: event.payload.title,
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    });
    return;
  }

  // T2: in_review handover to board user
  if (matchesT2(prev, next, config.boardUserId)) {
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(ctx, config, {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] Review-Handover: ${truncate(event.payload.title, 80)}`,
      message: event.payload.title,
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    });
    return;
  }

  // T3: transition into blocked AND latest comment mentions board user
  if (matchesT3(prev, next)) {
    const comments = await ctx.issues.listComments(issueId, event.companyId);
    const latest = comments[comments.length - 1];
    if (!latest || !commentMentionsUser(latest.body, config.boardUserId)) return;
    const { userKey, appToken } = await resolveCredentials(ctx, config);
    await dispatch(ctx, config, {
      userKey,
      appToken,
      title: `[${company.issuePrefix}] Blockiert, braucht dich: ${truncate(event.payload.title, 80)}`,
      message: truncate(latest.body, 200),
      url,
      urlTitle: "In Paperclip öffnen",
      priority: 1,
    });
  }
}
```

- [ ] **Step 4: Adjust the test's state-key shape if needed**

Re-read `handleIssueUpdated` and ensure the test's `makeCtx.state.get` mock returns the seeded value when called with `{scopeKind: "issue", scopeId: "iss-1", stateKey: "pushover-watch:last-seen"}`. If the test fails because the mock returns `null`, change the mock to:

```ts
get: vi.fn(async (s: any) => {
  if (s.scopeKind === "issue" && s.scopeId === "iss-1" && s.stateKey === "pushover-watch:last-seen") {
    return prev;
  }
  return null;
}),
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- triggers
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pushover-watch/src/triggers.ts packages/plugins/pushover-watch/tests/triggers.test.ts
git commit -m "feat(pushover-watch): handleIssueUpdated for T1/T2/T3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Event handlers — comment.created (T4) and approval.created (T5)

**Files:**
- Modify: `packages/plugins/pushover-watch/src/triggers.ts`
- Modify: `packages/plugins/pushover-watch/tests/triggers.test.ts`

- [ ] **Step 1: Add failing tests for T4 and T5**

Append to `packages/plugins/pushover-watch/tests/triggers.test.ts`:

```ts
import { handleCommentCreated, handleApprovalCreated } from "../src/triggers.js";

describe("handleCommentCreated (T4)", () => {
  it("fires when comment body mentions board user and author is not Walter", async () => {
    const ctx = makeCtx(null);
    await handleCommentCreated(ctx, baseConfig(), {
      eventId: "evt-2",
      eventType: "issue.comment.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "c-1",
      entityType: "comment",
      payload: {
        id: "c-1",
        issueId: "iss-1",
        body: `Hi [@Walter](user://${WALTER}), thoughts?`,
        authorAgentId: "agent-x",
        authorUserId: null,
        issueIdentifier: "WHI-42",
        issueTitle: "Cleanup",
      },
    } as any);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] @-Mention/);
  });

  it("does not fire when author IS Walter (self-mention)", async () => {
    const ctx = makeCtx(null);
    await handleCommentCreated(ctx, baseConfig(), {
      eventId: "evt-3",
      eventType: "issue.comment.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "c-2",
      entityType: "comment",
      payload: {
        id: "c-2",
        issueId: "iss-1",
        body: `Note to self [@Walter](user://${WALTER})`,
        authorAgentId: null,
        authorUserId: WALTER,
        issueIdentifier: "WHI-42",
        issueTitle: "Cleanup",
      },
    } as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("does not fire when body has no mention of board user", async () => {
    const ctx = makeCtx(null);
    await handleCommentCreated(ctx, baseConfig(), {
      eventId: "evt-4",
      eventType: "issue.comment.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "c-3",
      entityType: "comment",
      payload: {
        id: "c-3",
        issueId: "iss-1",
        body: "plain comment, no mention",
        authorAgentId: "agent-x",
        authorUserId: null,
        issueIdentifier: "WHI-42",
        issueTitle: "Cleanup",
      },
    } as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});

describe("handleApprovalCreated (T5)", () => {
  it("fires on pending request_board_approval", async () => {
    const ctx = makeCtx(null);
    await handleApprovalCreated(ctx, baseConfig(), {
      eventId: "evt-5",
      eventType: "approval.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "appr-1",
      entityType: "approval",
      payload: {
        id: "appr-1",
        type: "request_board_approval",
        status: "pending",
        title: "Approve monthly hosting spend",
      },
    } as any);
    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body);
    expect(body.get("priority")).toBe("1");
    expect(body.get("title")).toMatch(/^\[WHI\] Approval wartet:/);
    expect(body.get("url")).toBe("https://company.whitestag.ai/WHI/approvals/appr-1");
  });

  it("does not fire on non-pending or non-board-approval payload", async () => {
    const ctx = makeCtx(null);
    await handleApprovalCreated(ctx, baseConfig(), {
      eventId: "evt-6",
      eventType: "approval.created",
      occurredAt: "2026-05-11T10:05:00.000Z",
      companyId: WHI,
      entityId: "appr-2",
      entityType: "approval",
      payload: { id: "appr-2", type: "hire_agent", status: "pending", title: "Hire" },
    } as any);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- triggers
```

Expected: 5 tests pass (T1–T3 already implemented), 5 new tests FAIL (handleCommentCreated / handleApprovalCreated not exported).

- [ ] **Step 3: Implement T4 and T5**

Append to `packages/plugins/pushover-watch/src/triggers.ts`:

```ts
type CommentCreatedPayload = {
  id: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
};

export async function handleCommentCreated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent<CommentCreatedPayload>,
): Promise<void> {
  const company = findCompany(config, event.companyId);
  if (!company) return;

  if (event.payload.authorUserId === config.boardUserId) return; // ignore self-mentions
  if (!commentMentionsUser(event.payload.body, config.boardUserId)) return;

  const url = issueUrl(config, company, event.payload.issueIdentifier);
  const { userKey, appToken } = await resolveCredentials(ctx, config);
  const authorLabel =
    event.payload.authorAgentId ? `Agent ${event.payload.authorAgentId.slice(0, 8)}` : "jemand";

  await dispatch(ctx, config, {
    userKey,
    appToken,
    title: `[${company.issuePrefix}] @-Mention von ${authorLabel}: ${truncate(event.payload.issueTitle ?? "", 60)}`,
    message: truncate(event.payload.body, 200),
    url,
    urlTitle: "In Paperclip öffnen",
    priority: 0,
  });
}

type ApprovalCreatedPayload = {
  id: string;
  type: string;
  status: string;
  title?: string;
};

export async function handleApprovalCreated(
  ctx: PluginContext,
  config: PluginConfig,
  event: PluginEvent<ApprovalCreatedPayload>,
): Promise<void> {
  const company = findCompany(config, event.companyId);
  if (!company) return;
  if (event.payload.type !== "request_board_approval") return;
  if (event.payload.status !== "pending") return;

  const { userKey, appToken } = await resolveCredentials(ctx, config);
  const approvalUrl = `${config.clickbackBaseUrl}/${company.issuePrefix}/approvals/${event.payload.id}`;
  const title = event.payload.title ?? "Approval-Request";

  await dispatch(ctx, config, {
    userKey,
    appToken,
    title: `[${company.issuePrefix}] Approval wartet: ${truncate(title, 80)}`,
    message: title,
    url: approvalUrl,
    urlTitle: "In Paperclip öffnen",
    priority: 1,
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test -- triggers
```

Expected: all 10 trigger tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pushover-watch/src/triggers.ts packages/plugins/pushover-watch/tests/triggers.test.ts
git commit -m "feat(pushover-watch): handleCommentCreated (T4) and handleApprovalCreated (T5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire worker.ts and integration test via createTestHarness

**Files:**
- Modify: `packages/plugins/pushover-watch/src/worker.ts`
- Modify: `packages/plugins/pushover-watch/src/index.ts`
- Create: `packages/plugins/pushover-watch/tests/worker.spec.ts`

- [ ] **Step 1: Replace worker.ts**

Overwrite `packages/plugins/pushover-watch/src/worker.ts`:

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginConfig } from "./config-schema.js";
import { bootstrapCompany } from "./bootstrap.js";
import {
  handleIssueUpdated,
  handleCommentCreated,
  handleApprovalCreated,
} from "./triggers.js";

const plugin = definePlugin({
  async setup(ctx) {
    const config = (await ctx.config.get()) as PluginConfig | null;
    if (!config || !config.companies?.length) {
      ctx.logger.warn("pushover_watch_no_companies_configured");
      return;
    }

    const enabledCompanyIds = new Set(
      config.companies.filter((c) => c.enabled !== false).map((c) => c.companyId),
    );

    for (const company of config.companies) {
      if (company.enabled === false) continue;
      await bootstrapCompany(ctx, company);
    }

    ctx.events.on("issue.updated", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleIssueUpdated(ctx, config, event as any);
    });

    ctx.events.on("issue.comment.created", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleCommentCreated(ctx, config, event as any);
    });

    ctx.events.on("approval.created", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleApprovalCreated(ctx, config, event as any);
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 2: Update index.ts to export the manifest**

Overwrite `packages/plugins/pushover-watch/src/index.ts`:

```ts
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./worker.js";
```

- [ ] **Step 3: Write the integration test**

Create `packages/plugins/pushover-watch/tests/worker.spec.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";
const WHI = "9cebf3cf-efe8-4597-a400-f06488900a87";

describe("pushover-watch worker integration", () => {
  it("fires T1 on a real issue.updated event after bootstrap seeded the prev state", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        pushoverUserKeyRef: "key-uuid",
        pushoverAppTokenRef: "token-uuid",
        boardUserId: WALTER,
        clickbackBaseUrl: "https://company.whitestag.ai",
        dryRun: false,
        companies: [
          { companyId: WHI, issuePrefix: "WHI", topAgentIds: [CEO], enabled: true },
        ],
      },
    });

    // Stub ctx.issues.list so bootstrap seeds one issue in in_progress state.
    harness.ctx.issues.list = vi.fn(async ({ status }: any) => {
      if (status === "in_progress") {
        return [
          {
            id: "iss-1",
            companyId: WHI,
            status: "in_progress",
            assigneeAgentId: CEO,
            assigneeUserId: null,
            title: "Cleanup",
            identifier: "WHI-42",
            updatedAt: new Date(),
          },
        ];
      }
      return [];
    }) as any;
    harness.ctx.issues.listComments = vi.fn(async () => []);
    harness.ctx.secrets.resolve = vi.fn(async (r: string) => `resolved-${r}`);
    harness.ctx.http.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as any;

    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.updated",
      {
        id: "iss-1",
        identifier: "WHI-42",
        title: "Cleanup",
        status: "done",
        assigneeAgentId: CEO,
        assigneeUserId: null,
      },
      { entityId: "iss-1", entityType: "issue", companyId: WHI },
    );

    expect(harness.ctx.http.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams((harness.ctx.http.fetch as any).mock.calls[0][1].body);
    expect(body.get("title")).toMatch(/^\[WHI\] CEO erledigt:/);
    expect(body.get("priority")).toBe("0");
  });

  it("does not send a notification during bootstrap", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        pushoverUserKeyRef: "k", pushoverAppTokenRef: "t",
        boardUserId: WALTER, clickbackBaseUrl: "https://example.com",
        dryRun: false,
        companies: [
          { companyId: WHI, issuePrefix: "WHI", topAgentIds: [CEO], enabled: true },
        ],
      },
    });
    harness.ctx.issues.list = vi.fn(async () => []) as any;
    harness.ctx.http.fetch = vi.fn() as any;

    await plugin.definition.setup(harness.ctx);

    expect(harness.ctx.http.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch test
```

Expected: every test PASSES (mentions, transitions, pushover-client, bootstrap, triggers, worker).

If the harness API signature differs from the example above, open `packages/plugins/sdk/src/testing.ts` and adapt to the real API — keep the assertions, change the wiring.

- [ ] **Step 5: Typecheck and build**

```bash
pnpm --filter @paperclipai/plugin-pushover-watch typecheck
pnpm --filter @paperclipai/plugin-pushover-watch build
```

Expected: pass; `dist/worker.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pushover-watch/src/worker.ts packages/plugins/pushover-watch/src/index.ts packages/plugins/pushover-watch/tests/worker.spec.ts
git commit -m "feat(pushover-watch): wire worker.ts + harness integration tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Install plugin into running Paperclip and live dry-run smoke test

**Files:**
- No code changes; this task installs the built plugin into the running dev server and runs a real event end-to-end with `dryRun: true`.

- [ ] **Step 1: Confirm Paperclip is running**

```bash
/usr/bin/curl -s http://127.0.0.1:3100/api/health
```

Expected: `{"status":"ok",...}`.

- [ ] **Step 2: Create Pushover secrets in Paperclip (instance-scoped or company-scoped — match what `company_secrets` requires)**

Use the Paperclip UI (Settings → Secrets) to create two entries and copy each secret UUID. If no UI exists yet, insert directly into the `company_secrets` table via psql on port 54329:

```sql
INSERT INTO company_secrets (id, company_id, name, encrypted_value)
VALUES (gen_random_uuid(), '9cebf3cf-efe8-4597-a400-f06488900a87', 'pushover-user-key', encrypt('YOUR-PUSHOVER-USER-KEY'));
```

(Use the actual encryption helper used by the server; consult `server/paperclip/server/src/services/secrets.ts` or similar before running the SQL.)

Record the two UUIDs: `PUSHOVER_USER_KEY_REF=...`, `PUSHOVER_APP_TOKEN_REF=...`.

- [ ] **Step 3: Install the plugin via local-path**

```bash
TOKEN="pcp_board_985880896179574eedaddb10a734d3a65f1306778501e4f1"
/usr/bin/curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"packageName\":\"/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip/packages/plugins/pushover-watch\",\"isLocalPath\":true}"
```

Expected: HTTP 200 with the new plugin record.

- [ ] **Step 4: Configure the plugin (dryRun mode)**

```bash
/usr/bin/curl -X PUT http://127.0.0.1:3100/api/plugins/whitestag.pushover-watch/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pushoverUserKeyRef": "PUSHOVER_USER_KEY_REF_UUID",
    "pushoverAppTokenRef": "PUSHOVER_APP_TOKEN_REF_UUID",
    "boardUserId": "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9",
    "clickbackBaseUrl": "https://company.whitestag.ai",
    "dryRun": true,
    "companies": [
      {"companyId":"9cebf3cf-efe8-4597-a400-f06488900a87","issuePrefix":"WHI","topAgentIds":["506c873e-3a40-4483-9a45-0eb0fa1554bb"],"enabled":true},
      {"companyId":"158c4959-4973-4cb0-8066-55ec0f35625e","issuePrefix":"HEA","topAgentIds":["6ddf2bfa-fe1c-4e26-a316-091b6ef3c182"],"enabled":true}
    ]
  }'
```

(Substitute the actual secret UUIDs from Step 2. If the config-update endpoint path differs, grep `server/paperclip/server/src/routes/plugins.ts` for the correct route.)

- [ ] **Step 5: Trigger T1 with a real Paperclip issue**

Create a test issue in WHITESTAG assigned to CEO and complete it:

```bash
# Create
/usr/bin/curl -X POST http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Pushover-Watch dry-run T1 test","status":"todo","assigneeAgentId":"506c873e-3a40-4483-9a45-0eb0fa1554bb"}'
# Capture returned issue id as ISSUE_ID

# Move it through statuses
/usr/bin/curl -X PATCH http://127.0.0.1:3100/api/issues/$ISSUE_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'

/usr/bin/curl -X PATCH http://127.0.0.1:3100/api/issues/$ISSUE_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

- [ ] **Step 6: Verify the dry-run log entry**

Tail the Paperclip plugin worker log (the path depends on the local server; check `~/.paperclip/instances/default/logs/` or `pnpm dev` stdout):

```bash
/usr/bin/tail -n 100 ~/.paperclip/instances/default/logs/launchd-paperclip.out.log | /usr/bin/grep pushover_watch
```

Expected: a `pushover_watch_dry_run` line with the constructed Pushover payload (title `[WHI] CEO erledigt: Pushover-Watch dry-run T1 test`, priority `0`).

- [ ] **Step 7: Flip dryRun off and re-trigger to verify a real notification arrives on the Watch**

Repeat Step 4 with `"dryRun": false`. Then repeat Step 5 (status `todo` → `in_progress` → `done`) on a fresh issue.

Expected: an Apple Watch notification labelled `[WHI] CEO erledigt: …` appears within ~5 seconds.

- [ ] **Step 8: Cleanup the test issues**

```bash
/usr/bin/curl -X PATCH http://127.0.0.1:3100/api/issues/$ISSUE_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"cancelled","comment":"Cleanup after pushover-watch smoke test."}'
```

- [ ] **Step 9: Commit any setup scripts/config snippets**

If you captured the install/config commands as a shell script under `packages/plugins/pushover-watch/scripts/`, add and commit it:

```bash
git add packages/plugins/pushover-watch/scripts/
git commit -m "chore(pushover-watch): record local install scripts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Otherwise skip this step.

---

## Self-Review Notes

**Spec coverage check (run mentally before handing off):**

- Trigger T1 (CEO/CHO done) → Task 5 predicate + Task 8 dispatch ✓
- Trigger T2 (in_review handover) → Task 5 predicate + Task 8 dispatch ✓
- Trigger T3 (blocked + mention) → Task 5 predicate + Task 8 (uses listComments + commentMentionsUser) ✓
- Trigger T4 (comment mention) → Task 9 ✓
- Trigger T5 (pending approval) → Task 9 ✓
- Bootstrap state seeding → Task 7 ✓
- Pushover client + dry-run mode → Task 6 + Task 8 (dispatch helper) ✓
- Instance config schema with `companies[]` + secret refs → Task 2 ✓
- Worker wiring → Task 10 ✓
- Local install + live smoke → Task 11 ✓

**Known runtime ambiguities to verify during Task 10/11:**

1. Exact `createTestHarness` signature — adjust Task 10 Step 3 wiring if the SDK signature differs.
2. Exact `event.payload` shape for `issue.updated` — the plan assumes `{id, identifier, title, status, assigneeAgentId, assigneeUserId}`. If the host sends a different shape (e.g. delta-only), adjust the `IssueUpdatedPayload` type and fetch the full issue via `ctx.issues.get`.
3. Exact `event.payload` shape for `issue.comment.created` — the plan assumes `body`, `authorUserId`, `authorAgentId`, plus issue context. If the host omits `issueTitle`/`issueIdentifier`, fetch the issue via `ctx.issues.get` before composing the notification.
4. Exact `event.payload` shape for `approval.created` — verify `type`, `status`, `title` are inline; if `title` lives in a nested `payload.payload`, adjust the type.
5. Config update endpoint path — Task 11 Step 4 assumes `PUT /api/plugins/:id/config`. Grep `server/paperclip/server/src/routes/plugins.ts` if it differs.
