import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HarnessDriverBackend } from "../../backends/harness-driver-backend.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import { DotHarnessDriver, type DotCommand, type DotDriverOptions } from "./dot-harness-driver.js";

const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Research saved.",
  completionClaim: { contractRevision: "dot-demo-v1", objectiveSatisfied: true, criteria: [], remainingWork: [] },
  evidence: [], verification: [], attentionRequests: [], artifacts: [] };

async function fixture(overrides: Partial<DotDriverOptions> = {}) {
  const identity = { companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), sessionId: randomUUID() };
  const principal = { companyId: identity.companyId, grantId: randomUUID() };
  const publish = vi.fn(async () => {});
  const executeTool = vi.fn(async () => ({ saved: true }));
  const assertAuthority = vi.fn(async () => {});
  const driver = new DotHarnessDriver({ identity, principal, expiresAt: Date.now() + 60_000,
    tools: [{ name: "write_document", description: "Save the report", inputSchema: { type: "object" } }],
    publish, executeTool, assertAuthority, ...overrides });
  const backend = new HarnessDriverBackend(driver);
  const session = await backend.openSession({ identity });
  const { turnId } = await session.startTurn({ message: { role: "user", text: "Research competitors and save a report." } });
  const call = (command: Omit<DotCommand, "turnId" | "requestId"> & Record<string, unknown>, requestId = randomUUID()) =>
    driver.command(principal, { ...command, turnId, requestId } as DotCommand);
  return { identity, principal, driver, backend, session, turnId, call, publish, executeTool, assertAuthority };
}

describe("Dot runner provider prototype", () => {
  it("runs a two-way assignment through the real native backend and valid PRP events", async () => {
    const f = await fixture();
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({ ...f.identity, turnId: f.turnId });
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain("Research competitors");
    expect(await f.driver.inbox(f.principal)).toMatchObject({ accepted: false });
    expect(await f.call({ operation: "read" })).toMatchObject({ message: { text: "Research competitors and save a report." } });
    await expect(f.call({ operation: "tool", name: "write_document", arguments: {} })).rejects.toThrow("Accept");
    await f.call({ operation: "accept" });
    await f.call({ operation: "tool", name: "write_document", arguments: { body: "Report" } });
    await f.call({ operation: "progress", text: "Saved the report." });
    const finishId = randomUUID();
    await f.call({ operation: "finish", result }, finishId);
    await f.call({ operation: "finish", result }, finishId);
    const events = [];
    for await (const event of f.session.events()) {
      expect(validatePrpEvent(event), JSON.stringify(event)).toMatchObject({ ok: true });
      events.push(event);
    }
    expect(events.filter(e => e.eventType === "turn.started")).toHaveLength(1);
    expect(events.filter(e => e.eventType === "run.result.proposed")).toHaveLength(1);
    expect(await f.session.result()).toMatchObject({ result, terminal: { runTerminalState: "succeeded" } });
    expect(await f.session.usage?.()).toBeNull();
    await f.session.close({ reason: "finished" });
  });

  it("deduplicates concurrent writes and rejects changed retries", async () => {
    const f = await fixture(); await f.call({ operation: "accept" });
    const id = randomUUID();
    const command = { operation: "tool", name: "write_document", arguments: { body: "One report" } } as const;
    const replies = await Promise.all([f.call(command, id), f.call(command, id)]);
    expect(replies).toEqual([{ saved: true }, { saved: true }]);
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    await expect(f.call({ ...command, arguments: { body: "Changed" } }, id)).rejects.toThrow("different arguments");
    f.driver.revoke();
  });

  it("does not redispatch a tool with an unknown outcome", async () => {
    const executeTool = vi.fn(async () => { throw new Error("committed but connection lost"); });
    const f = await fixture({ executeTool }); await f.call({ operation: "accept" });
    const id = randomUUID(); const command = { operation: "tool", name: "write_document", arguments: {} } as const;
    expect(await f.call(command, id)).toMatchObject({ outcome: "unknown" });
    expect(await f.call(command, id)).toMatchObject({ outcome: "unknown" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    f.driver.revoke();
  });

  it("enforces company, grant, turn, tool, expiry and live admission authority", async () => {
    let now = Date.now(); const f = await fixture({ now: () => now, expiresAt: now + 1000 });
    await expect(f.driver.inbox({ ...f.principal, companyId: randomUUID() })).rejects.toThrow("not bound");
    await expect(f.driver.inbox({ ...f.principal, grantId: randomUUID() })).rejects.toThrow("not bound");
    await expect(f.driver.command(f.principal, { operation: "accept", requestId: randomUUID(), turnId: randomUUID() })).rejects.toThrow("Stale");
    await f.call({ operation: "accept" });
    await expect(f.call({ operation: "tool", name: "arbitrary_admin", arguments: {} })).rejects.toThrow("not projected");
    f.assertAuthority.mockRejectedValueOnce(new Error("Agent paused"));
    await expect(f.call({ operation: "read" })).rejects.toThrow("Agent paused");
    now += 1001;
    await expect(f.call({ operation: "finish", result })).rejects.toThrow("expired");
    expect(f.executeTool).not.toHaveBeenCalled(); f.driver.revoke();
  });

  it("revokes callbacks immediately and does not claim a provider stop or recovery", async () => {
    const f = await fixture(); await f.call({ operation: "accept" });
    f.driver.revoke();
    await expect(f.call({ operation: "progress", text: "late" })).rejects.toThrow("revoked");
    await expect(f.session.close({ reason: "cancel" })).rejects.toThrow("stop is unconfirmed");
    expect(await f.backend.descriptor()).toMatchObject({ capabilities: { resume: false, interruption: false, steering: false } });
    expect(await f.backend.recoverSession(await f.session.snapshot(), { signal: new AbortController().signal })).toMatchObject({ recovered: false });
  });

  it("rejects a malformed result and cannot execute after completion", async () => {
    const f = await fixture(); await f.call({ operation: "accept" });
    await expect(f.call({ operation: "finish", result: { summary: "done" } })).rejects.toThrow("Invalid Paperclip");
    await f.call({ operation: "finish", result });
    await expect(f.call({ operation: "tool", name: "write_document", arguments: {} })).rejects.toThrow("already completed");
    expect(f.executeTool).not.toHaveBeenCalled(); f.driver.revoke();
  });

  it("settles event waiting when authority expires", async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture({ expiresAt: Date.now() + 1000 });
      const stream = f.session.events()[Symbol.asyncIterator]();
      await stream.next();
      const pending = stream.next();
      await vi.advanceTimersByTimeAsync(1001);
      // The native backend may synthesize a terminal failure, but cannot hang.
      await expect(pending).resolves.toBeDefined();
      await expect(f.call({ operation: "accept" })).rejects.toThrow("revoked");
      await stream.return?.(); f.driver.revoke();
    } finally { vi.useRealTimers(); }
  });

  it("reserves admission before awaiting authority and fences concurrent revocation", async () => {
    let release!: () => void;
    const identity = { companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), sessionId: randomUUID() };
    const driver = new DotHarnessDriver({ identity, principal: { companyId: identity.companyId, grantId: randomUUID() },
      expiresAt: Date.now() + 10_000, tools: [], publish: async () => {}, executeTool: async () => {},
      assertAuthority: () => new Promise<void>(resolve => { release = resolve; }) });
    const input = { runId: identity.runId, normalizedSessionId: identity.sessionId, workingDirectory: "/unused" };
    const first = driver.openSession(input);
    await expect(driver.openSession(input)).rejects.toThrow("already opened");
    driver.revoke(); release();
    await expect(first).rejects.toThrow("revoked during admission");
  });
});
