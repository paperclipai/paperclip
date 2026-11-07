import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { collectUntilTerminal } from "../drivers/codex/codex-app-server-driver.test-support.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

it("keeps thread usage reported before a run's first turn as history, not a binding failure", async () => {
  // RC-61: a run attached to a shared Codex thread received the thread's usage
  // from earlier work before its own first turn. The transport bound it to an
  // empty turn, and the driver failed the run as an unowned authoritative
  // notification. That usage belongs to earlier work: keep it as the baseline.
  const root = await realpath(await mkdtemp(join(tmpdir(), "runnerd-pre-turn-usage-")));
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(workspace), mkdir(join(root, "home"))]);
  const environment = { PATH: process.env.PATH, HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  const bundle = createRunnerdCodexTransport({
    runnerBinary: process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider.json"), "--usage-before-first-turn"],
    stateDirectory: root, environment,
    prpIdentity: { runnerInstanceId: "runner-pre-turn-usage", environmentLeaseId: "lease-pre-turn-usage",
      runId: "pre-turn-usage", normalizedSessionId: "session-pre-turn-usage", turnId: "turn-pre-turn-usage",
      itemId: "item-pre-turn-usage" },
  });
  const driver = new CodexAppServerDriver({
    approvalPolicy: "never", includeCollaborationModeInstructions: false, environment,
    taskEnvelope: createCodexTaskEnvelope({ objective: "Finish.", contractRevision: "1",
      criteria: [{ id: "objective", requirement: "Finish." }], constraints: [] }),
    transportFactory: () => bundle.transport,
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  try {
    session = await driver.openSession({
      runId: "pre-turn-usage", normalizedSessionId: "session-pre-turn-usage", workingDirectory: workspace,
    });
    // The driver consumes the thread usage while no turn is active, and keeps
    // it as history: the thread total, with nothing billed to this run.
    const opened = session;
    await vi.waitFor(async () => {
      expect(await opened.usage!()).toMatchObject({
        total: { inputTokens: 5, outputTokens: 1 },
        runDelta: { inputTokens: 0, outputTokens: 0 },
      });
    }, { timeout: 15_000, interval: 50 });
    await session.startTurn({ message: { role: "user", text: "Finish." } });
    const events = await collectUntilTerminal(session.events());
    expect(events.at(-1)?.eventType).toBe("turn.completed");
    const usage = events.filter(event => event.eventType === "item.completed" && event.payload.kind === "usage")
      .map(event => (event.payload as { usage: { runDelta: Record<string, number> } }).usage.runDelta);
    expect(usage.length).toBeGreaterThan(0);
    // The turn's thread total is 12/3. The 5/1 reported before the turn is
    // history, so this run is billed only for the difference.
    expect(usage.at(-1)).toMatchObject({ inputTokens: 7, outputTokens: 2 });
  } finally {
    await session?.close({ reason: "test complete" }).catch(() => undefined);
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
