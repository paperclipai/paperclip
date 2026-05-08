import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, PluginCapability } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import {
  sanitiseBody,
  buildTitle,
  mapIssueStatus,
  createSyncEngine,
  SYNC_FOOTER,
} from "../src/sync-engine.js";

// ---------------------------------------------------------------------------
// Minimal valid Issue factory
// ---------------------------------------------------------------------------
function makeIssue(overrides: Partial<Issue> & { id: string; title: string }): Issue {
  return {
    companyId: "co-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    ...overrides,
  } as Issue;
}

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------
interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function makeMockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIdx = 0;
  const calls: FetchCall[] = [];

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const bodyParsed = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: urlStr, method: init?.method ?? "GET", body: bodyParsed });

    const resp = responses[callIdx] ?? { status: 200, body: {} };
    callIdx++;

    const headers = new Headers({
      "content-type": "application/json",
      "x-ratelimit-remaining": "999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    });

    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers,
    });
  });

  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Sanitiser unit tests
// ---------------------------------------------------------------------------
describe("sanitiseBody", () => {
  it("appends sync footer", () => {
    const out = sanitiseBody("Hello world");
    expect(out).toContain(SYNC_FOOTER);
    expect(out.endsWith(SYNC_FOOTER)).toBe(true);
  });

  it("handles null description", () => {
    const out = sanitiseBody(null);
    expect(out).toBe(SYNC_FOOTER);
  });

  it("rewrites internal Paperclip links", () => {
    const body = "See [GLA-42](/GLA/issues/GLA-42) and [GLA-7](/GLA/issues/GLA-7).";
    const out = sanitiseBody(body);
    expect(out).not.toContain("(/GLA/");
    expect(out).toContain("GLA-42");
    expect(out).toContain("GLA-7");
    // Labels preserved, link markup removed
    expect(out).not.toMatch(/\[GLA-42\]\(/);
  });

  it("strips bare UUID v4 patterns", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const out = sanitiseBody(`Issue id: ${uuid}`);
    expect(out).not.toContain(uuid);
    expect(out).toContain("[id-redacted]");
  });

  it("strips multiple UUIDs", () => {
    const a = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
    const b = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
    const out = sanitiseBody(`${a} and ${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out.match(/\[id-redacted\]/g)?.length).toBe(2);
  });

  it("preserves non-internal URLs", () => {
    const body = "Check [GitHub](https://github.com/acme/repo).";
    const out = sanitiseBody(body);
    expect(out).toContain("[GitHub](https://github.com/acme/repo)");
  });
});

// ---------------------------------------------------------------------------
// buildTitle
// ---------------------------------------------------------------------------
describe("buildTitle", () => {
  it("prefixes with identifier when present", () => {
    expect(buildTitle("GLA-42", "Fix the bug")).toBe("[GLA-42] Fix the bug");
  });

  it("returns bare title when identifier is null", () => {
    expect(buildTitle(null, "Fix the bug")).toBe("Fix the bug");
  });
});

// ---------------------------------------------------------------------------
// mapIssueStatus
// ---------------------------------------------------------------------------
describe("mapIssueStatus", () => {
  it.each([["todo"], ["in_progress"], ["in_review"], ["blocked"], ["backlog"]] as const)(
    "%s → open",
    (status) => {
      expect(mapIssueStatus(status).state).toBe("open");
    },
  );

  it("done → closed/completed", () => {
    expect(mapIssueStatus("done")).toMatchObject({ state: "closed", state_reason: "completed" });
  });

  it("cancelled → closed/not_planned", () => {
    expect(mapIssueStatus("cancelled")).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });
});

// ---------------------------------------------------------------------------
// Sync engine — idempotency
// ---------------------------------------------------------------------------
describe("createSyncEngine — idempotency", () => {
  const CAPS = [...manifest.capabilities, "events.emit"] as const;
  const BASE_CONFIG = {
    repo: "acme/test-repo",
    host: "github.com",
    secretRef: "github-token",
    syncedGoalIds: [],
    dryRun: false,
  };

  it("creates one GH issue and stores mapping; replays are no-ops", async () => {
    const { fetchFn, calls } = makeMockFetch([
      // POST /issues → create
      { status: 201, body: { number: 42, html_url: "https://github.com/acme/test-repo/issues/42", state: "open", title: "[GLA-5] My issue", body: "" } },
      // PATCH /issues/42 → first replay (already mapped)
      { status: 200, body: { number: 42, html_url: "https://github.com/acme/test-repo/issues/42", state: "open", title: "[GLA-5] My issue", body: "" } },
      // PATCH /issues/42 → second replay
      { status: 200, body: { number: 42, html_url: "https://github.com/acme/test-repo/issues/42", state: "open", title: "[GLA-5] My issue", body: "" } },
    ]);

    const harness = createTestHarness({ manifest, capabilities: CAPS as unknown as PluginCapability[] });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-1", title: "My issue", identifier: "GLA-5", companyId: "co-1" })],
    });

    const engine = createSyncEngine({ fetchFn, debounceMs: 0 });

    // First sync — should create
    await engine.doSync("iss-1", "co-1", harness.ctx, BASE_CONFIG);

    expect(harness.getState({ scopeKind: "issue", scopeId: "iss-1", namespace: "github-sync", stateKey: "gh-issue-number" })).toBe(42);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);

    // Replay 1
    await engine.doSync("iss-1", "co-1", harness.ctx, BASE_CONFIG);
    // Replay 2
    await engine.doSync("iss-1", "co-1", harness.ctx, BASE_CONFIG);
    // Replay 3
    await engine.doSync("iss-1", "co-1", harness.ctx, BASE_CONFIG);

    // Mapping still 42, no new POST calls
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss-1", namespace: "github-sync", stateKey: "gh-issue-number" })).toBe(42);
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
    // All replays went through the update path (PATCH)
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(3);
  });

  it("logs audit entries per GH call — no PAT, no event payload", async () => {
    const { fetchFn } = makeMockFetch([
      { status: 201, body: { number: 7, html_url: "https://github.com/acme/test-repo/issues/7", state: "open", title: "[GLA-1] Audit test", body: "" } },
    ]);

    const harness = createTestHarness({ manifest, capabilities: CAPS as unknown as PluginCapability[] });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-audit", title: "Audit test", identifier: "GLA-1", companyId: "co-1" })],
    });

    const engine = createSyncEngine({ fetchFn, debounceMs: 0 });
    await engine.doSync("iss-audit", "co-1", harness.ctx, BASE_CONFIG);

    const auditLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: audit — created GH issue",
    );
    expect(auditLog).toBeDefined();
    expect(auditLog?.meta?.["paperclipIssueId"]).toBe("iss-audit");
    expect(auditLog?.meta?.["githubIssueNumber"]).toBe(7);
    expect(auditLog?.meta?.["action"]).toBe("create");
    expect(auditLog?.meta?.["ts"]).toBeDefined();

    // PAT must not appear in any log
    const allLogs = JSON.stringify(harness.logs);
    expect(allLogs).not.toContain("resolved:github-token");
    expect(allLogs).not.toContain("github-token");
  });
});

// ---------------------------------------------------------------------------
// Sync engine — status transitions
// ---------------------------------------------------------------------------
describe("createSyncEngine — status transitions", () => {
  const CAPS = [...manifest.capabilities, "events.emit"] as const;
  const BASE_CONFIG = {
    repo: "acme/test-repo",
    host: "github.com",
    secretRef: "github-token",
    syncedGoalIds: [],
    dryRun: false,
  };

  it("in_progress → done closes GH issue with state_reason: completed", async () => {
    // First call: UPDATE (issue exists in state), second call (not needed — done handled via state field)
    const { fetchFn, calls } = makeMockFetch([
      // PATCH /issues/10 — update to closed
      { status: 200, body: { number: 10, state: "closed", title: "[GLA-2] Transition", body: "" } },
    ]);

    const harness = createTestHarness({ manifest, capabilities: CAPS as unknown as PluginCapability[] });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-t", title: "Transition", identifier: "GLA-2", companyId: "co-1", status: "done" })],
    });

    // Seed existing mapping (simulates prior in_progress sync)
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "iss-t", namespace: "github-sync", stateKey: "gh-issue-number" },
      10,
    );

    const engine = createSyncEngine({ fetchFn, debounceMs: 0 });
    await engine.doSync("iss-t", "co-1", harness.ctx, BASE_CONFIG);

    expect(calls).toHaveLength(1);
    const patch = calls[0];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toContain("/issues/10");
    expect(patch?.body).toMatchObject({ state: "closed", state_reason: "completed" });

    const auditLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: audit — updated GH issue",
    );
    expect(auditLog?.meta?.["action"]).toBe("update");
    expect(auditLog?.meta?.["githubIssueNumber"]).toBe(10);
  });

  it("new done issue: creates open then immediately closes", async () => {
    const { fetchFn, calls } = makeMockFetch([
      // POST /issues
      { status: 201, body: { number: 11, state: "open", title: "[GLA-3] Done on arrival", body: "" } },
      // PATCH /issues/11 — close
      { status: 200, body: { number: 11, state: "closed", title: "[GLA-3] Done on arrival", body: "" } },
    ]);

    const harness = createTestHarness({ manifest, capabilities: CAPS as unknown as PluginCapability[] });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-done", title: "Done on arrival", identifier: "GLA-3", companyId: "co-1", status: "done" })],
    });

    const engine = createSyncEngine({ fetchFn, debounceMs: 0 });
    await engine.doSync("iss-done", "co-1", harness.ctx, BASE_CONFIG);

    const postCall = calls.find((c) => c.method === "POST");
    const closeCall = calls.find((c) => c.method === "PATCH");
    expect(postCall).toBeDefined();
    expect(closeCall?.body).toMatchObject({ state: "closed", state_reason: "completed" });
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss-done", namespace: "github-sync", stateKey: "gh-issue-number" })).toBe(11);
  });

  it("cancelled → closed with state_reason: not_planned", async () => {
    const { fetchFn, calls } = makeMockFetch([
      { status: 200, body: { number: 12, state: "closed" } },
    ]);

    const harness = createTestHarness({ manifest, capabilities: CAPS as unknown as PluginCapability[] });
    harness.setConfig(BASE_CONFIG);
    harness.seed({
      issues: [makeIssue({ id: "iss-cancel", title: "Cancelled", identifier: "GLA-4", companyId: "co-1", status: "cancelled" })],
    });
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: "iss-cancel", namespace: "github-sync", stateKey: "gh-issue-number" },
      12,
    );

    const engine = createSyncEngine({ fetchFn, debounceMs: 0 });
    await engine.doSync("iss-cancel", "co-1", harness.ctx, BASE_CONFIG);

    expect(calls[0]?.body).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });
});

// ---------------------------------------------------------------------------
// Sync engine — dry-run
// ---------------------------------------------------------------------------
describe("createSyncEngine — dry-run", () => {
  it("logs planned action and makes no GH API calls", async () => {
    const { fetchFn, calls } = makeMockFetch([]);

    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.setConfig({ repo: "acme/test-repo", host: "github.com", secretRef: "t", syncedGoalIds: [], dryRun: true });
    harness.seed({
      issues: [makeIssue({ id: "iss-dry", title: "Dry run test", identifier: "GLA-99", companyId: "co-1" })],
    });

    const engine = createSyncEngine({ fetchFn, debounceMs: 0 });
    await engine.doSync("iss-dry", "co-1", harness.ctx, {
      repo: "acme/test-repo",
      host: "github.com",
      secretRef: "t",
      dryRun: true,
    });

    expect(calls).toHaveLength(0);
    const dryLog = harness.logs.find(
      (l) => l.level === "info" && l.message === "github-sync: dry-run — would sync to GitHub",
    );
    expect(dryLog).toBeDefined();
    expect(dryLog?.meta?.["dryRun"]).not.toBeDefined(); // not leaked into meta by spec
    expect(dryLog?.meta?.["issueId"]).toBe("iss-dry");
    expect(dryLog?.meta?.["action"]).toBe("create");
  });
});

// ---------------------------------------------------------------------------
// Sync engine — debounce
// ---------------------------------------------------------------------------
describe("createSyncEngine — debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("collapses rapid events into one GH call", async () => {
    const { fetchFn, calls } = makeMockFetch([
      { status: 201, body: { number: 99, state: "open", title: "[GLA-6] Debounce", body: "" } },
    ]);

    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
    });
    harness.setConfig({ repo: "acme/test-repo", host: "github.com", secretRef: "t", syncedGoalIds: [], dryRun: false });
    harness.seed({
      issues: [makeIssue({ id: "iss-deb", title: "Debounce", identifier: "GLA-6", companyId: "co-1" })],
    });

    const engine = createSyncEngine({ fetchFn, debounceMs: 100 });
    const config = { repo: "acme/test-repo", host: "github.com", secretRef: "t", dryRun: false };

    // Fire 3 rapid events — only the last should result in a GH call
    engine.scheduleSync("iss-deb", "co-1", harness.ctx, config);
    engine.scheduleSync("iss-deb", "co-1", harness.ctx, config);
    engine.scheduleSync("iss-deb", "co-1", harness.ctx, config);

    // Advance timers to fire the debounced call
    await vi.runAllTimersAsync();

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("two different issues fire independently", async () => {
    const { fetchFn, calls } = makeMockFetch([
      { status: 201, body: { number: 1, state: "open", title: "", body: "" } },
      { status: 201, body: { number: 2, state: "open", title: "", body: "" } },
    ]);

    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.setConfig({ repo: "acme/test-repo", host: "github.com", secretRef: "t", syncedGoalIds: [], dryRun: false });
    harness.seed({
      issues: [
        makeIssue({ id: "iss-A", title: "Issue A", companyId: "co-1" }),
        makeIssue({ id: "iss-B", title: "Issue B", companyId: "co-1" }),
      ],
    });

    const engine = createSyncEngine({ fetchFn, debounceMs: 100 });
    const config = { repo: "acme/test-repo", host: "github.com", secretRef: "t", dryRun: false };

    engine.scheduleSync("iss-A", "co-1", harness.ctx, config);
    engine.scheduleSync("iss-B", "co-1", harness.ctx, config);

    await vi.runAllTimersAsync();

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
});
