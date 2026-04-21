import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  buildDoneThought,
  buildBlockedThought,
  buildDelegationThought,
} from "../src/thought-builder.js";

const TEST_COMPANY_ID = "comp-1";
const TEST_ENDPOINT = "http://localhost:3010";

function makeHarness(configOverrides: Record<string, unknown> = {}) {
  return createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "events.emit"],
    config: {
      openBrainEndpoint: TEST_ENDPOINT,
      captureOnDone: true,
      captureOnBlocked: true,
      captureOnDelegation: true,
      ...configOverrides,
    },
  });
}

function mockHttpFetch(harness: TestHarness) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
  });
  harness.ctx.http.fetch = fetchMock;
  return fetchMock;
}

describe("thought-builder", () => {
  it("buildDoneThought includes identifier and COMPLETED", () => {
    const thought = buildDoneThought(
      { identifier: "STA-99", title: "Fix the thing" },
      { body: "All issues resolved." },
      "Senior Engineer",
    );
    expect(thought).toContain("[STA-99]");
    expect(thought).toContain("COMPLETED");
    expect(thought).toContain("Senior Engineer");
    expect(thought).toContain("All issues resolved");
    expect(thought.length).toBeLessThanOrEqual(500);
  });

  it("buildBlockedThought includes BLOCKED", () => {
    const thought = buildBlockedThought(
      { identifier: "STA-42", title: "Deploy service" },
      { body: "Waiting on infra team" },
    );
    expect(thought).toContain("[STA-42]");
    expect(thought).toContain("BLOCKED");
    expect(thought).toContain("Waiting on infra team");
    expect(thought.length).toBeLessThanOrEqual(500);
  });

  it("buildDelegationThought includes DELEGATED and parent ref", () => {
    const thought = buildDelegationThought(
      { identifier: "STA-72", title: "Implement worker" },
      { identifier: "STA-70", title: "Build plugin" },
      "Senior Engineer",
    );
    expect(thought).toContain("[STA-72]");
    expect(thought).toContain("DELEGATED to Senior Engineer");
    expect(thought).toContain("STA-70");
    expect(thought.length).toBeLessThanOrEqual(500);
  });

  it("handles null comments gracefully", () => {
    const thought = buildDoneThought(
      { identifier: "STA-1", title: "Test" },
      null,
    );
    expect(thought).toContain("[STA-1]");
    expect(thought).toContain("COMPLETED");
  });

  it("handles null identifier", () => {
    const thought = buildDoneThought(
      { identifier: null, title: "No id task" },
      null,
    );
    expect(thought).toContain("No id task");
    expect(thought).toContain("COMPLETED");
  });

  it("truncates long thoughts to 500 chars", () => {
    const longComment = { body: "A".repeat(600) };
    const thought = buildDoneThought(
      { identifier: "STA-1", title: "Test" },
      longComment,
    );
    expect(thought.length).toBeLessThanOrEqual(500);
  });
});

