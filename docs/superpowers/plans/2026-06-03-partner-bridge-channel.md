# Partner-Bridge Inter-Partnership Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Paperclip plugin `plugin-partner-bridge` that automates a board-gated communication channel between two isolated companies (Rossignol Voyage ↔ Product Compass Consulting), mirroring messages/tasks/documents and gating commitments, with Telegram/email transport behind a mocked Hermes contract.

**Architecture:** Hybrid split. The plugin (str-ops-style TS plugin) owns the in-Paperclip mirror, commitment classification, and native board-approval gate; it reaches Paperclip's own REST API and CouchDB via the worker's global `fetch` (Paperclip's egress gate blocks loopback, so `ctx.http` is unusable for `127.0.0.1` — same workaround proven in plugin-str-ops). Transport (Telegram/email) is a `HermesConnector` interface; v1 ships a `MockHermesConnector`. Hermes→plugin inbound rides the SDK action endpoint (`POST /api/plugins/:id/actions/inbound`).

**Tech Stack:** TypeScript, `@paperclipai/plugin-sdk` (`definePlugin`/`runWorker`), CouchDB (state, via global `fetch`), Vitest. Mirrors `packages/plugins/plugin-str-ops`.

---

## Reference: existing patterns to copy (read before starting)

- `packages/plugins/plugin-str-ops/src/manifest.ts` — manifest shape (`PaperclipPluginManifestV1`, `capabilities`, `entrypoints.worker`, `instanceConfigSchema`, `jobs`, `tools`).
- `packages/plugins/plugin-str-ops/src/store/couch-http.ts` — global-`fetch` HTTP adapter (copy verbatim; it is store-agnostic).
- `packages/plugins/plugin-str-ops/src/worker.ts` — `definePlugin({ setup })` + `runWorker(plugin, import.meta.url)`; config via `await ctx.config.get()` with env fallback.
- `packages/plugins/plugin-str-ops/src/register.ts` + `register.spec.ts` — `ctx.tools/jobs/data/actions/logger` registration + `fakeCtx()` + `MemoryStore` test style.
- `packages/plugins/plugin-str-ops/package.json`, `tsconfig.json`, `vitest.config.ts` — scaffolding to copy.

**Paperclip REST endpoints the bridge uses (verified this session except where noted):**
- Comments: `GET /api/issues/:id/comments`, `POST /api/issues/:id/comments` `{body}` (metadata supported via the comment payload).
- Documents: `GET /api/issues/:id/documents/:key`, `PUT /api/issues/:id/documents/:key` `{title,body,format:"markdown",baseRevisionId?,changeSummary?}`.
- Issues: `POST /api/companies/:companyId/issues` `{title,description,assigneeAgentId?,status?,priority?}`.
- Approvals: `GET /api/approvals/:id`. **Create + resolve endpoints are NOT yet verified — Task 6 Step 0 confirms them against the route source before implementing.**

**Local auth:** the local instance API is open (all session calls used no token). v1 calls it tokenless; `paperclipToken` config is accepted and sent as `Authorization: Bearer` when set (for hardened deployments).

**IDs (config defaults for the live link):** Rossignol Voyage company `99418004-eea1-4bbb-9be7-9811b16f2b3b` (prefix CON); Product Compass Consulting `e27fca3e-ecdd-4fb0-b563-d40b5381e4e4` (prefix PRO), CEO agent `cbe8d14d-f101-4925-b00e-2d953ac58543`.

---

## File structure

```
packages/plugins/plugin-partner-bridge/
  package.json            # name @paperclipai/plugin-partner-bridge (copy str-ops, rename)
  tsconfig.json           # copy str-ops verbatim
  vitest.config.ts        # copy str-ops verbatim
  src/
    manifest.ts           # PLUGIN_ID, capabilities, instanceConfigSchema, jobs, (no tools v1)
    types.ts              # ChannelItem, MessageEnvelope, Classification, ItemKind, LinkConfig, LinkSide, PendingApproval
    domain/
      classify.ts         # classifyItem(item) -> Classification  (explicit tag | heuristic | ambiguous->commitment)
      classify.spec.ts
      envelope.ts         # bridgeMsgId(), buildEnvelope(), isBridgeAuthored(), bridgeOriginMarker()
      envelope.spec.ts
      sync.ts             # syncLink(), resolveApprovalDecision(), handleInbound()  (the engine)
      sync.spec.ts
    store/
      couch-http.ts       # copy from str-ops verbatim
      types.ts            # BridgeStore, MirrorMapping
      memory-store.ts     # in-memory BridgeStore (tests)
      memory-store.spec.ts
      couch-store.ts      # CouchDB BridgeStore (global fetch via couch-http)
      couch-store.spec.ts # skipped unless COUCH_TEST_URL set (str-ops pattern)
    paperclip/
      types.ts            # PaperclipApi, ApiComment, ApiDocument, ApiIssue, ApiApproval
      api.ts              # HttpPaperclipApi (global fetch) + FakePaperclipApi (tests)
      api.spec.ts
    hermes/
      types.ts            # HermesConnector, SendMessage, InboundMessage
      mock.ts             # MockHermesConnector (records calls)
    register.ts           # registerPartnerBridge(ctx, deps): bridge-sync job + inbound action
    register.spec.ts
    worker.ts             # definePlugin setup: load config, build deps, register
  fixtures/
    link.json             # sample LinkConfig for the live Rossignol↔PCC link
```

---

## Task 0: Scaffold the plugin (S0)

**Files:**
- Create: `packages/plugins/plugin-partner-bridge/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/plugins/plugin-partner-bridge/src/manifest.ts`
- Test: `packages/plugins/plugin-partner-bridge/src/manifest.spec.ts`

- [ ] **Step 1: Copy scaffolding from str-ops**

```bash
cd /home/soloway/openclaw-runner/paperclip/packages/plugins
mkdir -p plugin-partner-bridge/src plugin-partner-bridge/fixtures
cp plugin-str-ops/tsconfig.json plugin-str-ops/vitest.config.ts plugin-partner-bridge/
cp plugin-str-ops/package.json plugin-partner-bridge/package.json
cp plugin-str-ops/src/store/couch-http.ts plugin-partner-bridge/src/   # temp location; moved in Task 1
```

Then edit `plugin-partner-bridge/package.json`: set `"name": "@paperclipai/plugin-partner-bridge"`, `"description": "Inter-partnership channel bridge between Paperclip companies."` Keep all scripts identical.

- [ ] **Step 2: Write the failing test**

`src/manifest.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import manifest, { PLUGIN_ID } from "./manifest.js";

describe("manifest", () => {
  it("declares id, worker entrypoint, and required capabilities", () => {
    expect(PLUGIN_ID).toBe("paperclipai.plugin-partner-bridge");
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["http.outbound", "companies.read", "plugin.state.read", "plugin.state.write", "jobs.schedule", "activity.log.write"]),
    );
  });
  it("exposes the bridge-sync job and an instanceConfigSchema with the link + transport fields", () => {
    expect(manifest.jobs?.some((j) => j.jobKey === "bridge-sync")).toBe(true);
    const props = (manifest.instanceConfigSchema as { properties: Record<string, unknown> }).properties;
    for (const k of ["paperclipBaseUrl", "couchUrl", "hermesBaseUrl", "inboundSecret", "links"]) {
      expect(props[k]).toBeDefined();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/plugins/plugin-partner-bridge && pnpm test src/manifest.spec.ts`
Expected: FAIL — `Cannot find module './manifest.js'`.

- [ ] **Step 4: Write `src/manifest.ts`**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-partner-bridge";
export const DEFAULT_COUCH_DB = "partner_bridge";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Partner Bridge",
  description: "Inter-partnership channel bridge between Paperclip companies.",
  author: "Oleg",
  categories: ["automation"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "companies.read",
    "jobs.schedule",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      paperclipBaseUrl: { type: "string", description: "Local Paperclip API base (e.g. http://127.0.0.1:3100)" },
      paperclipToken:   { type: "string", description: "Optional Bearer token for the Paperclip API" },
      couchUrl:         { type: "string", description: "CouchDB base URL (e.g. http://127.0.0.1:5984)" },
      couchDb:          { type: "string", description: "CouchDB database name (default: partner_bridge)" },
      couchUser:        { type: "string", description: "CouchDB username" },
      couchPassword:    { type: "string", description: "CouchDB password" },
      hermesBaseUrl:    { type: "string", description: "Hermes connector base URL (Telegram/email transport)" },
      hermesToken:      { type: "string", description: "Bearer token the plugin sends to Hermes" },
      inboundSecret:    { type: "string", description: "Shared secret Hermes echoes in inbound payloads (auth)" },
      links:            { type: "string", description: "JSON array of LinkConfig objects" },
    },
  },
  jobs: [
    { jobKey: "bridge-sync", displayName: "Bridge sync", description: "Detect + mirror new channel items across linked companies.", schedule: "*/15 * * * *" },
  ],
};

