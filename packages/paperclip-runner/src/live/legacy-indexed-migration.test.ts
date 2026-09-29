import { resolveRunnerCargoTestBinary } from "../../test/cargo-test-binary.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, cp, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { migrateLegacySessionAuthority, type PreparedLocalSession } from "../control-plane/legacy-authority-activation.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { readDurableControlPlaneState } from "../control-plane/authority-locator.js";
import { readIndexedLocalState } from "../control-plane/indexed-local-state-reader.js";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

const execute = promisify(execFile);
const runnerBinary = resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "paperclip-runnerd");
const providerBinary = resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server");
const identity = { runnerInstanceId: "migration-runner", environmentLeaseId: "migration-lease", normalizedSessionId: "migration-session", runId: "migration-run", turnId: "migration-turn", itemId: "migration-item" };
async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

it("migrates a real legacy runner/provider through every activation crash boundary, then continues the same provider session", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-session-migration-"));
  const original = join(root, "original");
  const bundle = createCapabilityRunnerdCodexTransport({ runnerBinary, codexCommand: providerBinary,
    codexArgs: ["--state-file", join(root, "fake-state.json"), "--durable-turn-ids"], stateDirectory: original, prpIdentity: identity });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  let successor: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let authority: SqliteAuthorityStore | undefined;
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", { cwd: root,
      dynamicTools: [{ name: "get_task_context", description: "Read the task.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      completionContract: { revision: "migration-contract", criterionIds: ["objective"] } });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Complete before conversion." }] });
    for await (const notification of bundle.transport.notifications()) if (notification.method === "turn/completed") break;
    await bundle.transport.close();
    expect(bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
    const owner = bundle.evidence();
    const assertExclusiveFence = async () => {
      for (const pid of [owner.runnerPid, owner.codexPid]) {
        if (!pid) throw new Error("missing exact fixture process owner");
        try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
        throw new Error("fixture owner remains alive");
      }
    };
    await assertExclusiveFence();
    const controllerBytes = await readFile(join(original, "control-plane/control-plane-state.json"));
    const runnerBytes = await readFile(join(original, "runner/runner-state.json"));
    const providerBytes = await readFile(join(original, "runner/codex-provider-state.json"));
    const originalController = JSON.parse(controllerBytes.toString());
    const runner = JSON.parse(runnerBytes.toString());
    const boundaries = ["source-change", "intent", "prepared", "controller-commit", "publish:runner-state.sqlite", "publish:runner-state.sqlite.receipts", "publish:runner-state.sqlite.routing", "publish:runner-state.sqlite.lifetime", "publish:runner-state.sqlite.lock", "publish:codex-provider-state.sqlite", "publish:codex-provider-state.sqlite.receipts", "publish:codex-provider-state.sqlite.routing", "publish:codex-provider-state.sqlite.lifetime", "publish:codex-provider-state.sqlite.lock", "publish:runner-state.json", "publish:codex-provider-state.json", "controller-locator", "active"];
    for (const [index, boundary] of boundaries.entries()) {
      const directory = join(root, `case-${index}`);
      await cp(original, directory, { recursive: true });
      const controllerPath = join(directory, "control-plane/control-plane-state.json");
      const runnerPath = join(directory, "runner/runner-state.json");
      let expectedAck = originalController.ackedSourceSeq;
      if (boundary === "active") {
        // Storage qualification: inject valid historical diagnostic frames
        // after the real fixture settles. This is synthesized history, not
        // 2,000 model calls. Then migrate >192 MiB and resume real processes.
        const file = await open(controllerPath, "w", 0o600);
        const { committedEvents, ...metadata } = originalController;
        expectedAck += 2_000;
        await file.write(`${JSON.stringify({ ...metadata, ackedSourceSeq: expectedAck }).slice(0, -1)},"committedEvents":[`);
        let separator = "";
        for (const event of committedEvents) { await file.write(`${separator}${JSON.stringify(event)}`); separator = ","; }
        const padding = "x".repeat(100 * 1024);
        for (let seq = originalController.ackedSourceSeq + 1; seq <= expectedAck; seq++) {
          const sourceEventId = `migration-growth-${seq}`;
          const payload = { schema: "paperclip.prp.event.v1", schemaVersion: 1, ...identity, sourceSeq: seq, sourceEventId,
            sourceInstanceId: identity.runnerInstanceId, sourceKind: "runner", eventType: "harness.diagnostic", priority: 1,
            emittedAt: "2026-09-28T00:00:00.000Z", payload: { code: "qualification-history", text: padding } };
          await file.write(`,${JSON.stringify({ sourceSeq: seq, sourceEventId, eventType: "harness.diagnostic", priority: 1, deliveryCount: 1, logicalEffectCount: 1,
            envelope: { protocol: "paperclip.runner", version: 1, kind: "event", ...identity, payload } })}`);
        }
        await file.write("]}"); await file.close();
        expect((await stat(controllerPath)).size).toBeGreaterThan(192 * 1024 * 1024);
        await writeFile(runnerPath, JSON.stringify({ ...runner, ackedSourceSeq: expectedAck, nextSourceSeq: expectedAck + 1 }), { mode: 0o600 });
      }
      const originalControllerDigest = await fileDigest(controllerPath), originalRunnerDigest = await fileDigest(runnerPath);
      authority = await SqliteAuthorityStore.open({ path: join(directory, "control-plane/authority.sqlite"), binding: `migration-${index}`, create: true });
      const prepareLocal = async (destination: string): Promise<PreparedLocalSession> => {
        const args = ["storage", "stage-legacy", "--state-dir", join(directory, "runner"), "--destination", destination, "--fence-id", "migration-fence",
          "--connect-url", "ws://127.0.0.1:3000/api/runner/v1/connect/migration-run", "--runner-version", "qualification", "--runner-digest", `sha256:${"a".repeat(64)}`,
          "--max-outbox-bytes", String(runner.maxOutboxBytes), "--p0-reserve-bytes", String(runner.p0ReserveBytes),
          "--runner-id", identity.runnerInstanceId, "--environment-lease-id", identity.environmentLeaseId, "--session-id", identity.normalizedSessionId,
          "--run-id", identity.runId, "--turn-id", identity.turnId, "--item-id", identity.itemId];
        const { stdout } = await execute(runnerBinary, args, { maxBuffer: 128 * 1024, timeout: 30_000 });
        return JSON.parse(stdout) as PreparedLocalSession;
      };
      const options = { root: directory, identity, authority, fenceId: "migration-fence", assertExclusiveFence, prepareLocal };
      await expect(migrateLegacySessionAuthority({ ...options, onBoundary: async (name) => { if (name === boundary || (boundary === "source-change" && name === "prepared")) throw new Error(`crash:${boundary}`); } })).rejects.toThrow(`crash:${boundary}`);
      if (boundary === "source-change") {
        await appendFile(join(directory, "control-plane/control-plane-state.json"), "\n");
        await expect(migrateLegacySessionAuthority(options)).rejects.toThrow("source_changed");
        expect((await authority.load())!.state.phase).toBe("prepared");
        await authority.close(); authority = undefined;
        continue;
      }
      if (boundary !== "active") await expect(DurablePrpControlPlane.open({ stateDirectory: join(directory, "control-plane"), identity, expectedRunnerVersion: "test", expectedRunnerDigest: `sha256:${"a".repeat(64)}`, authorityStore: authority })).rejects.toThrow("migration_pending");
      await authority.close();
      authority = await SqliteAuthorityStore.open({ path: join(directory, "control-plane/authority.sqlite"), binding: `migration-${index}`, create: false });
      await migrateLegacySessionAuthority({ ...options, authority });
      const migrated = await readDurableControlPlaneState(join(directory, "control-plane"));
      expect(migrated.identity).toEqual(identity);
      expect(migrated.ackedSourceSeq).toBe(expectedAck);
      expect(await fileDigest(join(directory, "indexed-migration/legacy/control-plane-state.json"))).toBe(originalControllerDigest);
      expect(await fileDigest(join(directory, "indexed-migration/legacy/runner-state.json"))).toBe(originalRunnerDigest);
      expect(await readFile(join(directory, "indexed-migration/legacy/codex-provider-state.json"))).toEqual(providerBytes);
      for (const name of ["runner-state", "codex-provider-state"]) {
        expect((await stat(join(directory, "runner", `${name}.sqlite.routing`))).isDirectory()).toBe(true);
        await expect(stat(join(directory, "indexed-migration/runner", `${name}.sqlite.routing`))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await readIndexedLocalState(join(directory, "runner/runner-state.json"))).state).toMatchObject({ ...identity, lifecycle: "suspended" });
      const firstCommand = originalController.commands.find((command: {status:string}) => command.status === "completed");
      expect((await authority.getRecord(identity.runId, "command", firstCommand.commandId))!.body).toEqual(firstCommand);
      if (index === boundaries.length - 1) {
        await authority.close(); authority = undefined;
        successor = createCapabilityRunnerdCodexTransport({ runnerBinary, codexCommand: providerBinary,
          codexArgs: ["--state-file", join(root, "fake-state.json"), "--durable-turn-ids"],
          stateDirectory: directory, prpIdentity: { ...identity, runId: "migration-next-run", turnId: "migration-next-turn", itemId: "migration-next-item" },
          authorityStoreFactory: async (_identity, currentDirectory) => authority = await SqliteAuthorityStore.open({ path: join(currentDirectory, "authority.sqlite"), binding: `migration-${index}`, create: true }) });
        successor.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
        const resumed = await successor.transport.request("thread/read", {});
        expect((resumed.thread as Record<string, unknown>).id).toBe((opened.thread as Record<string, unknown>).id);
        await successor.transport.request("turn/start", { input: [{ type: "text", text: "Continue after indexed migration." }] });
        for await (const notification of successor.transport.notifications()) if (notification.method === "turn/completed") break;
        await successor.transport.close();
        expect(successor.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
      }
      await authority.close(); authority = undefined;
    }
  } finally {
    await successor?.transport.close(); await bundle.transport.close(); await authority?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