describe("worker — issue.updated", () => {
  let harness: TestHarness;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = makeHarness();
    fetchMock = mockHttpFetch(harness);

    harness.seed({
      companies: [{ id: TEST_COMPANY_ID } as any],
      issues: [
        {
          id: "iss-done",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-100",
          title: "Complete the feature",
          status: "done",
          assigneeAgentId: "agent-1",
          parentId: null,
        } as any,
        {
          id: "iss-blocked",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-101",
          title: "Blocked on infra",
          status: "blocked",
          assigneeAgentId: "agent-1",
          parentId: null,
        } as any,
        {
          id: "iss-in-progress",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-102",
          title: "Still working",
          status: "in_progress",
          assigneeAgentId: "agent-1",
          parentId: null,
        } as any,
      ],
      issueComments: [
        {
          id: "comment-1",
          issueId: "iss-done",
          companyId: TEST_COMPANY_ID,
          body: "All tests passing, merged to main.",
          authorAgentId: "agent-1",
        } as any,
        {
          id: "comment-2",
          issueId: "iss-blocked",
          companyId: TEST_COMPANY_ID,
          body: "Waiting for DNS propagation.",
          authorAgentId: "agent-1",
        } as any,
      ],
      agents: [
        {
          id: "agent-1",
          companyId: TEST_COMPANY_ID,
          name: "Senior Engineer",
        } as any,
      ],
    });

    await plugin.definition.setup(harness.ctx);
  });

  it("captures thought when issue transitions to done", async () => {
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_ENDPOINT}/capture_thought`);
    const body = JSON.parse(init.body);
    expect(body.content).toContain("[STA-100]");
    expect(body.content).toContain("COMPLETED");
    expect(body.content).toContain("All tests passing");
  });

  it("captures thought when issue transitions to blocked", async () => {
    await harness.emit("issue.updated", {}, {
      entityId: "iss-blocked",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[STA-101]");
    expect(body.content).toContain("BLOCKED");
  });

  it("does not capture for in_progress status", async () => {
    await harness.emit("issue.updated", {}, {
      entityId: "iss-in-progress",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates: does not capture same status twice on repeated events", async () => {
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    // Simulate a second event — last-status is now "done", so no transition detected
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    // Still only called once — no status transition
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("records dedup state after capture", async () => {
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "iss-done",
      stateKey: "captured-done",
    });
    expect(state).toBeTruthy();
  });

  it("does not fire on non-status-change updates", async () => {
    // First event sets last-status to "done" and captures
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();

    // Second event: status is still "done" — no transition, should not fire
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recaptures after status re-entry (done → in_progress → done)", async () => {
    // First transition to done
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    // Transition to in_progress (simulate by updating issue status + emitting)
    harness.seed({
      issues: [
        {
          id: "iss-done",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-100",
          title: "Complete the feature",
          status: "in_progress",
          assigneeAgentId: "agent-1",
          parentId: null,
        } as any,
      ],
    });
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    // No capture for in_progress
    expect(fetchMock).toHaveBeenCalledOnce();

    // Transition back to done
    harness.seed({
      issues: [
        {
          id: "iss-done",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-100",
          title: "Complete the feature",
          status: "done",
          assigneeAgentId: "agent-1",
          parentId: null,
        } as any,
      ],
    });
    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });
    // Should recapture — dedup key was cleared on exit from "done"
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("worker — issue.updated with config flags disabled", () => {
  it("does not capture done when captureOnDone is false", async () => {
    const harness = makeHarness({ captureOnDone: false });
    const fetchMock = mockHttpFetch(harness);

    harness.seed({
      issues: [
        {
          id: "iss-done",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-100",
          title: "Complete the feature",
          status: "done",
          assigneeAgentId: null,
          parentId: null,
        } as any,
      ],
    });

    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.updated", {}, {
      entityId: "iss-done",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not capture blocked when captureOnBlocked is false", async () => {
    const harness = makeHarness({ captureOnBlocked: false });
    const fetchMock = mockHttpFetch(harness);

    harness.seed({
      issues: [
        {
          id: "iss-blocked",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-101",
          title: "Blocked on infra",
          status: "blocked",
          assigneeAgentId: null,
          parentId: null,
        } as any,
      ],
    });

    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.updated", {}, {
      entityId: "iss-blocked",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("worker — issue.created (delegation)", () => {
  it("captures delegation thought for subtask with assignee", async () => {
    const harness = makeHarness();
    const fetchMock = mockHttpFetch(harness);

    harness.seed({
      issues: [
        {
          id: "parent-1",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-70",
          title: "Build plugin",
          status: "in_progress",
          assigneeAgentId: "agent-cto",
          parentId: null,
        } as any,
        {
          id: "child-1",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-72",
          title: "Implement worker",
          status: "todo",
          assigneeAgentId: "agent-se",
          parentId: "parent-1",
        } as any,
      ],
      agents: [
        { id: "agent-se", companyId: TEST_COMPANY_ID, name: "Senior Engineer" } as any,
        { id: "agent-cto", companyId: TEST_COMPANY_ID, name: "CTO" } as any,
      ],
    });

    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.created", {}, {
      entityId: "child-1",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[STA-72]");
    expect(body.content).toContain("DELEGATED to Senior Engineer");
    expect(body.content).toContain("STA-70");
  });

  it("does not capture when issue has no parentId", async () => {
    const harness = makeHarness();
    const fetchMock = mockHttpFetch(harness);

    harness.seed({
      issues: [
        {
          id: "top-level",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-80",
          title: "Top level task",
          status: "todo",
          assigneeAgentId: "agent-1",
          parentId: null,
        } as any,
      ],
    });

    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.created", {}, {
      entityId: "top-level",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not capture when captureOnDelegation is false", async () => {
    const harness = makeHarness({ captureOnDelegation: false });
    const fetchMock = mockHttpFetch(harness);

    harness.seed({
      issues: [
        {
          id: "child-1",
          companyId: TEST_COMPANY_ID,
          identifier: "STA-72",
          title: "Implement worker",
          status: "todo",
          assigneeAgentId: "agent-1",
          parentId: "parent-1",
        } as any,
      ],
    });

    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.created", {}, {
      entityId: "child-1",
      entityType: "issue",
      companyId: TEST_COMPANY_ID,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("worker — health check", () => {
  it("returns health data with config", async () => {
    const harness = makeHarness();
    mockHttpFetch(harness);
    await plugin.definition.setup(harness.ctx);

    const health = await harness.getData<{ status: string; endpoint: string }>("health");
    expect(health.status).toBe("ok");
    expect(health.endpoint).toBe(TEST_ENDPOINT);
  });
});