export default manifest;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/manifest.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/plugin-partner-bridge
git commit -m "feat(partner-bridge): scaffold plugin + manifest (S0)"
```

---

## Task 1: Types, envelope, and state store (S1)

**Files:**
- Create: `src/types.ts`, `src/domain/envelope.ts`, `src/domain/envelope.spec.ts`
- Create: `src/store/types.ts`, `src/store/memory-store.ts`, `src/store/memory-store.spec.ts`
- Move: `src/couch-http.ts` → `src/store/couch-http.ts`

- [ ] **Step 1: Create `src/types.ts` (shared types used by every later task)**

```ts
export type Classification = "routine" | "commitment";
export type ItemKind = "msg" | "task" | "doc";

/** A new item observed on a channel-issue (a comment, or a doc reference). */
export interface ChannelItem {
  id: string;            // source comment id (or synthetic doc id "<issueId>:doc:<key>")
  companyId: string;     // source company
  issueId: string;       // channel-issue it appeared on
  kind: ItemKind;
  body: string;
  ts: string;            // ISO timestamp
  metadata?: Record<string, unknown>; // may carry bridgeOrigin / class / docKey
  docKey?: string;       // present when kind === "doc"
}

/** Provenance stamped onto every mirrored item (loop prevention + dedup). */
export interface MessageEnvelope {
  bridgeMsgId: string;
  sourceCompanyId: string;
  sourceItemId: string;
  kind: ItemKind;
  classification: Classification;
  ts: string;
}

export interface LinkSide { companyId: string; channelIssueId: string; label: string; }
export interface LinkConfig {
  linkId: string;
  companyA: LinkSide;
  companyB: LinkSide;
  transport: { telegramChat: string; emailA: string; emailB: string };
}

export interface PendingApproval {
  approvalId: string;
  linkId: string;
  sourceCompanyId: string;
  sourceItemId: string;
  bridgeMsgId: string;
  body: string;
  state: "pending" | "approved" | "rejected";
  createdAt: string;
}
```

- [ ] **Step 2: Write the failing test for envelope**

`src/domain/envelope.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bridgeMsgId, buildEnvelope, bridgeOriginMarker, isBridgeAuthored } from "./envelope.js";
import type { ChannelItem } from "../types.js";

const item = (over: Partial<ChannelItem> = {}): ChannelItem => ({
  id: "c1", companyId: "A", issueId: "iss-A", kind: "msg", body: "hi", ts: "2026-06-03T10:00:00Z", ...over,
});

