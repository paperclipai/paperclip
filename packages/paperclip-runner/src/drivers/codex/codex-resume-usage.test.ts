import { describe, expect, it } from "vitest";
import {
  FakeCodexTransport,
  makeDriver,
  WORKSPACE,
  collectUntilTerminal,
} from "./codex-app-server-driver.test-support.js";

describe("Codex resume accounting through the production driver", () => {
  it.each(["thread", "snapshot"] as const)(
    "retains the same run delta through an active cold reconciliation: %s",
    async (usageLocation) => {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      const third = new FakeCodexTransport();
      const driver = makeDriver([first, second, third], {
        conversationMode: "direct",
      });
      const readResponse = (inputTokens: number, outputTokens: number) => {
        const tokenUsage = {
          total: { inputTokens, outputTokens },
          last: { inputTokens: 40, outputTokens: 6 },
        };
        return {
          thread: {
            id: "thread-1",
            sessionId: "provider-session-1",
            cwd: WORKSPACE,
            turns: [{ id: "turn-2", status: "inProgress", items: [] }],
            ...(usageLocation === "thread" ? { tokenUsage } : {}),
          },
          ...(usageLocation === "snapshot" ? { tokenUsage } : {}),
        };
      };
      const session = await driver.openSession({
        runId: "first",
        normalizedSessionId: "same-run-accounting",
        workingDirectory: WORKSPACE,
      });
      let recoveredSession: typeof session | undefined;
      try {
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
        await session.attachRun!({ runId: "second" });
        first.turnStartResponse = Promise.resolve({
          turn: { id: "turn-2", status: "inProgress", items: [] },
        });
        await session.startTurn({ message: { role: "user", text: "Second" } });
        first.push("thread/tokenUsage/updated", {
          threadId: "thread-1",
          turnId: "turn-2",
          tokenUsage: {
            total: { inputTokens: 140, outputTokens: 16 },
            last: { inputTokens: 40, outputTokens: 6 },
          },
        });
        for await (const event of session.events()) {
          if (event.payload.kind === "usage") break;
        }
        const persisted = JSON.parse(JSON.stringify(await session.snapshot!()));
        expect(persisted).toMatchObject({
          runId: "second",
          activeTurnId: "turn-2",
          codexUsageBaseline: {
            baseline: { inputTokens: 100, outputTokens: 10 },
            latest: { inputTokens: 140, outputTokens: 16 },
          },
        });
        expect(await session.usage!()).toMatchObject({
          runDelta: { inputTokens: 40, outputTokens: 6 },
        });
        await session.close();
        second.readResponse = readResponse(140, 16);
        const recovery = await driver.recoverSession(persisted);
        expect(recovery.recovered).toBe(true);
        recoveredSession = recovery.session!;
        expect(await recoveredSession.snapshot!()).toMatchObject({
          runId: "second",
          activeTurnId: "turn-2",
          codexUsageBaseline: persisted.codexUsageBaseline,
        });
        expect(
          second.calls.filter((call) => call.method === "turn/start"),
        ).toEqual([]);
        expect(await recoveredSession.usage!()).toMatchObject({
          total: { inputTokens: 140, outputTokens: 16 },
          runDelta: { inputTokens: 40, outputTokens: 6 },
        });
        for (const [
          reportedInput,
          reportedOutput,
          latestInput,
          latestOutput,
        ] of [
          [140, 16, 140, 16],
          [130, 13, 140, 16],
          [150, 19, 150, 19],
        ]) {
          second.readResponse = readResponse(reportedInput!, reportedOutput!);
          await recoveredSession.reconcile!();
          expect(await recoveredSession.usage!()).toEqual({
            total: { inputTokens: latestInput, outputTokens: latestOutput },
            last: { inputTokens: 40, outputTokens: 6 },
            runDelta: {
              inputTokens: latestInput! - 100,
              outputTokens: latestOutput! - 10,
            },
          });
        }
        const advanced = JSON.parse(
          JSON.stringify(await recoveredSession.snapshot!()),
        );
        expect(advanced.codexUsageBaseline).toEqual({
          baseline: { inputTokens: 100, outputTokens: 10 },
          latest: { inputTokens: 150, outputTokens: 19 },
        });
        expect(persisted.codexUsageBaseline.latest).toEqual({
          inputTokens: 140,
          outputTokens: 16,
        });
        await recoveredSession.close();
        third.readResponse = readResponse(150, 19);
        const secondRecovery = await driver.recoverSession(advanced);
        expect(secondRecovery.recovered).toBe(true);
        recoveredSession = secondRecovery.session!;
        expect(await recoveredSession.usage!()).toMatchObject({
          total: { inputTokens: 150, outputTokens: 19 },
          runDelta: { inputTokens: 50, outputTokens: 9 },
        });
        expect((await recoveredSession.snapshot!()).codexUsageBaseline).toEqual(
          advanced.codexUsageBaseline,
        );
        expect(
          [...second.calls, ...third.calls].filter(
            (call) => call.method === "turn/start",
          ),
        ).toEqual([]);
      } finally {
        await recoveredSession?.close();
        await session.close();
      }
    },
  );

  it.each([
    { driverKind: "codex_app_server", retainedBaseline: false },
    { driverKind: "other_protocol_facade", retainedBaseline: true },
  ])(
    "preserves raw reconciliation usage outside an existing Codex baseline: $driverKind",
    async ({ driverKind, retainedBaseline }) => {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      const driver = makeDriver([first, second], {
        conversationMode: "direct",
        driverIdentity: {
          kind: driverKind,
          displayName: "Accounting boundary",
          version: "test",
        },
      });
      const session = await driver.openSession({
        runId: "unchanged",
        normalizedSessionId: "raw-reconcile-accounting",
        workingDirectory: WORKSPACE,
      });
      let recoveredSession: typeof session | undefined;
      try {
        await session.startTurn({
          message: { role: "user", text: "Continue" },
        });
        const persisted = JSON.parse(JSON.stringify(await session.snapshot!()));
        expect(persisted.codexUsageBaseline).toBeUndefined();
        // An optional retained accounting field must not opt another facade in.
        if (retainedBaseline)
          persisted.codexUsageBaseline = {
            baseline: { inputTokens: 100 },
            latest: { inputTokens: 140 },
          };
        await session.close();
        const tokenUsage = {
          total: { inputTokens: 150 },
          last: { inputTokens: 10 },
        };
        second.readResponse = {
          thread: {
            id: "thread-1",
            sessionId: "provider-session-1",
            cwd: WORKSPACE,
            turns: [{ id: "turn-1", status: "inProgress", items: [] }],
            tokenUsage,
          },
        };
        const recovery = await driver.recoverSession(persisted);
        expect(recovery.recovered).toBe(true);
        recoveredSession = recovery.session!;
        expect(await recoveredSession.usage!()).toEqual(tokenUsage);
        expect((await recoveredSession.snapshot!()).codexUsageBaseline).toEqual(
          persisted.codexUsageBaseline,
        );
        expect(
          second.calls.filter((call) => call.method === "turn/start"),
        ).toEqual([]);
      } finally {
        await recoveredSession?.close();
        await session.close();
      }
    },
  );

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
