import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

it.each([false, true])("commits idle account switches and close refreshes before ACK (retry: %s)", async retry => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runnerd-credential-host-")));
  const sourceHome = join(root, "seed");
  await mkdir(sourceHome, { mode: 0o700 });
  const credential = (revision: number, account = "synthetic-account") => JSON.stringify({ tokens: {
    account_id: account, access_token: `synthetic-access-${revision}`,
    refresh_token: `synthetic-refresh-${revision}`, id_token: "synthetic-identity",
  } });
  await writeFile(join(sourceHome, "auth.json"), credential(0), { mode: 0o600 });
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const committed: PrpEvent[] = [];
  const onCredentialsUpdated = vi.fn(async (event: PrpEvent) => {
    if (event.payload.revision === 1) await gate;
    if (retry && onCredentialsUpdated.mock.calls.length === 1) throw new Error("synthetic host commit failure");
    committed.push(structuredClone(event));
  });
  const bundle = createRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "provider.json")],
    stateDirectory: root,
    sourceCodexHome: sourceHome,
    environment: { PATH: process.env.PATH },
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    onCredentialsUpdated,
  });
  const driver = new CodexAppServerDriver({
    taskEnvelope: { schema: "paperclip.skillless_task.v1", objective: "Observe credential delivery.",
      completionContract: { revision: "test-v1", criteria: [{ id: "done", requirement: "Done." }] },
      constraints: [], expectedResultSchema: "paperclip.run_result.v1" },
    approvalPolicy: "never", includeCollaborationModeInstructions: false,
    transportFactory: () => bundle.transport,
  });
  const session = await driver.openSession({ runId: "credential-run", normalizedSessionId: "credential-session", workingDirectory: root });
  const journal = async () => JSON.parse(await readFile(join(root, "control-plane", "control-plane-state.json"), "utf8"));
  try {
    await session.startTurn({ message: { role: "user", text: "Finish." } });
    for await (const event of session.events()) {
      if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) break;
    }
    const auth = join(root, "codex-home", "auth.json");
    await writeFile(auth, credential(0, "synthetic-next-account"), { mode: 0o600 });
    await vi.waitFor(() => expect(onCredentialsUpdated).toHaveBeenCalled(), { timeout: 5_000 });
    const first = onCredentialsUpdated.mock.calls[0]![0];
    expect((await journal()).ackedSourceSeq).toBeLessThan(first.sourceSeq);
    expect(committed).toHaveLength(0);
    release();
    await vi.waitFor(async () => expect((await journal()).ackedSourceSeq).toBeGreaterThanOrEqual(first.sourceSeq));
    if (retry) expect(onCredentialsUpdated.mock.calls[1]![0]).toEqual(first);
    await session.attachRun!({ runId: "credential-next-run" });
    expect(committed).toHaveLength(1);
    await writeFile(auth, credential(1, "synthetic-next-account"), { mode: 0o600 });
    await session.close({ reason: "credential-cleanup-test" });
    expect(committed.map(event => event.payload.revision)).toEqual([1, 2]);
    expect(JSON.stringify(committed)).not.toContain("synthetic-next-account");
    expect(committed[1]!.runId).toBe("credential-next-run");
    expect((await journal()).ackedSourceSeq).toBeGreaterThanOrEqual(committed[1]!.sourceSeq);
  } finally {
    release();
    await bundle.transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