describe("envelope", () => {
  it("bridgeMsgId is unique-ish and stable string", () => {
    expect(bridgeMsgId()).not.toBe(bridgeMsgId());
    expect(typeof bridgeMsgId()).toBe("string");
  });
  it("buildEnvelope captures provenance", () => {
    const env = buildEnvelope(item(), "commitment", "BMID");
    expect(env).toMatchObject({ bridgeMsgId: "BMID", sourceCompanyId: "A", sourceItemId: "c1", kind: "msg", classification: "commitment" });
  });
  it("bridgeOriginMarker + isBridgeAuthored round-trip", () => {
    const meta = bridgeOriginMarker("peer-company-B");
    expect(isBridgeAuthored(item({ metadata: meta }))).toBe(true);
    expect(isBridgeAuthored(item({ metadata: {} }))).toBe(false);
    expect(isBridgeAuthored(item())).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test src/domain/envelope.spec.ts`
Expected: FAIL — `Cannot find module './envelope.js'`.

- [ ] **Step 4: Implement `src/domain/envelope.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { ChannelItem, Classification, MessageEnvelope } from "../types.js";

const BRIDGE_ORIGIN_KEY = "bridgeOrigin";

export function bridgeMsgId(): string {
  return randomUUID();
}

export function buildEnvelope(item: ChannelItem, classification: Classification, id: string): MessageEnvelope {
  return {
    bridgeMsgId: id,
    sourceCompanyId: item.companyId,
    sourceItemId: item.id,
    kind: item.kind,
    classification,
    ts: item.ts,
  };
}

/** Metadata stamped onto mirrored items so the bridge never re-processes its own writes. */
export function bridgeOriginMarker(peerCompanyId: string): Record<string, unknown> {
  return { [BRIDGE_ORIGIN_KEY]: peerCompanyId };
}

export function isBridgeAuthored(item: ChannelItem): boolean {
  return Boolean(item.metadata && BRIDGE_ORIGIN_KEY in item.metadata && item.metadata[BRIDGE_ORIGIN_KEY]);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test src/domain/envelope.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Move couch-http into store/ and define the store interface**

```bash
mv src/couch-http.ts src/store/couch-http.ts
```

Create `src/store/types.ts`:
```ts
import type { PendingApproval } from "../types.js";

export interface MirrorMapping {
  bridgeMsgId: string;
  sourceItemId: string;
  mirroredItemId: string;
  flags: { mirrored: boolean; notified: boolean; emailed: boolean };
}

export interface BridgeStore {
  ensure(): Promise<void>;
  getCursor(linkId: string, issueId: string): Promise<string | null>;
  setCursor(linkId: string, issueId: string, ts: string): Promise<void>;
  putMapping(m: MirrorMapping): Promise<void>;
  findMappingBySource(sourceItemId: string): Promise<MirrorMapping | null>;
  putPendingApproval(p: PendingApproval): Promise<void>;
  getPendingApproval(approvalId: string): Promise<PendingApproval | null>;
  setApprovalState(approvalId: string, state: "approved" | "rejected"): Promise<void>;
}
```

- [ ] **Step 7: Write the failing test for MemoryStore**

`src/store/memory-store.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";

describe("MemoryStore", () => {
  it("cursors round-trip per (link, issue)", async () => {
    const s = new MemoryStore(); await s.ensure();
    expect(await s.getCursor("L", "iss")).toBeNull();
    await s.setCursor("L", "iss", "2026-06-03T10:00:00Z");
    expect(await s.getCursor("L", "iss")).toBe("2026-06-03T10:00:00Z");
  });
  it("mapping is found by source id", async () => {
    const s = new MemoryStore(); await s.ensure();
    await s.putMapping({ bridgeMsgId: "B", sourceItemId: "src", mirroredItemId: "mir", flags: { mirrored: true, notified: false, emailed: false } });
    expect((await s.findMappingBySource("src"))?.mirroredItemId).toBe("mir");
    expect(await s.findMappingBySource("nope")).toBeNull();
  });
  it("pending approval state transitions", async () => {
    const s = new MemoryStore(); await s.ensure();
    await s.putPendingApproval({ approvalId: "ap", linkId: "L", sourceCompanyId: "A", sourceItemId: "src", bridgeMsgId: "B", body: "x", state: "pending", createdAt: "t" });
    await s.setApprovalState("ap", "approved");
    expect((await s.getPendingApproval("ap"))?.state).toBe("approved");
  });
});
```

- [ ] **Step 8: Run to verify it fails**

Run: `pnpm test src/store/memory-store.spec.ts`
Expected: FAIL — `Cannot find module './memory-store.js'`.

- [ ] **Step 9: Implement `src/store/memory-store.ts`**

```ts
import type { PendingApproval } from "../types.js";
import type { BridgeStore, MirrorMapping } from "./types.js";

export class MemoryStore implements BridgeStore {
  private cursors = new Map<string, string>();
  private mappings = new Map<string, MirrorMapping>();      // by sourceItemId
  private approvals = new Map<string, PendingApproval>();

  async ensure(): Promise<void> {}

  async getCursor(linkId: string, issueId: string): Promise<string | null> {
    return this.cursors.get(`${linkId}::${issueId}`) ?? null;
  }
  async setCursor(linkId: string, issueId: string, ts: string): Promise<void> {
    this.cursors.set(`${linkId}::${issueId}`, ts);
  }
  async putMapping(m: MirrorMapping): Promise<void> { this.mappings.set(m.sourceItemId, m); }
  async findMappingBySource(sourceItemId: string): Promise<MirrorMapping | null> {
    return this.mappings.get(sourceItemId) ?? null;
  }
  async putPendingApproval(p: PendingApproval): Promise<void> { this.approvals.set(p.approvalId, p); }
  async getPendingApproval(approvalId: string): Promise<PendingApproval | null> {
    return this.approvals.get(approvalId) ?? null;
  }
  async setApprovalState(approvalId: string, state: "approved" | "rejected"): Promise<void> {
    const a = this.approvals.get(approvalId);
    if (a) this.approvals.set(approvalId, { ...a, state });
  }
}
```

- [ ] **Step 10: Run to verify it passes**

Run: `pnpm test src/store`
Expected: PASS (3 tests).

- [ ] **Step 11: Commit**

```bash
git add packages/plugins/plugin-partner-bridge/src
git commit -m "feat(partner-bridge): types, envelope (loop marker), state store + memory impl (S1)"
```

---

## Task 2: Commitment classifier (S2)

**Files:**
- Create: `src/domain/classify.ts`, `src/domain/classify.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/domain/classify.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { classifyItem } from "./classify.js";
import type { ChannelItem } from "../types.js";

const item = (body: string, metadata?: Record<string, unknown>): ChannelItem => ({
  id: "c", companyId: "A", issueId: "i", kind: "msg", body, ts: "t", metadata,
});

describe("classifyItem", () => {
  it("explicit [COMMITMENT] prefix -> commitment", () => {
    expect(classifyItem(item("[COMMITMENT] kickoff signature"))).toBe("commitment");
  });
  it("explicit metadata class:commitment -> commitment", () => {
    expect(classifyItem(item("anything", { class: "commitment" }))).toBe("commitment");
  });
  it("explicit metadata class:routine -> routine (overrides heuristic)", () => {
    expect(classifyItem(item("budget 20k€ contrat", { class: "routine" }))).toBe("routine");
  });
  it("heuristic keyword (budget / signature / contrat / €) -> commitment", () => {
    expect(classifyItem(item("merci de valider le budget"))).toBe("commitment");
    expect(classifyItem(item("prêt pour signature du contrat"))).toBe("commitment");
    expect(classifyItem(item("devis à 18 000 €"))).toBe("commitment");
  });
  it("plain status message -> routine", () => {
    expect(classifyItem(item("brief transmis pour revue, merci"))).toBe("routine");
  });
  it("ambiguous (empty/whitespace) -> commitment (fail-safe)", () => {
    expect(classifyItem(item("   "))).toBe("commitment");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/domain/classify.spec.ts`
Expected: FAIL — `Cannot find module './classify.js'`.

- [ ] **Step 3: Implement `src/domain/classify.ts`**

```ts
import type { ChannelItem, Classification } from "../types.js";

const COMMITMENT_KEYWORDS = [
  "budget", "montant", "€", "eur", "contrat", "signature", "signer",
  "engagement", "devis", "avenant", "sow", "prix", "facture", "commande",
];

/**
 * Priority: explicit metadata.class -> explicit [COMMITMENT] prefix -> keyword
 * heuristic -> ambiguity fail-safe (commitment). Routine is only ever the
 * explicit "safe" path: a non-empty body with no commitment signal.
 */
export function classifyItem(item: ChannelItem): Classification {
  const explicit = item.metadata?.class;
  if (explicit === "commitment" || explicit === "routine") return explicit;

  const body = (item.body ?? "").trim();
  if (body === "") return "commitment"; // ambiguous -> over-gate

  if (/^\[COMMITMENT\]/i.test(body)) return "commitment";

  const lower = body.toLowerCase();
  if (COMMITMENT_KEYWORDS.some((k) => lower.includes(k))) return "commitment";

  return "routine";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/domain/classify.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/plugin-partner-bridge/src/domain/classify.ts packages/plugins/plugin-partner-bridge/src/domain/classify.spec.ts
git commit -m "feat(partner-bridge): commitment classifier with fail-safe ambiguity (S2)"
```

---

## Task 3: Paperclip API client + mirror engine (S3)

**Files:**
- Create: `src/paperclip/types.ts`, `src/paperclip/api.ts`, `src/paperclip/api.spec.ts`
- Create: `src/domain/sync.ts`, `src/domain/sync.spec.ts`

- [ ] **Step 1: Define `src/paperclip/types.ts`**

```ts
export interface ApiComment { id: string; body: string; createdAt: string; metadata?: Record<string, unknown>; }
export interface ApiDocument { key: string; title: string; body: string; format: string; latestRevisionId: string; }
export interface ApiIssue { id: string; identifier: string; }
export interface ApiApproval { id: string; status: string; }

export interface PaperclipApi {
  listComments(issueId: string, sinceTs?: string): Promise<ApiComment[]>;
  postComment(issueId: string, body: string, metadata?: Record<string, unknown>): Promise<ApiComment>;
  getDocument(issueId: string, key: string): Promise<ApiDocument | null>;
  putDocument(issueId: string, key: string, doc: { title: string; body: string; format: string; baseRevisionId?: string; changeSummary?: string }): Promise<ApiDocument>;
  createIssue(companyId: string, input: { title: string; description: string; assigneeAgentId?: string; status?: string; priority?: string }): Promise<ApiIssue>;
  createApproval(companyId: string, input: { kind: string; summary: string }): Promise<ApiApproval>;
  getApproval(approvalId: string): Promise<ApiApproval | null>;
  resolveApproval(approvalId: string, decision: "approve" | "reject"): Promise<ApiApproval>;
}
```

- [ ] **Step 2: Write the failing test for a FakePaperclipApi (tests use the fake; HttpPaperclipApi is exercised in Task 6 live E2E)**

`src/paperclip/api.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FakePaperclipApi } from "./api.js";

describe("FakePaperclipApi", () => {
  it("postComment then listComments returns it; sinceTs filters", async () => {
    const api = new FakePaperclipApi();
    await api.postComment("iss", "hello", { class: "routine" });
    const all = await api.listComments("iss");
    expect(all).toHaveLength(1);
    expect(all[0].body).toBe("hello");
    const future = await api.listComments("iss", "2999-01-01T00:00:00Z");
    expect(future).toHaveLength(0);
  });
  it("createIssue + putDocument/getDocument round-trip", async () => {
    const api = new FakePaperclipApi();
    const iss = await api.createIssue("co", { title: "T", description: "D" });
    expect(iss.identifier).toMatch(/-\d+$/);
    await api.putDocument(iss.id, "brief", { title: "B", body: "body", format: "markdown" });
    expect((await api.getDocument(iss.id, "brief"))?.body).toBe("body");
  });
  it("createApproval starts pending; resolveApproval flips status", async () => {
    const api = new FakePaperclipApi();
    const ap = await api.createApproval("co", { kind: "request_board_approval", summary: "s" });
    expect(ap.status).toBe("pending");
    const r = await api.resolveApproval(ap.id, "approve");
    expect(r.status).toBe("approved");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test src/paperclip/api.spec.ts`
Expected: FAIL — `Cannot find module './api.js'`.

- [ ] **Step 4: Implement `src/paperclip/api.ts` (FakePaperclipApi + HttpPaperclipApi)**

```ts
import { randomUUID } from "node:crypto";
import type { ApiApproval, ApiComment, ApiDocument, ApiIssue, PaperclipApi } from "./types.js";

/** In-memory fake for unit/integration tests. */
export class FakePaperclipApi implements PaperclipApi {
  comments = new Map<string, ApiComment[]>();
  docs = new Map<string, ApiDocument>();         // key: `${issueId}::${key}`
  approvals = new Map<string, ApiApproval>();
  issues: ApiIssue[] = [];
  private seq = 0;

  async listComments(issueId: string, sinceTs?: string): Promise<ApiComment[]> {
    const list = this.comments.get(issueId) ?? [];
    return sinceTs ? list.filter((c) => c.createdAt > sinceTs) : [...list];
  }
  async postComment(issueId: string, body: string, metadata?: Record<string, unknown>): Promise<ApiComment> {
    const c: ApiComment = { id: randomUUID(), body, createdAt: new Date(Date.now() + ++this.seq).toISOString(), metadata };
    const list = this.comments.get(issueId) ?? [];
    list.push(c); this.comments.set(issueId, list);
    return c;
  }
  async getDocument(issueId: string, key: string): Promise<ApiDocument | null> {
    return this.docs.get(`${issueId}::${key}`) ?? null;
  }
  async putDocument(issueId: string, key: string, doc: { title: string; body: string; format: string }): Promise<ApiDocument> {
    const d: ApiDocument = { key, title: doc.title, body: doc.body, format: doc.format, latestRevisionId: randomUUID() };
    this.docs.set(`${issueId}::${key}`, d);
    return d;
  }
  async createIssue(_companyId: string, input: { title: string; description: string }): Promise<ApiIssue> {
    const iss: ApiIssue = { id: randomUUID(), identifier: `PRO-${++this.seq}` };
    this.issues.push(iss);
    return iss;
  }
  async createApproval(_companyId: string, _input: { kind: string; summary: string }): Promise<ApiApproval> {
    const ap: ApiApproval = { id: randomUUID(), status: "pending" };
    this.approvals.set(ap.id, ap);
    return ap;
  }
  async getApproval(id: string): Promise<ApiApproval | null> { return this.approvals.get(id) ?? null; }
  async resolveApproval(id: string, decision: "approve" | "reject"): Promise<ApiApproval> {
    const ap = this.approvals.get(id) ?? { id, status: "pending" };
    const next = { ...ap, status: decision === "approve" ? "approved" : "rejected" };
    this.approvals.set(id, next);
    return next;
  }
}

/** Real client over global fetch to the local Paperclip API (loopback egress gate
 *  blocks ctx.http, so we use global fetch — same rationale as couch-http). */
export class HttpPaperclipApi implements PaperclipApi {
  private base: string;
  private headers: Record<string, string>;
  constructor(cfg: { baseUrl: string; token?: string }) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) };
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.base}${path}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: unknown = null; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data: data as T };
  }
  async listComments(issueId: string, sinceTs?: string) {
    const { data } = await this.req<unknown>("GET", `/api/issues/${issueId}/comments`);
    const arr = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const mapped = arr.map((c) => ({ id: String(c.id), body: String(c.body ?? ""), createdAt: String(c.createdAt ?? ""), metadata: (c.metadata as Record<string, unknown>) ?? undefined }));
    return sinceTs ? mapped.filter((c) => c.createdAt > sinceTs) : mapped;
  }
  async postComment(issueId: string, body: string, metadata?: Record<string, unknown>) {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/issues/${issueId}/comments`, { body, metadata });
    return { id: String(data.id), body: String(data.body ?? body), createdAt: String(data.createdAt ?? ""), metadata };
  }
  async getDocument(issueId: string, key: string) {
    const { status, data } = await this.req<Record<string, unknown>>("GET", `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`);
    if (status >= 400 || !data) return null;
    return { key: String(data.key), title: String(data.title ?? ""), body: String(data.body ?? ""), format: String(data.format ?? "markdown"), latestRevisionId: String(data.latestRevisionId ?? "") };
  }
  async putDocument(issueId: string, key: string, doc: { title: string; body: string; format: string; baseRevisionId?: string; changeSummary?: string }) {
    const { data } = await this.req<Record<string, unknown>>("PUT", `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`, doc);
    return { key, title: doc.title, body: doc.body, format: doc.format, latestRevisionId: String(data.latestRevisionId ?? "") };
  }
  async createIssue(companyId: string, input: { title: string; description: string; assigneeAgentId?: string; status?: string; priority?: string }) {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/companies/${companyId}/issues`, input);
    return { id: String(data.id), identifier: String(data.identifier ?? "") };
  }
  // NOTE: createApproval/resolveApproval endpoints confirmed in Task 6 Step 0.
  async createApproval(companyId: string, input: { kind: string; summary: string }) {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/companies/${companyId}/approvals`, input);
    return { id: String(data.id), status: String(data.status ?? "pending") };
  }
  async getApproval(approvalId: string) {
    const { status, data } = await this.req<Record<string, unknown>>("GET", `/api/approvals/${approvalId}`);
    if (status >= 400 || !data) return null;
    return { id: String(data.id), status: String(data.status ?? "") };
  }
  async resolveApproval(approvalId: string, decision: "approve" | "reject") {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/approvals/${approvalId}/${decision}`, {});
    return { id: approvalId, status: String(data.status ?? (decision === "approve" ? "approved" : "rejected")) };
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test src/paperclip/api.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing test for the mirror engine (routine path only)**

`src/domain/sync.spec.ts`:
```ts
import { describe, expect, it } from "vitest";
import { syncLink } from "./sync.js";
import { FakePaperclipApi } from "../paperclip/api.js";
import { MemoryStore } from "../store/memory-store.js";
import { MockHermesConnector } from "../hermes/mock.js";
import type { LinkConfig } from "../types.js";

const LINK: LinkConfig = {
  linkId: "L",
  companyA: { companyId: "A", channelIssueId: "iss-A", label: "Rossignol" },
  companyB: { companyId: "B", channelIssueId: "iss-B", label: "PCC" },
  transport: { telegramChat: "chat:1", emailA: "a@x.com", emailB: "b@x.com" },
};

function deps() { return { api: new FakePaperclipApi(), store: new MemoryStore(), hermes: new MockHermesConnector(), link: LINK }; }

describe("syncLink — routine mirror", () => {
  it("mirrors a new routine comment from A to B's channel-issue + Telegram notify", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "brief transmis pour revue");
    await syncLink(d);
    const mirrored = await d.api.listComments("iss-B");
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].metadata?.bridgeOrigin).toBe("A");      // loop marker stamped (origin = source company)
    expect(d.hermes.sent.filter((m) => m.channel === "telegram")).toHaveLength(1);
  });
  it("is idempotent: second run mirrors nothing new", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "hello");
    await syncLink(d); await syncLink(d);
    expect(await d.api.listComments("iss-B")).toHaveLength(1);
  });
  it("loop-safe: a bridge-authored comment is never mirrored back", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-B", "echo", { bridgeOrigin: "A" }); // came FROM the bridge
    await syncLink(d);
    expect(await d.api.listComments("iss-A")).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm test src/domain/sync.spec.ts`
Expected: FAIL — `Cannot find module './sync.js'` (and `../hermes/mock.js`).

- [ ] **Step 8: Create the Hermes contract + mock (needed by sync test)**

`src/hermes/types.ts`:
```ts
export interface SendMessage {
  bridgeMsgId: string;
  channel: "telegram" | "email";
  to: string;
  subject?: string;
  body: string;
  attachments?: Array<{ name: string; mime: string; url?: string; base64?: string }>;
  approvalId?: string;
  linkId: string;
}
export interface InboundMessage {
  channel: "telegram" | "email";
  from: string;
  body: string;
  inReplyTo?: string;
  approvalDecision?: { approvalId: string; decision: "approve" | "reject"; by: string };
  linkId: string;
  secret: string; // shared secret echoed by Hermes for auth
}
export interface HermesConnector {
  send(msg: SendMessage): Promise<void>;
}
```

`src/hermes/mock.ts`:
```ts
import type { HermesConnector, SendMessage } from "./types.js";

export class MockHermesConnector implements HermesConnector {
  sent: SendMessage[] = [];
  async send(msg: SendMessage): Promise<void> { this.sent.push(msg); }
}
```

- [ ] **Step 9: Implement `src/domain/sync.ts` (routine path; commitment branch added in Task 5)**

```ts
import type { LinkConfig, LinkSide } from "../types.js";
import type { BridgeStore } from "../store/types.js";
import type { PaperclipApi } from "../paperclip/types.js";
import type { HermesConnector } from "../hermes/types.js";
import { bridgeMsgId, bridgeOriginMarker } from "./envelope.js";
import { classifyItem } from "./classify.js";

export interface SyncDeps {
  api: PaperclipApi;
  store: BridgeStore;
  hermes: HermesConnector;
  link: LinkConfig;
}

function peerOf(link: LinkConfig, companyId: string): { self: LinkSide; peer: LinkSide } {
  return companyId === link.companyA.companyId
    ? { self: link.companyA, peer: link.companyB }
    : { self: link.companyB, peer: link.companyA };
}

/** One pass over both channel-issues: detect new outbound items, classify,
 *  mirror routine items to the peer + Telegram notify. Commitment items are
 *  routed to the gate in Task 5 (here they are skipped, not mirrored). */
export async function syncLink(deps: SyncDeps): Promise<void> {
  for (const side of [deps.link.companyA, deps.link.companyB]) {
    await syncSide(deps, side.companyId);
  }
}

async function syncSide(deps: SyncDeps, sourceCompanyId: string): Promise<void> {
  const { api, store, hermes, link } = deps;
  const { self, peer } = peerOf(link, sourceCompanyId);
  const since = await store.getCursor(link.linkId, self.channelIssueId);
  const comments = await api.listComments(self.channelIssueId, since ?? undefined);

  let maxTs = since;
  for (const c of comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    maxTs = !maxTs || c.createdAt > maxTs ? c.createdAt : maxTs;

    // loop prevention: skip bridge-authored items
    if (c.metadata && c.metadata.bridgeOrigin) continue;
    // idempotency: skip already-mirrored sources
    if (await store.findMappingBySource(c.id)) continue;

    const item = { id: c.id, companyId: sourceCompanyId, issueId: self.channelIssueId, kind: "msg" as const, body: c.body, ts: c.createdAt, metadata: c.metadata };
    const classification = classifyItem(item);
    if (classification === "commitment") continue; // handled by the gate (Task 5)

    const id = bridgeMsgId();
    const mirrored = await api.postComment(peer.channelIssueId, `**[${self.label}]** ${c.body}`, bridgeOriginMarker(sourceCompanyId));
    await store.putMapping({ bridgeMsgId: id, sourceItemId: c.id, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: false, emailed: false } });

    await hermes.send({ bridgeMsgId: id, channel: "telegram", to: link.transport.telegramChat, body: `📨 ${self.label} → ${peer.label}: ${c.body}`, linkId: link.linkId });
    await store.putMapping({ bridgeMsgId: id, sourceItemId: c.id, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: true, emailed: false } });
  }

  if (maxTs && maxTs !== since) await store.setCursor(link.linkId, self.channelIssueId, maxTs);
}
```

- [ ] **Step 10: Run to verify it passes**

Run: `pnpm test src/domain/sync.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 11: Run the whole suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 12: Commit**

