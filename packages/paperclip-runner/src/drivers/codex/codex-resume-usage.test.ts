import { describe, expect, it } from "vitest";
import {
  FakeCodexTransport,
  makeDriver,
  WORKSPACE,
  collectUntilTerminal,
} from "./codex-app-server-driver.test-support.js";

describe("Codex resume accounting through the production driver", () => {
  it("retains a run delta across repeated historical snapshots and a cold resume", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second], { conversationMode: "direct" });
    let session = await driver.openSession({
      runId: "first",
      normalizedSessionId: "session",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "First" } });
    first.push("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { inputTokens: 100, outputTokens: 10 },
        last: { inputTokens: 100, outputTokens: 10 },
      },
    });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(session.events());
    const persisted = JSON.parse(JSON.stringify(await session.snapshot!()));
    await session.close();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: WORKSPACE,
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    const recovered = await driver.recoverSession(persisted);
    expect(recovered.recovered).toBe(true);
    session = recovered.session!;
    await session.attachRun!({ runId: "second" });
    for (let i = 0; i < 3; i++)
      second.push("thread/tokenUsage/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: { inputTokens: 100, outputTokens: 10 },
          last: { inputTokens: 100, outputTokens: 10 },
        },
      });
    // Consume the historical diagnostics before admitting the next turn.
    const iterator = session.events()[Symbol.asyncIterator]();
    let historical = 0;
    while (historical < 3) {
      const { value } = await iterator.next();
      expect(value.eventType).not.toBe("provider.notice.recorded");
      if (value.payload.code === "codex_resume_usage_snapshot") historical++;
      expect(value.payload.kind).not.toBe("usage");
    }
    expect((await session.snapshot!()).codexUsageBaseline).toEqual({
      baseline: { inputTokens: 100, outputTokens: 10 },
      latest: { inputTokens: 100, outputTokens: 10 },
    });
    second.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    await session.startTurn({ message: { role: "user", text: "Second" } });
    for (let i = 0; i < 2; i++)
      second.push("thread/tokenUsage/updated", {
        threadId: "thread-1",
        turnId: "turn-2",
        tokenUsage: {
          total: { inputTokens: 140, outputTokens: 16 },
          last: { inputTokens: 20, outputTokens: 3 },
        },
      });
    second.push("thread/tokenUsage/updated", {
      threadId: "foreign-thread",
      turnId: "turn-2",
      tokenUsage: { total: { inputTokens: 9999 } },
    });
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    const usages = events.filter((event) => event.payload.kind === "usage");
    expect(usages).toHaveLength(2);
    for (const event of usages)
      expect(event.payload.usage).toMatchObject({
        runDelta: { inputTokens: 40, outputTokens: 6 },
      });
    expect(
      (await session.snapshot!()).codexUsageBaseline?.latest.inputTokens,
    ).toBe(140);
    await session.attachRun!({ runId: "second" });
    expect(
      (await session.snapshot!()).codexUsageBaseline?.baseline.inputTokens,
    ).toBe(100);
    expect(await session.usage!()).toMatchObject({
      runDelta: { inputTokens: 40, outputTokens: 6 },
    });
    expect(
      second.calls.filter((call) => call.method === "thread/resume")[0]?.params
        .excludeTurns,
    ).toBe(true);
    expect(
      second.calls
        .filter((call) => call.method === "thread/read")
        .every((call) => call.params.includeTurns === false),
    ).toBe(true);
    await session.close();
  });

  it("keeps the startup external sandbox profile on subsequent turns", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport], {
      conversationMode: "direct",
      environment: {
        PATH: "/bin",
        HOME: "/isolated/home",
        CODEX_HOME: "/isolated/codex",
        PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
      },
    }).openSession({
      runId: "external",
      normalizedSessionId: "external-session",
      workingDirectory: WORKSPACE,
    });
    await session.startTurn({ message: { role: "user", text: "Read notes" } });
    const start = transport.calls.find(
      (call) => call.method === "thread/start",
    )!;
    expect(
      transport.calls.find((call) => call.method === "turn/start")?.params
        .permissions,
    ).toBe(start.params.permissions);
    await session.close();
  });
});
