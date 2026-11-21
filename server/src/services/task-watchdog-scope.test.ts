import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolveTaskWatchdogMutationScope } from "./task-watchdog-scope.js";

vi.mock("@paperclipai/db", () => ({
  heartbeatRuns: { id: "runId", companyId: "companyId", agentId: "agentId", contextSnapshot: "contextSnapshot" },
  issueWatchdogs: { id: "watchdogId", companyId: "companyId", issueId: "issueId", watchdogAgentId: "agentId", watchdogIssueId: "watchdogIssueId", status: "status" },
  issues: {},
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));

const actor = { type: "agent", agentId: "agent", companyId: "company", runId: "run", source: "agent_jwt" };
const run = { id: "run", agentId: "agent", companyId: "company", contextSnapshot: { taskWatchdog: { watchedIssueId: "issue" } } };
const watchdog = { id: "watchdog", companyId: "company", issueId: "issue", watchdogIssueId: null };

function database(rows: unknown[][]) {
  const select = vi.fn(() => ({ from: () => ({ where: () => Promise.resolve(rows.shift() ?? []) }) }));
  return { db: { select } as unknown as Db, select };
}

describe("task-watchdog run credential binding", () => {
  it.each(["agent_key", undefined, "board_session"])("rejects a caller-selected watchdog run from %s", async source => {
    const { db, select } = database([[run], [watchdog]]);
    expect(await resolveTaskWatchdogMutationScope(db, { ...actor, source })).toEqual({
      kind: "invalid", detail: "Task-watchdog mutation scope requires a signed run credential.",
    });
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("retains the grant for a signed same-agent run backed by an active watchdog", async () => {
    const { db } = database([[run], [watchdog]]);
    expect(await resolveTaskWatchdogMutationScope(db, actor)).toMatchObject({ kind: "watchdog", watchedIssueId: "issue" });
  });
  it.each(["agentId", "companyId"])("rejects a signed run with a different %s", async field => {
    const { db } = database([[{ ...run, [field]: "other" }]]);
    expect(await resolveTaskWatchdogMutationScope(db, actor)).toMatchObject({ kind: "invalid" });
  });
  it("still requires an active persisted watchdog", async () => {
    const { db } = database([[run], []]);
    expect(await resolveTaskWatchdogMutationScope(db, actor)).toEqual({
      kind: "invalid", detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    });
  });
  it("leaves ordinary API key runs outside the watchdog grant", async () => {
    const { db } = database([[{ ...run, contextSnapshot: {} }]]);
    expect(await resolveTaskWatchdogMutationScope(db, { ...actor, source: "agent_key" })).toEqual({ kind: "none" });
  });
});
