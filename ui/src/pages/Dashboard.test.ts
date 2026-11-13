import type { Agent, CompactIssue, IssueSummary } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { derivePausedAgentBanner, recentTaskIndexRows, withTaskSummaries } from "./Dashboard";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Agent",
    status: "idle",
    pauseReason: null,
    ...overrides,
  } as unknown as Agent;
}

describe("derivePausedAgentBanner", () => {
  it("returns null with no agents loaded or an empty company", () => {
    expect(derivePausedAgentBanner(undefined)).toBeNull();
    expect(derivePausedAgentBanner([])).toBeNull();
  });

  it("prefers the imported banner and lists only import-paused agents", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "import" }),
      agent({ id: "b", status: "paused", pauseReason: "manual" }),
      agent({ id: "c", status: "idle" }),
    ]);
    expect(banner).toEqual({ kind: "imported", pausedImportedAgentIds: ["a"] });
  });

  it("falls back to the all-paused banner when no import pauses exist", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "paused", pauseReason: "system" }),
    ]);
    expect(banner).toEqual({ kind: "all-paused" });
  });

  it("shows nothing while at least one agent can run and none are import-paused", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "idle" }),
    ]);
    expect(banner).toBeNull();
  });
});

describe("dashboard recent tasks from the task index", () => {
  const row = (id: string, updatedAt: string): CompactIssue =>
    ({ id, identifier: id.toUpperCase(), title: id, status: "blocked", updatedAt, assigneeAgentId: "agent-1" }) as unknown as CompactIssue;

  it("keeps the ten most recently updated tasks, newest first", () => {
    const rows = Array.from({ length: 14 }, (_, index) => row(`t${index}`, new Date(Date.UTC(2026, 10, 1 + index)).toISOString()));
    expect(recentTaskIndexRows(rows.reverse()).map(issue => issue.id)).toEqual(
      ["t13", "t12", "t11", "t10", "t9", "t8", "t7", "t6", "t5", "t4"]);
  });

  it("reads each task's update time once, in one pass over a large company", () => {
    let reads = 0;
    const rows = Array.from({ length: 5_000 }, (_, index) => {
      const at = new Date(Date.UTC(2026, 0, 1) + ((index * 7919) % 5_000) * 60_000).toISOString();
      return Object.defineProperty({ id: `t${index}` }, "updatedAt", { get: () => { reads += 1; return at; } }) as unknown as CompactIssue;
    });
    const recent = recentTaskIndexRows(rows);
    expect(reads).toBe(5_000);
    const sorted = [...rows].sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt))).slice(0, 10);
    expect(recent.map(issue => issue.id)).toEqual(sorted.map(issue => issue.id));
  });

  it("takes the status glyph fields from the task summary and the rest from the index row", () => {
    const summary = { id: "t1", displayStatus: "in_queue", externalConversationState: "waiting",
      blockerAttention: { state: "covered" } } as unknown as IssueSummary;
    const [merged] = withTaskSummaries([row("t1", "2026-11-01T00:00:00.000Z")], [summary]);
    expect(merged).toMatchObject({ id: "t1", title: "t1", assigneeAgentId: "agent-1", displayStatus: "in_queue",
      externalConversationState: "waiting", blockerAttention: { state: "covered" } });
    const [plain] = withTaskSummaries([row("t2", "2026-11-01T00:00:00.000Z")], undefined);
    expect(plain).not.toHaveProperty("displayStatus");
  });
});