```bash
git add packages/plugins/plugin-partner-bridge/src
git commit -m "feat(partner-bridge): Paperclip API client, Hermes contract+mock, routine mirror engine (S3/S4)"
```

---

## Task 4: Commitment gate (S5)

**Files:**
- Modify: `src/domain/sync.ts` (add commitment branch + `resolveApprovalDecision`)
- Modify: `src/domain/sync.spec.ts` (add gate tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/sync.spec.ts`:
```ts
import { resolveApprovalDecision } from "./sync.js";

describe("syncLink — commitment gate", () => {
  it("commitment item creates an approval, holds (no mirror), Telegram approve/reject", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] lancer kickoff budget 20k€");
    await syncLink(d);
    expect(await d.api.listComments("iss-B")).toHaveLength(0);                 // not mirrored
    expect(d.api.approvals.size).toBe(1);                                       // approval created
    const tg = d.hermes.sent.find((m) => m.channel === "telegram");
    expect(tg?.approvalId).toBeDefined();                                       // approve/reject surface
  });

  it("approve -> mirror + email formal record + confirmation", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] signature mission");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    await resolveApprovalDecision(d, approvalId, "approve");
    expect(await d.api.listComments("iss-B")).toHaveLength(1);                  // mirrored after approval
    expect(d.hermes.sent.some((m) => m.channel === "email")).toBe(true);        // formal record
    expect((await d.api.getApproval(approvalId))?.status).toBe("approved");
  });

  it("reject -> rejection comment on sender, no mirror", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] signature mission");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    await resolveApprovalDecision(d, approvalId, "reject");
    expect(await d.api.listComments("iss-B")).toHaveLength(0);
    const senderComments = await d.api.listComments("iss-A");
    expect(senderComments.some((c) => /rejet|refus/i.test(c.body))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/domain/sync.spec.ts`
Expected: FAIL — `resolveApprovalDecision` is not exported; commitment assertions fail.

- [ ] **Step 3: Update `src/domain/sync.ts` — commitment branch + resolver**

Replace the `if (classification === "commitment") continue;` line with:
```ts
    if (classification === "commitment") {
      const gateId = bridgeMsgId();
      const approval = await api.createApproval(sourceCompanyId, { kind: "request_board_approval", summary: `Commitment via partner channel: ${c.body.slice(0, 140)}` });
      await store.putPendingApproval({ approvalId: approval.id, linkId: link.linkId, sourceCompanyId, sourceItemId: c.id, bridgeMsgId: gateId, body: c.body, state: "pending", createdAt: c.createdAt });
      await store.putMapping({ bridgeMsgId: gateId, sourceItemId: c.id, mirroredItemId: "", flags: { mirrored: false, notified: true, emailed: false } });
      await hermes.send({ bridgeMsgId: gateId, channel: "telegram", to: link.transport.telegramChat, approvalId: approval.id, body: `⛔ ${self.label} → ${peer.label} COMMITMENT (approve/reject): ${c.body}`, linkId: link.linkId });
      continue; // held — no mirror until approval resolves
    }
```

Add at the end of the file:
```ts
/** Resolve a held commitment after a board/Telegram decision.
 *  approve -> mirror to peer + email formal record + confirmation on both sides.
 *  reject  -> rejection comment on the sender's channel-issue. */
export async function resolveApprovalDecision(deps: SyncDeps, approvalId: string, decision: "approve" | "reject"): Promise<void> {
  const { api, store, hermes, link } = deps;
  const pending = await store.getPendingApproval(approvalId);
  if (!pending || pending.state !== "pending") return; // idempotent / unknown
  const { self, peer } = peerOf(link, pending.sourceCompanyId);

  await api.resolveApproval(approvalId, decision);
  await store.setApprovalState(approvalId, decision === "approve" ? "approved" : "rejected");

  if (decision === "reject") {
    await api.postComment(self.channelIssueId, `❌ Commitment rejeté par le board (réf. ${approvalId}). Non transmis au partenaire.`, bridgeOriginMarker(peer.companyId));
    return;
  }

  // approved: mirror + email formal record + confirmations
  const mirrored = await api.postComment(peer.channelIssueId, `**[${self.label}]** ✅ ${pending.body}`, bridgeOriginMarker(pending.sourceCompanyId));
  await store.putMapping({ bridgeMsgId: pending.bridgeMsgId, sourceItemId: pending.sourceItemId, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: true, emailed: true } });
  await hermes.send({ bridgeMsgId: pending.bridgeMsgId, channel: "email", to: link.transport.emailB, subject: `Engagement confirmé — ${self.label}`, body: `${pending.body}\n\n(Approbation board réf. ${approvalId})`, approvalId, linkId: link.linkId });
  await api.postComment(self.channelIssueId, `✅ Commitment approuvé (réf. ${approvalId}) — transmis au partenaire par email.`, bridgeOriginMarker(peer.companyId));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/domain/sync.spec.ts`
Expected: PASS (routine 3 + gate 3 = 6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/plugin-partner-bridge/src/domain/sync.ts packages/plugins/plugin-partner-bridge/src/domain/sync.spec.ts
git commit -m "feat(partner-bridge): native board-approval gate for commitments + resolver (S5)"
```

---

## Task 5: Inbound handler + register (job + action)

**Files:**
- Modify: `src/domain/sync.ts` (add `handleInbound`)
- Create: `src/register.ts`, `src/register.spec.ts`

- [ ] **Step 1: Write the failing test for handleInbound**

Append to `src/domain/sync.spec.ts`:
```ts
import { handleInbound } from "./sync.js";

describe("handleInbound", () => {
  it("approval decision routes to resolveApprovalDecision", async () => {
    const d = deps(); await d.store.ensure();
    await d.api.postComment("iss-A", "[COMMITMENT] signature");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    await handleInbound(d, { channel: "telegram", from: "you", body: "", approvalDecision: { approvalId, decision: "approve", by: "you" }, linkId: "L", secret: "x" });
    expect((await d.api.getApproval(approvalId))?.status).toBe("approved");
  });
  it("plain inbound message posts onto the peer's channel-issue (mapped via inReplyTo side)", async () => {
    const d = deps(); await d.store.ensure();
    await handleInbound(d, { channel: "email", from: "pcc@x.com", body: "réponse PCC", linkId: "L", secret: "x" });
    // default: inbound from the partner lands on company B's channel (configurable); assert it was posted somewhere
    const total = (await d.api.listComments("iss-A")).length + (await d.api.listComments("iss-B")).length;
    expect(total).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/domain/sync.spec.ts`
Expected: FAIL — `handleInbound` not exported.

- [ ] **Step 3: Implement `handleInbound` in `src/domain/sync.ts`**

```ts
import type { InboundMessage } from "../hermes/types.js";

/** Inbound from Hermes (Telegram reply / inbound email / approve-button).
 *  Approval decisions resolve the gate; plain messages post onto a channel-issue. */
export async function handleInbound(deps: SyncDeps, msg: InboundMessage): Promise<void> {
  if (msg.approvalDecision) {
    await resolveApprovalDecision(deps, msg.approvalDecision.approvalId, msg.approvalDecision.decision);
    return;
  }
  // Plain inbound from the external partner -> post on company B's channel-issue
  // (company B is the externally-reachable partner side by convention).
  await deps.api.postComment(
    deps.link.companyB.channelIssueId,
    `**[inbound:${msg.channel}]** ${msg.body}`,
    bridgeOriginMarker(deps.link.companyA.companyId),
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/domain/sync.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing test for register**

`src/register.spec.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { registerPartnerBridge, type RegisterDeps } from "./register.js";
import { FakePaperclipApi } from "./paperclip/api.js";
import { MemoryStore } from "./store/memory-store.js";
import { MockHermesConnector } from "./hermes/mock.js";
import type { LinkConfig } from "./types.js";

const LINK: LinkConfig = {
  linkId: "L",
  companyA: { companyId: "A", channelIssueId: "iss-A", label: "Rossignol" },
  companyB: { companyId: "B", channelIssueId: "iss-B", label: "PCC" },
  transport: { telegramChat: "chat:1", emailA: "a@x.com", emailB: "b@x.com" },
};

function fakeCtx() {
  const jobs = new Map<string, Function>(); const data = new Map<string, Function>(); const actions = new Map<string, Function>();
  return {
    jobs: { register: (k: string, fn: Function) => jobs.set(k, fn) },
    data: { register: (k: string, fn: Function) => data.set(k, fn) },
    actions: { register: (k: string, fn: Function) => actions.set(k, fn) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    _maps: { jobs, data, actions },
  };
}

function deps(): RegisterDeps {
  return { api: new FakePaperclipApi(), store: new MemoryStore(), hermes: new MockHermesConnector(), links: [LINK], inboundSecret: "s3cret" };
}

describe("registerPartnerBridge", () => {
  it("registers bridge-sync job, inbound action, health data", () => {
    const ctx = fakeCtx();
    registerPartnerBridge(ctx as never, deps());
    expect([...ctx._maps.jobs.keys()]).toContain("bridge-sync");
    expect([...ctx._maps.actions.keys()]).toContain("inbound");
    expect([...ctx._maps.data.keys()]).toContain("health");
  });
  it("inbound action rejects a wrong secret", async () => {
    const ctx = fakeCtx(); const d = deps();
    registerPartnerBridge(ctx as never, d);
    const res = await ctx._maps.actions.get("inbound")!({ linkId: "L", channel: "telegram", from: "x", body: "hi", secret: "WRONG" });
    expect(res).toMatchObject({ ok: false, error: "unauthorized" });
  });
  it("inbound action with correct secret routes a message", async () => {
    const ctx = fakeCtx(); const d = deps();
    registerPartnerBridge(ctx as never, d);
    const res = await ctx._maps.actions.get("inbound")!({ linkId: "L", channel: "email", from: "pcc", body: "réponse", secret: "s3cret" });
    expect(res).toMatchObject({ ok: true });
    expect((await (d.api as FakePaperclipApi).listComments("iss-B")).length).toBe(1);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm test src/register.spec.ts`
Expected: FAIL — `Cannot find module './register.js'`.

- [ ] **Step 7: Implement `src/register.ts`**

```ts
import { timingSafeEqual } from "node:crypto";
import type { LinkConfig } from "./types.js";
import type { BridgeStore } from "./store/types.js";
import type { PaperclipApi } from "./paperclip/types.js";
import type { HermesConnector } from "./hermes/types.js";
import type { InboundMessage } from "./hermes/types.js";
import { syncLink, handleInbound, type SyncDeps } from "./domain/sync.js";

export interface RegisterDeps {
  api: PaperclipApi;
  store: BridgeStore;
  hermes: HermesConnector;
  links: LinkConfig[];
  inboundSecret: string;
}

interface RegisterCtx {
  jobs: { register(jobKey: string, handler: (job: { jobKey: string; runId: string; trigger: string; scheduledAt: string }) => Promise<unknown>): void };
  data: { register(key: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void };
  actions: { register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void };
  logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void; error: (m: string, meta?: Record<string, unknown>) => void };
}

function secretOk(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(provided), Buffer.from(expected)); } catch { return false; }
}

export function registerPartnerBridge(ctx: RegisterCtx, deps: RegisterDeps): void {
  const linkById = new Map(deps.links.map((l) => [l.linkId, l]));
  const syncDeps = (link: LinkConfig): SyncDeps => ({ api: deps.api, store: deps.store, hermes: deps.hermes, link });

  ctx.data.register("health", async () => ({ status: "ok", plugin: "partner-bridge", links: deps.links.map((l) => l.linkId) }));

  ctx.jobs.register("bridge-sync", async (job) => {
    let processed = 0;
    for (const link of deps.links) { await syncLink(syncDeps(link)); processed++; }
    ctx.logger.info("bridge-sync pass complete", { runId: job.runId, links: processed });
    return { links: processed };
  });

  // Hermes -> plugin inbound (POST /api/plugins/:id/actions/inbound). Auth via shared secret in the payload.
  ctx.actions.register("inbound", async (params) => {
    const msg = params as unknown as InboundMessage;
    if (!secretOk(msg.secret, deps.inboundSecret)) return { ok: false, error: "unauthorized" };
    const link = linkById.get(msg.linkId);
    if (!link) return { ok: false, error: "unknown_link" };
    await handleInbound(syncDeps(link), msg);
    return { ok: true };
  });
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm test src/register.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/plugin-partner-bridge/src
git commit -m "feat(partner-bridge): inbound handler + register (bridge-sync job, secret-auth inbound action) (S5)"
```

---

## Task 6: CouchStore, worker wiring, live E2E vertical slice (S6)

**Files:**
- Create: `src/store/couch-store.ts`, `src/store/couch-store.spec.ts`
- Create: `src/worker.ts`, `fixtures/link.json`
- Create: `src/e2e.live.spec.ts`

- [ ] **Step 0: Confirm the approval create/resolve REST shape (do this first)**

Read the approvals router to confirm endpoints before trusting `HttpPaperclipApi.createApproval/resolveApproval`:
```bash
cd /home/soloway/openclaw-runner/paperclip
rg -n "approvals" packages/*/src --glob '*.ts' | rg -i "post|put|router|\.route|approve|decision|resolve" | head -30
```
If the real paths differ from `POST /api/companies/:id/approvals` and `POST /api/approvals/:id/{approve|reject}`, update those two methods in `src/paperclip/api.ts` to match. (The Fake — used by all non-live tests — is unaffected.)

- [ ] **Step 1: Write the CouchStore (mirror str-ops couch-store doc-id discipline)**

Implement `src/store/couch-store.ts` with deterministic `_id`s and Mango-free `GET`/`PUT` by id (CouchDB), backed by the copied `couch-http.ts`. Doc ids: cursor `cursor:<linkId>:<issueId>`, mapping `map:<sourceItemId>`, approval `appr:<approvalId>`. Each method does `GET` (capture `_rev`) then `PUT`. Reuse the exact `CouchHttp`/`CouchResponse` types from `couch-http.ts` (str-ops style).

```ts
import type { PendingApproval } from "../types.js";
import type { BridgeStore, MirrorMapping } from "./types.js";

export interface CouchResponse { status: number; body: unknown; }
export interface CouchHttp { request(method: string, path: string, body?: unknown): Promise<CouchResponse>; }

export class CouchStore implements BridgeStore {
  constructor(private http: CouchHttp, private db: string) {}
  private p(id: string) { return `/${this.db}/${encodeURIComponent(id)}`; }

  async ensure(): Promise<void> {
    const res = await this.http.request("PUT", `/${this.db}`);
    if (res.status !== 201 && res.status !== 412) {
      if (res.status >= 400 && res.status !== 412) throw new Error(`couch ensure failed: ${res.status}`);
    }
  }
  private async get<T>(id: string): Promise<(T & { _rev?: string }) | null> {
    const res = await this.http.request("GET", this.p(id));
    if (res.status === 404) return null;
    if (res.status >= 400) throw new Error(`couch get ${id}: ${res.status}`);
    return res.body as T & { _rev?: string };
  }
  private async put(id: string, doc: Record<string, unknown>): Promise<void> {
    const existing = await this.get<Record<string, unknown>>(id);
    const body = existing?._rev ? { ...doc, _id: id, _rev: existing._rev } : { ...doc, _id: id };
    const res = await this.http.request("PUT", this.p(id), body);
    if (res.status >= 400) throw new Error(`couch put ${id}: ${res.status}`);
  }

  async getCursor(linkId: string, issueId: string) {
    const d = await this.get<{ ts: string }>(`cursor:${linkId}:${issueId}`);
    return d?.ts ?? null;
  }
  async setCursor(linkId: string, issueId: string, ts: string) { await this.put(`cursor:${linkId}:${issueId}`, { ts }); }
  async putMapping(m: MirrorMapping) { await this.put(`map:${m.sourceItemId}`, { ...m }); }
  async findMappingBySource(sourceItemId: string) { return await this.get<MirrorMapping>(`map:${sourceItemId}`); }
  async putPendingApproval(p: PendingApproval) { await this.put(`appr:${p.approvalId}`, { ...p }); }
  async getPendingApproval(approvalId: string) { return await this.get<PendingApproval>(`appr:${approvalId}`); }
  async setApprovalState(approvalId: string, state: "approved" | "rejected") {
    const a = await this.get<PendingApproval>(`appr:${approvalId}`);
    if (a) await this.put(`appr:${approvalId}`, { ...a, state });
  }
}
```

- [ ] **Step 2: Write `src/store/couch-store.spec.ts` (skipped unless `COUCH_TEST_URL` set — str-ops pattern)**

```ts
import { describe, expect, it } from "vitest";
import { CouchStore } from "./couch-store.js";
import { createCouchHttp } from "./couch-http.js";

const URL = process.env.COUCH_TEST_URL;
const d = URL ? describe : describe.skip;

d("CouchStore (live)", () => {
  it("cursor + mapping + approval round-trip", async () => {
    const http = createCouchHttp({ baseUrl: URL!, user: process.env.COUCH_TEST_USER, password: process.env.COUCH_TEST_PASSWORD });
    const store = new CouchStore(http, `pb_test_${Date.now()}`);
    await store.ensure();
    await store.setCursor("L", "iss", "2026-06-03T10:00:00Z");
    expect(await store.getCursor("L", "iss")).toBe("2026-06-03T10:00:00Z");
    await store.putMapping({ bridgeMsgId: "B", sourceItemId: "s", mirroredItemId: "m", flags: { mirrored: true, notified: true, emailed: false } });
    expect((await store.findMappingBySource("s"))?.mirroredItemId).toBe("m");
  });
});
```

Run: `pnpm test src/store/couch-store.spec.ts` → Expected: SKIPPED (no `COUCH_TEST_URL`). With CouchDB up: `COUCH_TEST_URL=http://127.0.0.1:5984 COUCH_TEST_USER=admin COUCH_TEST_PASSWORD=<pw> pnpm test src/store/couch-store.spec.ts` → PASS.

- [ ] **Step 3: Write `fixtures/link.json` (the live Rossignol↔PCC link; channel-issue ids filled at bootstrap)**

```json
[
  {
    "linkId": "rossignol-pcc",
    "companyA": { "companyId": "99418004-eea1-4bbb-9be7-9811b16f2b3b", "channelIssueId": "REPLACE_CON_CHANNEL_ISSUE", "label": "Rossignol Voyage" },
    "companyB": { "companyId": "e27fca3e-ecdd-4fb0-b563-d40b5381e4e4", "channelIssueId": "REPLACE_PRO_CHANNEL_ISSUE", "label": "Product Compass Consulting" },
    "transport": { "telegramChat": "REPLACE_TELEGRAM_CHAT", "emailA": "ops@rossignol-voyage.example", "emailB": "contact@productcompass.example" }
  }
]
```
(The two `channelIssueId`s are created + patched in by the bootstrap step in §"Post-plan bootstrap" below. The fixture is the dev default; production passes `links` via plugin config.)

- [ ] **Step 4: Implement `src/worker.ts` (config load + dependency wiring; mirrors str-ops worker)**

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { readFileSync } from "node:fs";
import { CouchStore } from "./store/couch-store.js";
import { createCouchHttp } from "./store/couch-http.js";
import { HttpPaperclipApi } from "./paperclip/api.js";
import { HttpHermesConnector } from "./hermes/http.js";
import { registerPartnerBridge } from "./register.js";
import type { LinkConfig } from "./types.js";

function loadLinks(raw: string | undefined): LinkConfig[] {
  if (raw && raw.trim()) { try { return JSON.parse(raw) as LinkConfig[]; } catch { /* fall through */ } }
  try { return JSON.parse(readFileSync(new URL("../fixtures/link.json", import.meta.url), "utf8")) as LinkConfig[]; } catch { return []; }
}

const plugin = definePlugin({
  async setup(ctx) {
    const cfg = (await ctx.config.get()) as Record<string, unknown>;
    const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

    const couchUrl = s(cfg.couchUrl) ?? process.env.PB_COUCHDB_URL ?? "http://127.0.0.1:5984";
    const couchDb = s(cfg.couchDb) ?? process.env.PB_COUCHDB_DB ?? "partner_bridge";
    const http = createCouchHttp({ baseUrl: couchUrl, user: s(cfg.couchUser) ?? process.env.PB_COUCHDB_USER, password: s(cfg.couchPassword) ?? process.env.PB_COUCHDB_PASSWORD });
    const store = new CouchStore(http, couchDb);
    await store.ensure();

    const api = new HttpPaperclipApi({ baseUrl: s(cfg.paperclipBaseUrl) ?? process.env.PB_PAPERCLIP_URL ?? "http://127.0.0.1:3100", token: s(cfg.paperclipToken) });
    const hermes = new HttpHermesConnector({ baseUrl: s(cfg.hermesBaseUrl) ?? "http://127.0.0.1:7400", token: s(cfg.hermesToken) });
    const links = loadLinks(s(cfg.links));
    const inboundSecret = s(cfg.inboundSecret) ?? process.env.PB_INBOUND_SECRET ?? "";

    registerPartnerBridge(ctx, { api, store, hermes, links, inboundSecret });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

- [ ] **Step 5: Implement `src/hermes/http.ts` (real connector over global fetch; v1 may point at a stub)**

```ts
import type { HermesConnector, SendMessage } from "./types.js";

export class HttpHermesConnector implements HermesConnector {
  private base: string; private headers: Record<string, string>;
  constructor(cfg: { baseUrl: string; token?: string }) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) };
  }
  async send(msg: SendMessage): Promise<void> {
    const res = await fetch(`${this.base}/partner-bridge/send`, { method: "POST", headers: this.headers, body: JSON.stringify(msg) });
    if (res.status >= 400) throw new Error(`hermes send failed: ${res.status}`);
  }
}
```

- [ ] **Step 6: Build + typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: clean build (`dist/worker.js` exists), no type errors.

- [ ] **Step 7: Write the live E2E vertical slice (`src/e2e.live.spec.ts`, gated on `E2E=1`)**

Uses `FakePaperclipApi` + `MockHermesConnector` + `MemoryStore` to drive the §4.3 slice in-process (deterministic; the "live" gate is for future real-API wiring). Asserts the full pipe.
```ts
import { describe, expect, it } from "vitest";
import { syncLink, resolveApprovalDecision } from "./domain/sync.js";
import { FakePaperclipApi } from "./paperclip/api.js";
import { MemoryStore } from "./store/memory-store.js";
import { MockHermesConnector } from "./hermes/mock.js";
import type { LinkConfig } from "./types.js";

const LINK: LinkConfig = {
  linkId: "rossignol-pcc",
  companyA: { companyId: "CON", channelIssueId: "con-ch", label: "Rossignol Voyage" },
  companyB: { companyId: "PRO", channelIssueId: "pro-ch", label: "Product Compass Consulting" },
  transport: { telegramChat: "chat:you", emailA: "ops@ross", emailB: "pcc@x" },
};

describe("E2E vertical slice (§4.3)", () => {
  it("routine out -> reply in -> gated commitment -> approve -> email", async () => {
    const d = { api: new FakePaperclipApi(), store: new MemoryStore(), hermes: new MockHermesConnector(), link: LINK };
    await d.store.ensure();

    // 1. routine out (Rossignol -> PCC)
    await d.api.postComment("con-ch", "Brief de mission transmis pour revue.");
    await syncLink(d);
    expect(await d.api.listComments("pro-ch")).toHaveLength(1);
    expect(d.hermes.sent.some((m) => m.channel === "telegram")).toBe(true);

    // 2. routine in (PCC -> Rossignol)
    await d.api.postComment("pro-ch", "Revue & cadrage livrés — réponse prête.");
    await syncLink(d);
    expect((await d.api.listComments("con-ch")).some((c) => /cadrage/i.test(c.body))).toBe(true);

    // 3. commitment (Rossignol -> PCC) held, then approved -> email
    await d.api.postComment("con-ch", "[COMMITMENT] Lancer kickoff — budget 18–30 k€, signature.");
    await syncLink(d);
    const approvalId = [...d.api.approvals.keys()][0];
    expect((await d.api.listComments("pro-ch")).length).toBe(1); // still only the routine mirror
    await resolveApprovalDecision(d, approvalId, "approve");
    expect((await d.api.listComments("pro-ch")).length).toBe(2); // commitment mirrored after approval
    expect(d.hermes.sent.some((m) => m.channel === "email")).toBe(true);
  });
});
```

- [ ] **Step 8: Run full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS (manifest 2, envelope 3, memory-store 3, classify 6, api 3, sync 8, register 3, e2e 1; couch-store skipped).

- [ ] **Step 9: Commit**

```bash
git add packages/plugins/plugin-partner-bridge
git commit -m "feat(partner-bridge): CouchStore, worker wiring, Hermes http connector, E2E vertical slice (S6)"
```

---

## Post-plan bootstrap (operator steps, run once after build — not a code task)

These create the live channel and turn the plugin on. They are runbook steps, not TDD tasks:
1. Create the two channel-issues (one per company) via `POST /api/companies/:id/issues` (titles `CON: ⇄ PCC partnership channel`, `PRO: ⇄ Rossignol partnership channel`); copy their ids into `fixtures/link.json` (or the plugin `links` config).
2. Ensure CouchDB is up (Docker `:5984`).
3. `POST /api/plugins/paperclipai.plugin-partner-bridge/config` with `{ paperclipBaseUrl, couchUrl, couchUser, couchPassword, hermesBaseUrl, inboundSecret, links }`.
4. `plugin enable`. Verify `GET /api/plugins/:id/data/health` → `{status:"ok"}`.
5. (Hermes side, separate sub-spec) point Hermes inbound at `POST /api/plugins/:id/actions/inbound` with the shared `secret`.

---

## Self-review

**Spec coverage:**
- §3.1 plugin (mirror/classify/gate) → Tasks 2–5. ✓
- §3.2 Hermes contract (`send`/`inbound`) → `hermes/types.ts` (Task 3 Step 8) + inbound action (Task 5). ✓
- §3.3 channel-issue convention + link config → `types.ts` `LinkConfig` (Task 1) + `fixtures/link.json` + bootstrap. ✓
- §4.1 classification (explicit/heuristic/ambiguous→commitment) → Task 2. ✓
- §4.2 native gate + Telegram surface + state machine → Task 4 (`createApproval`/hold/`resolveApprovalDecision`). ✓
- §4.3 vertical slice → Task 6 Step 7 E2E. ✓
- §5.1 idempotency (cursor + dedup map + flags) → Tasks 1, 3. ✓
- §5.2 loop prevention (`bridgeOrigin`) → Task 1 envelope + Task 3 skip. ✓
- §5.3 approval lifecycle → state stored; **reminder-after-N-days is deferred** (noted below). 
- §5.4 secrets in Hermes / inbound auth / cross-company global fetch → worker config + `secretOk` + `HttpPaperclipApi`. ✓ (HMAC-over-transport softened to shared-secret-in-payload — see deviation.)
- §6 testing layers (unit/contract/integration/E2E + skipped live Couch) → all tasks. ✓

**Deviations from spec (intentional, minor):**
- **Inbound auth** uses a shared secret echoed in the payload + `timingSafeEqual`, not HTTP HMAC — because Hermes→plugin rides the SDK `actions` endpoint (params, not raw headers). HMAC-over-transport is a hardening follow-up.
- **Approval reminder-after-N-days (§5.3)** is not built in v1 (no scheduler step in the slice). Tracked as a follow-up; the `bridge-sync` job is the natural place to add it.
- **Approval create/resolve endpoints** are verified in Task 6 Step 0 before the live client is trusted (Fake covers all offline tests).

**Type consistency:** `ChannelItem`, `MessageEnvelope`, `LinkConfig`, `LinkSide`, `PendingApproval`, `MirrorMapping`, `SyncDeps`, `PaperclipApi`, `HermesConnector`, `SendMessage`, `InboundMessage` defined once and reused verbatim across tasks. `bridgeOrigin` marker key is consistent (envelope writes it, sync reads it, mirror stamps it). Job key `bridge-sync` and action key `inbound` consistent (manifest ↔ register ↔ tests ↔ bootstrap).

**Placeholder scan:** the only `REPLACE_*` tokens are in `fixtures/link.json`, intentionally filled by the bootstrap runbook (not code); every code step ships complete code.
