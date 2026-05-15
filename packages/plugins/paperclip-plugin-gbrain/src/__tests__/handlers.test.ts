import { describe, it, expect, vi } from "vitest";
import { handleRunFinished } from "../handlers.js";
import type { GbrainCallable } from "../pages.js";

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
    const client: GbrainCallable = {
      call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
        calls.push([tool, args]);
        if (tool === "get_page") return null;
        return { ok: true };
      }) as GbrainCallable["call"],
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleRunFinished({
      event: makeEvent(),
      makeClient: () => client,
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
      slug: "issue-blo-1",
      detail: "agent did X, Y, Z",
      date: "2026-05-15",
      source: "paperclip-plugin-gbrain",
    });
    expect(typeof lastCall.summary).toBe("string");
  });

  it("no-ops when autoRetain is false", async () => {
    const client = { call: vi.fn() };
    await handleRunFinished({
      event: makeEvent(),
      makeClient: () => client,
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
      makeClient: () => client,
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
        makeClient: () => client,
        logger,
        autoRetain: true,
        lookupIssueIdentifier: vi.fn(async () => "BLO-1"),
        lookupAgentName: vi.fn(async () => "CTO"),
      }),
    ).resolves.toEqual({ ok: false });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips when issue identifier cannot be resolved", async () => {
    const client = { call: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await handleRunFinished({
      event: makeEvent(),
      makeClient: () => client,
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
