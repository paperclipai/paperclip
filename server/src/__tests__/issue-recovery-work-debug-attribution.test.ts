import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { signalDatabaseWork } from "@paperclipai/db/work-signals";
import { notifyIssueGraphRecovery } from "../services/issue-recovery-notifications.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

describeIssueRecovery("issue recovery work signal attribution", () => {
  const state = issueRecoveryFixture();

  it("logs nothing from recovery loads and checks while the flag is off", async () => {
    const f = await state.fixture();
    await state.db.insert(issues).values({ companyId: f.companyId, title: "Waiting", status: "in_review", assigneeAgentId: f.agentId });
    const event = vi.spyOn(workSignalDebug, "event");
    const signal = vi.spyOn(workSignalDebug, "signal");
    await state.start(); await state.settled();
    expect(event).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it("ties each stranded check to the load and hint that caused it when the flag is on", async () => {
    const f = await state.fixture();
    await state.db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    const [task] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Waiting", status: "in_review",
      assigneeAgentId: f.agentId }).returning();
    const [run] = await state.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: task.id, finishedAt: new Date(), contextSnapshot: { issueId: task.id } }).returning();
    await state.start(); await state.settled();
    const enabled = vi.spyOn(workSignalDebug, "enabled", "get").mockReturnValue(true);
    const event = vi.spyOn(workSignalDebug, "event").mockImplementation(() => {});
    const signal = vi.spyOn(workSignalDebug, "signal").mockImplementation(() => {});
    try {
      await state.db.transaction(tx => notifyIssueGraphRecovery(tx, { companyId: f.companyId, runId: run.id }));
      await state.settled({ backstopPending: true });
      expect(signal).toHaveBeenCalledWith("stranded-assignments",
        JSON.stringify({ companyId: f.companyId, graphRunId: run.id }), signalDatabaseWork);
      const stranded = event.mock.calls.filter(([topic]) => topic === "stranded-assignments");
      expect(stranded).toContainEqual(["stranded-assignments", "load",
        { scope: JSON.stringify([f.companyId, null, run.id, null, null]) }]);
      expect(stranded).toContainEqual(["stranded-assignments", "check",
        expect.objectContaining({ issueId: task.id, companyId: f.companyId, wake: "load" })]);
    } finally { enabled.mockRestore(); event.mockRestore(); signal.mockRestore(); }
  });

  it("logs one direct wake listing the woken queues with its caller's stack", async () => {
    await state.fixture();
    await state.start(); await state.settled();
    const enabled = vi.spyOn(workSignalDebug, "enabled", "get").mockReturnValue(true);
    const allows = vi.spyOn(workSignalDebug, "allows").mockImplementation(topic => topic === "stranded-assignments");
    const event = vi.spyOn(workSignalDebug, "event").mockImplementation(() => {});
    try {
      state.worker.wake();
      const wakes = event.mock.calls.filter(([, name]) => name === "direct_wake");
      expect(wakes).toHaveLength(1);
      const [topic, , fields, stack, entry] = wakes[0]!;
      expect(topic).toBe("stranded-assignments");
      expect(String(fields?.queues).split(",")).toEqual(expect.arrayContaining(["stranded-assignments",
        "orphan-blockers", "assigned-work-invariant"]));
      expect(stack).toBe("always");
      expect(entry).toBe(state.worker.wake);
      await state.settled();
    } finally { enabled.mockRestore(); allows.mockRestore(); event.mockRestore(); }
  });
});
