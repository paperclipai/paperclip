import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { buildNativeHarnessBackupManifest, verifyNativeHarnessBackup } from "./native-session-executor.js";
import { readNativeIndexedCheckpointProof } from "./native-indexed-checkpoint-proof.js";
import { digestNativeHarnessBackupDirectory } from "./native-harness-tree.js";
import { createRemoteIndexedSessionCheckpoint } from "./native-indexed-checkpoint.js";
import { inspectRemoteIndexedState } from "./native-indexed-inspection.js";
import { downloadCheckpointDirectory } from "./native-checkpoint-transfer.js";
import { loopbackCheckpointDuplexRunner } from "./native-checkpoint-transfer.test-support.js";
import { resolvePaperclipRunnerBinary } from "./native-codex-runner.js";

const names = ["runner-state", "codex-provider-state"], keys = ["runner", "codex-provider"], bindings = ["runner/r/s", "provider/r/s"];
function fixture(root: string, runnerBinary: string) {
  const directory = join(root, "source"); mkdirSync(directory, { mode: 0o700 });
  const states = [{ runId: "run-1", lifecycle: "suspended", runnerInstanceId: "r", normalizedSessionId: "s", nextSourceSeq: 2, ackedSourceSeq: 1 },
    { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "session_open", config: { provider: "codex", driver: "codex_app_server" }, activeProviderTurnId: null, pendingEvents: [], queuedEvents: [], threadId: "original-provider-thread" }];
  const ancient = "界".repeat(400_000);
  for (let index = 0; index < 2; index++) {
    writeFileSync(join(directory, `${names[index]}.json`), JSON.stringify({ schema: index === 0 ? "paperclip.runner.durable.state.indexed.v1" : "paperclip.runner.codex-provider-state.indexed.v1", binding: bindings[index] }), { mode: 0o600 });
    const requests = [{ id: 1, operation: "commit", input: { key: keys[index], expectedGeneration: "0", bytes: Buffer.from(JSON.stringify(states[index])).toString("base64"), receipts: [{ namespace: "ancient", key: "exact", bytes: Buffer.from(ancient).toString("base64") }] } }, { id: 2, operation: "close" }];
    const output = execFileSync(runnerBinary, ["storage", "rpc", "--path", join(directory, `${names[index]}.sqlite`), "--binding", bindings[index]!, "--create", "true"], { input: requests.map(request => JSON.stringify(request)).join("\n") + "\n", maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
    expect(output.split("\n").filter(Boolean).map(line => JSON.parse(line).error)).toEqual([undefined, undefined]);
  }
  return { directory, states, ancient };
}
it("snapshots, transfers, and reopens both native stores after source loss without an execute RPC deadline", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-indexed-checkpoint-"))), runnerBinary = resolvePaperclipRunnerBinary();
  const runner = loopbackCheckpointDuplexRunner(), execute = runner.execute.bind(runner);
  runner.execute = vi.fn(async options => {
    if (options.timeoutMs === 0) throw new Error("ordinary RPC deadline");
    return execute(options);
  });
  const duplex = vi.spyOn(runner, "openDuplexChannel");
  try {
    const source = fixture(root, runnerBinary), input = { runner, runnerBinary, directory: source.directory };
    const checkpoint = await createRemoteIndexedSessionCheckpoint(input);
    expect((await createRemoteIndexedSessionCheckpoint(input)).directory).toBe(checkpoint.directory);
    const current = join(root, "failover-backups", "current"), restored = join(current, "runner");
    mkdirSync(join(current, "codex-home"), { recursive: true, mode: 0o700 });
    await downloadCheckpointDirectory({ runner, sourcePath: checkpoint.directory, targetPath: restored, mode: 0o700 });
    await checkpoint.dispose(); expect(existsSync(checkpoint.directory)).toBe(false);
    const before = await digestNativeHarnessBackupDirectory(restored);
    const proof = await readNativeIndexedCheckpointProof(restored);
    expect(proof?.bindings).toMatchObject({ runId: "run-1", runner: { generation: "1" }, provider: { generation: "1" } });
    expect(await digestNativeHarnessBackupDirectory(restored)).toEqual(before);
    const execution = { provider: { kind: "codex", model: "gpt-5.6-sol", approvalPolicy: "never" },
      binding: { companyId: "company", runId: "run-1", issueId: "issue", agentId: "agent", executionWorkspaceId: "workspace" },
      workspace: { cwd: "/workspace", repoUrl: "https://example.test/repo.git", repoRef: "main", branchName: "snapshot-test" },
      session: { normalizedSessionId: "s", driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    } as unknown as NativeExecutionInput;
    const manifest = await buildNativeHarnessBackupManifest({ backupRoot: current, execution, runnerInstanceId: "r", sourceProviderLeaseId: "sandbox", providerSessionIdentity: { providerSessionId: "original-provider-thread", providerBackendSessionId: null, providerSessionIdentity: null } });
    const manifestPath = join(current, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    expect(manifest.nativeState).toEqual(proof!.bindings);
    const next = { ...execution, binding: { ...execution.binding, runId: "run-2" } };
    expect(await verifyNativeHarnessBackup({ root, execution: next, runnerInstanceId: "r" })).not.toBeNull();
    expect(await verifyNativeHarnessBackup({ root, execution: next, runnerInstanceId: "r" })).not.toBeNull();
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, nativeState: { ...manifest.nativeState, provider: { ...manifest.nativeState!.provider, generation: "2" } } }));
    expect(await verifyNativeHarnessBackup({ root, execution: next, runnerInstanceId: "r" })).toBeNull();
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const nativeManifestPath = join(restored, "indexed-session-snapshot.json"), nativeBytes = readFileSync(nativeManifestPath);
    const native = JSON.parse(nativeBytes.toString()); native.states[1].generation = "2";
    writeFileSync(nativeManifestPath, JSON.stringify(native));
    await expect(readNativeIndexedCheckpointProof(restored)).rejects.toThrow("indexed_snapshot_binding");
    writeFileSync(nativeManifestPath, nativeBytes);
    rmSync(source.directory, { recursive: true });
    for (let index = 0; index < 2; index++) {
      const current = await inspectRemoteIndexedState({ runner, runnerBinary, path: join(restored, `${names[index]}.json`) });
      expect(current.generation).toBe("1");
      expect(current.stateDigest).toBe(createHash("sha256").update(JSON.stringify(source.states[index])).digest("hex"));
      const requests = [{ id: 1, operation: "get", input: { namespace: "ancient", key: "exact" } }, { id: 2, operation: "close" }];
      const result = execFileSync(runnerBinary, ["storage", "rpc", "--path", join(restored, `${names[index]}.sqlite`), "--binding", bindings[index]!], { input: requests.map(request => JSON.stringify(request)).join("\n") + "\n", encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      expect(Buffer.from(JSON.parse(result.split("\n")[0]!).value, "base64").toString("utf8")).toBe(source.ancient);
    }
    expect(duplex.mock.calls.some(([request]) => request.command.some(value => value.includes("snapshot-session")))).toBe(true);
    expect(vi.mocked(runner.execute).mock.calls.every(([request]) => request.timeoutMs !== 0)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
it("rejects unsupported snapshot transport before opening or copying state", async () => {
  const runner = loopbackCheckpointDuplexRunner(); runner.openDuplexChannel = undefined;
  await expect(createRemoteIndexedSessionCheckpoint({ runner, runnerBinary: "/private/runnerd", directory: "/private/session" })).rejects.toThrow("transport_unavailable");
});

it("does not classify indexed stores with a missing snapshot marker as a legacy backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-missing-snapshot-marker-"));
  try {
    expect(await readNativeIndexedCheckpointProof(root)).toBeNull();
    writeFileSync(join(root, "runner-state.sqlite"), "unproven", { mode: 0o600 });
    await expect(readNativeIndexedCheckpointProof(root)).rejects.toThrow("indexed_snapshot_binding");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
