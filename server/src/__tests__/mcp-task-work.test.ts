import { describe, expect, it, vi } from "vitest";
import { registerMcpTaskWork } from "../services/mcp-task-work.js";

describe("provider task background work", () => {
  it("files each wake under its own key, so a question wake never hides the completion wake", async () => {
    let registered: { run: (signal: AbortSignal) => Promise<unknown> } | undefined;
    const coordinator = { register: (_queue: string, task: { run: (signal: AbortSignal) => Promise<unknown> }) => {
      registered = task;
      return { ready: Promise.resolve(), wake: () => undefined, stop: async () => undefined };
    } };
    const wakeup = vi.fn(async (_agentId: string, _options: { idempotencyKey: string }) => null);
    const gateway = {
      pollDueMcpTasks: vi.fn(async (input: { wake?: (task: never) => Promise<void> }) => {
        for (const wakeKey of ["mcp-task:t1:input:1", "mcp-task:t1:settled"]) {
          await input.wake!({ companyId: "c", agentId: "a", issueId: "i", taskRecordId: "t1", toolName: "build", status: "completed", wakeKey } as never);
        }
        return { processed: 1 };
      }),
      nextMcpTaskPollAt: vi.fn(async () => null),
    };
    registerMcpTaskWork(coordinator as never, gateway as never, { wakeup } as never, () => true);
    await registered!.run(new AbortController().signal);
    expect(wakeup.mock.calls.map(([, options]) => options.idempotencyKey))
      .toEqual(["mcp-task:t1:input:1", "mcp-task:t1:settled"]);
  });
});
