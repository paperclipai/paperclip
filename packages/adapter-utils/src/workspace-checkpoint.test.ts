import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDirectorySnapshot, disposeDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import { writeCheckpointBaseline, workspaceCheckpointScript, readCheckpointSnapshot, validateCheckpointPayload } from "./workspace-checkpoint.js";
import { publishWorkspaceSeedGeneration, readWorkspaceSeedGeneration, workspaceSeedGeneration } from "./workspace-seed-cache.js";
import { WorkspaceManifestWriter } from "./workspace-manifest.js";
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-")); roots.push(temp); vi.stubEnv("PAPERCLIP_HOME", path.join(temp, "home"));
  const root = path.join(temp, "root"); await fs.mkdir(root);
  await fs.writeFile(path.join(root, "unchanged"), "retained");
  await fs.writeFile(path.join(root, "deleted"), "delete me");
  await fs.mkdir(path.join(root, "cache")); await fs.writeFile(path.join(root, "cache", "ignored"), "private");
  const baseline = await captureDirectorySnapshot(root, { diskBacked: true, exclude: ["cache"] });
  const manifest = path.join(temp, "baseline.sqlite"); await writeCheckpointBaseline(baseline, manifest);
  const script = path.join(temp, "checkpoint.mjs"); await fs.writeFile(script, workspaceCheckpointScript());
  const capture = async () => {
    const output = path.join(temp, "output");
    await execute(process.execPath, [script, root, manifest, output, JSON.stringify(baseline.exclude)]);
    const snapshot = readCheckpointSnapshot(path.join(output, "manifest.sqlite"), baseline);
    const payload = path.join(output, "payload");
    const metrics = await validateCheckpointPayload({ baseline, snapshot, payload });
    return { snapshot, payload, metrics, receipt: JSON.parse(await fs.readFile(path.join(output, "receipt.json"), "utf8")) };
  };
  return { temp, root, baseline, capture };
}
describe("workspace sparse checkpoint", () => {
  it.each((["file", "symlink", "missing"] as const).flatMap(attack =>
    (["a/kept", "a/nested/kept"] as const).flatMap(child =>
      (["manifest", "memory"] as const).map(storage => ({ attack, child, storage })))))(
    "rejects a returned $attack ancestor of $child ($storage) before any host mutation", async ({ attack, child, storage }) => {
    const f = await fixture(); await disposeDirectorySnapshot(f.baseline);
    await fs.mkdir(path.dirname(path.join(f.root, child)), { recursive: true });
    await fs.writeFile(path.join(f.root, child), "retained child");
    const baseline = await captureDirectorySnapshot(f.root, { diskBacked: true, exclude: ["cache"] });
    const payload = path.join(f.temp, "forged-payload"); await fs.mkdir(payload);
    await fs.writeFile(path.join(payload, "unchanged"), "otherwise valid edit");
    if (attack === "file") await fs.writeFile(path.join(payload, "a"), "replace directory");
    if (attack === "symlink") await fs.symlink("unchanged", path.join(payload, "a"));
    const captured = await captureDirectorySnapshot(payload);
    const entries = new Map(baseline.entries);
    entries.delete("deleted"); entries.delete("a");
    for (const [relative, entry] of captured.entries) entries.set(relative, entry);
    const manifest = path.join(f.temp, "forged.sqlite");
    await writeCheckpointBaseline({ ...baseline, entries }, manifest);
    const evidence = await fs.readFile(manifest);
    const snapshot = storage === "manifest" ? readCheckpointSnapshot(manifest, baseline)
      : { ...baseline, entries: new Map([...entries].reverse()) };
    let failure: unknown;
    try {
      await validateCheckpointPayload({ baseline, snapshot, payload });
      await mergeDirectoryWithBaseline({ baseline, sourceDir: payload, targetDir: f.root, snapshots: { source: snapshot } });
    } catch (error) { failure = error; }
    expect(await fs.readFile(path.join(f.root, child), "utf8")).toBe("retained child");
    expect(await fs.readFile(path.join(f.root, "unchanged"), "utf8")).toBe("retained");
    expect(await fs.readFile(path.join(f.root, "deleted"), "utf8")).toBe("delete me");
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Invalid workspace checkpoint parent");
    expect(await fs.readFile(manifest)).toEqual(evidence);
    const replay = readCheckpointSnapshot(manifest, baseline);
    await expect(validateCheckpointPayload({ baseline, snapshot: replay, payload })).rejects.toThrow("Invalid workspace checkpoint parent");
    await disposeDirectorySnapshot(replay); await disposeDirectorySnapshot(snapshot); await disposeDirectorySnapshot(baseline);
  });
  it.each(["file_to_directory", "directory_to_file"] as const)("restores a coherent %s checkpoint", async transition => {
    const f = await fixture(); await disposeDirectorySnapshot(f.baseline);
    if (transition === "file_to_directory") await fs.writeFile(path.join(f.root, "a"), "old file");
    else {
      await fs.mkdir(path.join(f.root, "a")); await fs.writeFile(path.join(f.root, "a", "old"), "old child");
    }
    const baseline = await captureDirectorySnapshot(f.root, { diskBacked: true, exclude: ["cache"] });
    const host = path.join(f.temp, "host"); await fs.cp(f.root, host, { recursive: true });
    await fs.rm(path.join(f.root, "a"), { recursive: true });
    if (transition === "file_to_directory") {
      await fs.mkdir(path.join(f.root, "a", "nested"), { recursive: true });
      await fs.writeFile(path.join(f.root, "a", "nested", "new"), "new child");
    } else await fs.writeFile(path.join(f.root, "a"), "new file");
    const manifest = path.join(f.temp, "transition-baseline.sqlite"); await writeCheckpointBaseline(baseline, manifest);
    const output = path.join(f.temp, "transition-output");
    await execute(process.execPath, [path.join(f.temp, "checkpoint.mjs"), f.root, manifest, output, JSON.stringify(baseline.exclude)]);
    const snapshot = readCheckpointSnapshot(path.join(output, "manifest.sqlite"), baseline), payload = path.join(output, "payload");
    await validateCheckpointPayload({ baseline, snapshot, payload });
    await mergeDirectoryWithBaseline({ baseline, sourceDir: payload, targetDir: host, snapshots: { source: snapshot } });
    expect(await fs.readFile(path.join(host, transition === "file_to_directory" ? "a/nested/new" : "a"), "utf8"))
      .toBe(transition === "file_to_directory" ? "new child" : "new file");
    expect(await fs.readFile(path.join(host, "unchanged"), "utf8")).toBe("retained");
    await disposeDirectorySnapshot(snapshot); await disposeDirectorySnapshot(baseline);
  });
  it("enumerates unchanged files but transfers zero workspace payload", async () => {
    const f = await fixture(); const result = await f.capture();
    expect(result.receipt).toMatchObject({ files: 0, bytes: 0, scanned: 2 });
    expect(result.metrics).toEqual({ mode: "sparse", scannedEntries: 2, changedFiles: 0, payloadBytes: 0 });
    expect(await fs.readdir(result.payload)).toEqual([]);
    expect([...result.snapshot.entries]).toEqual([...f.baseline.entries]);
    await disposeDirectorySnapshot(result.snapshot); await disposeDirectorySnapshot(f.baseline);
  });
  it("merges one changed file, deletion, unusual names and a safe link without copying unchanged files", async () => {
    const f = await fixture(); const host = path.join(f.temp, "host"); await fs.cp(f.root, host, { recursive: true });
    const name = "new\nfile"; await fs.writeFile(path.join(f.root, name), "changed");
    await fs.unlink(path.join(f.root, "deleted")); await fs.symlink(name, path.join(f.root, "link"));
    const result = await f.capture(); expect(result.receipt.files).toBe(1); expect(result.receipt.bytes).toBe(7);
    await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: result.payload, targetDir: host, snapshots: { source: result.snapshot } });
    expect(await fs.readFile(path.join(host, name), "utf8")).toBe("changed");
    expect(await fs.readFile(path.join(host, "unchanged"), "utf8")).toBe("retained");
    expect(await fs.readlink(path.join(host, "link"))).toBe(name);
    await expect(fs.stat(path.join(host, "deleted"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(host, "cache", "ignored"), "utf8")).toBe("private");
    await disposeDirectorySnapshot(f.baseline);
  });
  it.each(["absolute", "escaping"])("omits an %s link while restoring ordinary changes and safe links", async (kind) => {
    const f = await fixture();
    const host = path.join(f.temp, "host"); await fs.cp(f.root, host, { recursive: true });
    const outside = path.join(f.temp, "secret"); await fs.writeFile(outside, "outside bytes");
    await fs.symlink(kind === "absolute" ? outside : "../secret", path.join(f.root, "unsafe"));
    await fs.writeFile(path.join(f.root, "unchanged"), "edited");
    await fs.writeFile(path.join(f.root, "new"), "new output");
    await fs.unlink(path.join(f.root, "deleted"));
    await fs.symlink("new", path.join(f.root, "safe"));
    const result = await f.capture();
    expect(result.snapshot.entries.has("unsafe")).toBe(false);
    await expect(fs.lstat(path.join(result.payload, "unsafe"))).rejects.toMatchObject({ code: "ENOENT" });
    await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: result.payload, targetDir: host, snapshots: { source: result.snapshot } });
    expect(await fs.readFile(path.join(host, "unchanged"), "utf8")).toBe("edited");
    expect(await fs.readFile(path.join(host, "new"), "utf8")).toBe("new output");
    expect(await fs.readlink(path.join(host, "safe"))).toBe("new");
    await expect(fs.lstat(path.join(host, "unsafe"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(host, "deleted"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(outside, "utf8")).toBe("outside bytes");
    await disposeDirectorySnapshot(result.snapshot); await disposeDirectorySnapshot(f.baseline);
  });
  it("rejects an unsafe link forged into a checkpoint manifest before merge", async () => {
    const f = await fixture(); const result = await f.capture();
    const entries = new Map(result.snapshot.entries);
    entries.set("unsafe", { kind: "symlink", target: "../secret" });
    await expect(validateCheckpointPayload({ baseline: f.baseline, snapshot: { ...result.snapshot, entries }, payload: result.payload }))
      .rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    await disposeDirectorySnapshot(result.snapshot); await disposeDirectorySnapshot(f.baseline);
  });
  it("replays a checkpoint after interruption and preserves a concurrently edited deletion", async () => {
    const f = await fixture(); const host = path.join(f.temp, "host"); await fs.cp(f.root, host, { recursive: true });
    await fs.writeFile(path.join(f.root, "new"), "remote"); await fs.unlink(path.join(f.root, "deleted"));
    await fs.writeFile(path.join(host, "deleted"), "host edit");
    const result = await f.capture();
    await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: result.payload, targetDir: host, snapshots: { source: result.snapshot } });
    const replay = readCheckpointSnapshot(path.join(f.temp, "output", "manifest.sqlite"), f.baseline);
    await validateCheckpointPayload({ baseline: f.baseline, snapshot: replay, payload: result.payload });
    await mergeDirectoryWithBaseline({ baseline: f.baseline, sourceDir: result.payload, targetDir: host, snapshots: { source: replay } });
    expect(await fs.readFile(path.join(host, "deleted"), "utf8")).toBe("host edit");
    expect(await fs.readFile(path.join(host, "new"), "utf8")).toBe("remote");
    await disposeDirectorySnapshot(f.baseline);
  });
  it("rejects bytes changed after capture before applying the manifest", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.root, "new"), "remote");
    const result = await f.capture(); await fs.writeFile(path.join(result.payload, "new"), "tampered");
    await expect(validateCheckpointPayload({ baseline: f.baseline, snapshot: result.snapshot, payload: result.payload })).rejects.toThrow("payload mismatch");
    await disposeDirectorySnapshot(result.snapshot); await disposeDirectorySnapshot(f.baseline);
  });
  it.each(["array", "manifest"] as const)("rejects ignored entries and ancestor replacements before merge with %s ignore paths", async storage => {
    for (const attack of ["matching_file", "matching_descendant", "payload_only", "ancestor_file", "ancestor_link"] as const) {
      const f = await fixture(); await disposeDirectorySnapshot(f.baseline);
      await fs.writeFile(path.join(f.root, ".env"), "host secret");
      await fs.mkdir(path.join(f.root, "private")); await fs.writeFile(path.join(f.root, "private", "token"), "private token");
      await fs.mkdir(path.join(f.root, "config")); await fs.writeFile(path.join(f.root, "config", ".env"), "nested secret");
      const paths = [".env", "private", "config/.env"];
      const writer = new WorkspaceManifestWriter(path.join(f.temp, "ignored.sqlite"));
      for (const relative of paths) writer.add("ignored", relative);
      const ignoredPaths = storage === "manifest" ? writer.paths("ignored") : paths;
      writer.close();
      const baseline = await captureDirectorySnapshot(f.root, { exclude: ["cache"], ignoredPaths, diskBacked: true });
      const payload = path.join(f.temp, "forged-payload"); await fs.mkdir(payload);
      await fs.writeFile(path.join(payload, "unchanged"), "otherwise valid edit");
      if (attack === "matching_file" || attack === "payload_only") await fs.writeFile(path.join(payload, ".env"), "injected secret");
      if (attack === "matching_descendant") {
        await fs.mkdir(path.join(payload, "private")); await fs.writeFile(path.join(payload, "private", "token"), "injected token");
      }
      if (attack === "ancestor_file") await fs.writeFile(path.join(payload, "config"), "replace directory");
      if (attack === "ancestor_link") await fs.symlink("unchanged", path.join(payload, "config"));
      const captured = await captureDirectorySnapshot(payload);
      const entries = new Map(baseline.entries);
      entries.delete("deleted");
      for (const [relative, entry] of captured.entries) if (!(attack === "payload_only" && relative === ".env")) entries.set(relative, entry);
      if (attack === "matching_descendant") entries.delete("private");
      const manifestPath = path.join(f.temp, "forged.sqlite");
      await writeCheckpointBaseline({ ...baseline, entries }, manifestPath);
      const snapshot = readCheckpointSnapshot(manifestPath, baseline);
      try {
        await expect((async () => {
          await validateCheckpointPayload({ baseline, snapshot, payload });
          await mergeDirectoryWithBaseline({ baseline, sourceDir: payload, targetDir: f.root, snapshots: { source: snapshot } });
        })()).rejects.toThrow(attack.startsWith("ancestor") ? "ignored path ancestor" : "Excluded workspace checkpoint entry");
        expect(await fs.readFile(path.join(f.root, "unchanged"), "utf8")).toBe("retained");
        expect(await fs.readFile(path.join(f.root, "deleted"), "utf8")).toBe("delete me");
        expect(await fs.readFile(path.join(f.root, ".env"), "utf8")).toBe("host secret");
        expect(await fs.readFile(path.join(f.root, "private", "token"), "utf8")).toBe("private token");
        expect(await fs.readFile(path.join(f.root, "config", ".env"), "utf8")).toBe("nested secret");
      } finally { await disposeDirectorySnapshot(snapshot); await disposeDirectorySnapshot(baseline); }
    }
  });
  it("allows directory tombstones while retaining ignored host children", async () => {
    const f = await fixture(); await disposeDirectorySnapshot(f.baseline);
    await fs.mkdir(path.join(f.root, "config"));
    await fs.writeFile(path.join(f.root, "config", ".env"), "host only");
    await fs.writeFile(path.join(f.root, "config", "tracked"), "delete tracked child");
    const baseline = await captureDirectorySnapshot(f.root, { exclude: ["cache"], ignoredPaths: ["config/.env"], diskBacked: true });
    const payload = path.join(f.temp, "payload"); await fs.mkdir(payload);
    await fs.writeFile(path.join(payload, "unchanged"), "valid edit");
    const captured = await captureDirectorySnapshot(payload);
    const snapshot = { ...baseline, entries: new Map(captured.entries) };
    await validateCheckpointPayload({ baseline, snapshot, payload });
    await mergeDirectoryWithBaseline({ baseline, sourceDir: payload, targetDir: f.root, snapshots: { source: snapshot } });
    expect(await fs.readFile(path.join(f.root, "config", ".env"), "utf8")).toBe("host only");
    expect(await fs.readFile(path.join(f.root, "unchanged"), "utf8")).toBe("valid edit");
    await expect(fs.stat(path.join(f.root, "config", "tracked"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(f.root, "deleted"))).rejects.toMatchObject({ code: "ENOENT" });
    await disposeDirectorySnapshot(baseline);
  });
  it("reuses durable seed generations and rejects corruption after run cleanup", async () => {
    const f = await fixture(); const cache = path.join(f.temp, "cache-seeds");
    const archive = path.join(f.temp, "seed.tar"); await fs.writeFile(archive, "archive");
    const generation = workspaceSeedGeneration(f.baseline, null);
    await publishWorkspaceSeedGeneration(cache, generation, { workspaceArchivePath: archive });
    await fs.unlink(archive);
    const cached = await readWorkspaceSeedGeneration(cache, generation); expect(cached).not.toBeNull();
    expect(await fs.readFile(cached!.workspaceArchivePath, "utf8")).toBe("archive");
    await fs.writeFile(cached!.workspaceArchivePath, "corrupted");
    expect(await readWorkspaceSeedGeneration(cache, generation)).toBeNull();
    await disposeDirectorySnapshot(f.baseline);
  });
});

it("uses sparse native transfer end-to-end, including replay and unsupported-runtime fallback", async () => {
  const { prepareSandboxManagedRuntime } = await import("./sandbox-managed-runtime.js");
  const f = await fixture(); await disposeDirectorySnapshot(f.baseline);
  const remote = path.join(f.temp, "remote");
  const cache = path.join(f.temp, "seeds");
  let supportsCheckpoint = true;
  let payloadBytes = -1;
  let mutateDuringPack = false;
  let failVerification = false, verificationCalls = 0;
  const run = async (command: string) => {
    if (!supportsCheckpoint && command.startsWith("node --input-type=module")) throw new Error("node unavailable");
    await execute("sh", ["-c", command]);
  };
  const sync = async (operations: import("./sandbox-managed-runtime.js").SandboxSyncOperation[]) => {
    for (const operation of operations) {
      for (const file of operation.files) {
        await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
        await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true,
          filter: (source) => !file.exclude?.some((exclude) => path.relative(file.sourcePath, source) === exclude) });
        if (file.sourcePath.endsWith("/output")) {
          payloadBytes = JSON.parse(await fs.readFile(path.join(file.targetPath, "receipt.json"), "utf8")).bytes;
        }
      }
      for (const command of operation.postUploadCommands ?? []) await run(command.command);
    }
    return { operations: operations.map((op) => ({ operationId: op.operationId, filesTransferred: 0, bytesTransferred: 0 })) };
  };
  const client = { makeDir: (dir: string) => fs.mkdir(dir, { recursive: true }).then(() => {}),
    writeFile: (file: string, data: ArrayBuffer) => fs.writeFile(file, Buffer.from(data)), readFile: (file: string) => fs.readFile(file),
    listFiles: (dir: string) => fs.readdir(dir), remove: (file: string) => fs.rm(file, { force: true, recursive: true }), run,
    syncIn: sync, syncOut: sync };
  const prepare = (overrides: Partial<Parameters<typeof prepareSandboxManagedRuntime>[0]> = {}) => prepareSandboxManagedRuntime({ spec: { provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 30000, apiKey: null, transport: "sandbox" },
    adapterKey: "test", client, workspaceLocalDir: f.root, workspaceCheckpoint: true,
    runtimeSpan: async (name, work) => {
      if (mutateDuringPack && name === "pack") await fs.writeFile(path.join(f.root, "unchanged"), "concurrent change");
      if (name === "seed.verify") {
        verificationCalls++;
        const result = await work();
        if (failVerification) throw Object.assign(new Error("verification disk full"), { code: "ENOSPC" });
        return result;
      }
      return work();
    },
    workspaceSeedCacheDirectory: cache, workspaceDurableSeed: { workspaceArchivePath: path.join(f.temp, "run-seed.tar") }, ...overrides });
  const first = await prepare(); await first.restoreWorkspace(); expect(payloadBytes).toBe(0);
  const generation = (await fs.readdir(cache))[0]!;
  await fs.writeFile(path.join(cache, generation, "workspace.tar"), "corrupt cache");
  const second = await prepare();
  await fs.writeFile(path.join(remote, "new"), "changed"); await fs.unlink(path.join(remote, "deleted"));
  const outside = path.join(f.temp, "outside"); await fs.writeFile(outside, "private");
  await fs.symlink(outside, path.join(remote, "absolute-link"));
  await fs.symlink("../outside", path.join(remote, "escaping-link"));
  await fs.symlink("new", path.join(remote, "safe-link"));
  await second.restoreWorkspace(); expect(payloadBytes).toBe(7);
  expect(await fs.readFile(path.join(f.root, "new"), "utf8")).toBe("changed");
  expect(await fs.readlink(path.join(f.root, "safe-link"))).toBe("new");
  for (const name of ["absolute-link", "escaping-link"]) {
    await expect(fs.lstat(path.join(f.root, name))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await fs.readFile(outside, "utf8")).toBe("private");
  await expect(fs.stat(path.join(f.root, "deleted"))).rejects.toMatchObject({ code: "ENOENT" });
  supportsCheckpoint = false;
  const third = await prepare(); await fs.writeFile(path.join(remote, "new"), "fallback");
  await third.restoreWorkspace(); expect(await fs.readFile(path.join(f.root, "new"), "utf8")).toBe("fallback");
  const existingGenerations = await fs.readdir(cache);
  mutateDuringPack = true;
  const raced = await prepare();
  expect(await fs.readdir(cache)).toEqual(existingGenerations);
  expect((await fs.stat(path.join(f.temp, "run-seed.tar"))).size).toBeGreaterThan(0);
  await raced.cleanupWorkspaceSnapshot();
  mutateDuringPack = false; failVerification = true;
  await fs.writeFile(path.join(f.root, "new"), "verification recovery");
  const verificationFailed = await prepare();
  expect(await fs.readdir(cache)).toEqual(existingGenerations);
  const failedSnapshot = verificationFailed.workspaceSyncSnapshot!;
  await fs.writeFile(path.join(f.root, "new"), "later host bytes");
  await fs.rm(remote, { recursive: true, force: true });
  const verificationRecovery = await prepare({ workspaceInboundMode: "durable_seed", workspaceBaseline: failedSnapshot.baseline,
    workspaceGitSnapshot: failedSnapshot.gitSnapshot, workspaceRepositories: failedSnapshot.repositories });
  expect(await fs.readFile(path.join(remote, "new"), "utf8")).toBe("verification recovery");
  await verificationRecovery.cleanupWorkspaceSnapshot();
  failVerification = false;
  mutateDuringPack = false;
  for (let count = (await fs.readdir(cache)).length; count < 16; count++) {
    await fs.mkdir(path.join(cache, `.pending-retained-${count}`));
  }
  const saturated = await fs.readdir(cache);
  await fs.writeFile(path.join(f.root, "new"), "quota recovery");
  const verificationCallsBeforeSaturation = verificationCalls;
  const uncached = await prepare();
  expect(verificationCalls).toBe(verificationCallsBeforeSaturation);
  expect(await fs.readdir(cache)).toEqual(saturated);
  const snapshot = uncached.workspaceSyncSnapshot!;
  await fs.writeFile(path.join(f.root, "new"), "later host edit");
  await fs.rm(remote, { recursive: true, force: true });
  const recovered = await prepare({ workspaceInboundMode: "durable_seed", workspaceBaseline: snapshot.baseline,
    workspaceGitSnapshot: snapshot.gitSnapshot, workspaceRepositories: snapshot.repositories });
  expect(await fs.readFile(path.join(remote, "new"), "utf8")).toBe("quota recovery");
  expect(await fs.readFile(path.join(f.root, "new"), "utf8")).toBe("later host edit");
  expect(await fs.readdir(cache)).toEqual(saturated);
  await recovered.cleanupWorkspaceSnapshot();
}, 30000);

async function exportFailureFixture(failure: "low_disk" | "full_root" | "full_special" | "digest" | "path" | "symlink") {
  const { prepareSandboxManagedRuntime } = await import("./sandbox-managed-runtime.js");
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture();
  await disposeDirectorySnapshot(f.baseline);
  const remote = path.join(f.temp, "remote"), outside = path.join(f.temp, "outside");
  await fs.writeFile(outside, "private");
  const metrics: unknown[] = [];
  const counts = { captures: 0, fullExports: 0, capacityFailures: 0 };
  const run = async (command: string) => {
    const capture = command.includes("checkpoint.mjs");
    if (capture) counts.captures++;
    try { await execute("sh", ["-c", command]); }
    catch (error) {
      if (capture && ["low_disk", "full_root", "full_special"].includes(failure)) {
        expect(String(error)).toContain("Workspace checkpoint storage is below its free-space reserve");
        counts.capacityFailures++;
        await expect(fs.stat(path.join(f.root, "new"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      throw error;
    }
  };
  const sync = async (operations: import("./sandbox-managed-runtime.js").SandboxSyncOperation[]) => {
    for (const operation of operations) {
      for (const file of operation.files) {
        if (file.sourcePath === remote) {
          counts.fullExports++;
          if (failure === "full_root") {
            await fs.rm(file.targetPath, { recursive: true, force: true });
            await fs.symlink(remote, file.targetPath);
            continue;
          }
        }
        await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
        await fs.cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true,
          filter: source => !file.exclude?.some(exclude => path.relative(file.sourcePath, source) === exclude) });
        if (file.sourcePath === remote && failure === "full_special") await execute("mkfifo", [path.join(file.targetPath, "unsafe-pipe")]);
        if (["low_disk", "full_root", "full_special"].includes(failure) && file.targetPath.endsWith("/checkpoint.mjs")) {
          const script = await fs.readFile(file.targetPath, "utf8");
          await fs.writeFile(file.targetPath, script.replace("const __name", "fs.statfs = async () => ({ bavail: 128n * 1024n, bsize: 1024n });\nconst __name"));
        }
        if (file.sourcePath.endsWith("/output")) {
          if (failure === "digest") await fs.writeFile(path.join(file.targetPath, "payload", "new"), "forged");
          else if (failure === "path" || failure === "symlink") {
            const manifest = new DatabaseSync(path.join(file.targetPath, "manifest.sqlite"));
            try {
              manifest.prepare("INSERT INTO records VALUES('baseline',?,?)").run(
                failure === "path" ? "../escape" : "escape",
                JSON.stringify({ kind: "symlink", target: outside }),
              );
            } finally { manifest.close(); }
          }
        }
      }
      for (const command of operation.postUploadCommands ?? []) await run(command.command);
    }
    return { operations: operations.map(op => ({ operationId: op.operationId, filesTransferred: 0, bytesTransferred: 0 })) };
  };
  const client = { makeDir: (dir: string) => fs.mkdir(dir, { recursive: true }).then(() => {}),
    writeFile: (file: string, data: ArrayBuffer) => fs.writeFile(file, Buffer.from(data)), readFile: (file: string) => fs.readFile(file),
    listFiles: (dir: string) => fs.readdir(dir), remove: (file: string) => fs.rm(file, { force: true, recursive: true }), run,
    syncIn: sync, syncOut: sync };
  const prepare = (overrides: Partial<Parameters<typeof prepareSandboxManagedRuntime>[0]> = {}) => prepareSandboxManagedRuntime({
    spec: { provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 30000, apiKey: null, transport: "sandbox" },
    adapterKey: "test", client, workspaceLocalDir: f.root, workspaceCheckpoint: true,
    onWorkspaceCheckpoint: async metric => { metrics.push(metric); }, ...overrides,
  });
  const prepared = await prepare();
  await fs.writeFile(path.join(remote, "new"), "tiny export");
  await fs.unlink(path.join(remote, "deleted"));
  return { ...f, remote, outside, prepared, prepare, metrics, counts };
}

it.each([false, true])("falls back once to a full tiny export below the sparse disk reserve (recovery=%s)", async recovery => {
  const f = await exportFailureFixture("low_disk");
  const snapshot = f.prepared.workspaceSyncSnapshot!;
  const runtime = recovery ? await f.prepare({ workspaceInboundMode: "adopt_remote", workspaceBaseline: snapshot.baseline,
    workspaceGitSnapshot: snapshot.gitSnapshot, workspaceRepositories: snapshot.repositories }) : f.prepared;
  await fs.writeFile(path.join(f.root, "host-only"), "concurrent host edit");
  await fs.symlink(f.outside, path.join(f.remote, "unsafe-link"));
  await fs.symlink("../outside", path.join(f.remote, "escaping-link"));
  await fs.symlink("new", path.join(f.remote, "safe-link"));
  await runtime.restoreWorkspace();
  expect(f.counts).toEqual({ captures: 1, fullExports: 1, capacityFailures: 1 });
  expect(f.metrics).toEqual([{ mode: "full", scannedEntries: null, changedFiles: null, payloadBytes: null }]);
  expect(await fs.readFile(path.join(f.root, "new"), "utf8")).toBe("tiny export");
  expect(await fs.readFile(path.join(f.root, "host-only"), "utf8")).toBe("concurrent host edit");
  await expect(fs.stat(path.join(f.root, "deleted"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(f.outside, "utf8")).toBe("private");
  for (const name of ["unsafe-link", "escaping-link"]) {
    await expect(fs.lstat(path.join(f.root, name))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await fs.readlink(path.join(f.root, "safe-link"))).toBe("new");
  await runtime.cleanupWorkspaceSnapshot();
  if (recovery) await f.prepared.cleanupWorkspaceSnapshot();
}, 30000);

it.each(["digest", "path", "symlink"] as const)("never falls back after returned sparse %s validation fails", async attack => {
  const f = await exportFailureFixture(attack);
  await expect(f.prepared.restoreWorkspace()).rejects.toThrow();
  expect(f.counts.fullExports).toBe(0);
  expect(f.metrics).toEqual([]);
  await expect(fs.stat(path.join(f.root, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(f.root, "deleted"), "utf8")).toBe("delete me");
  expect(await fs.readFile(f.outside, "utf8")).toBe("private");
  await f.prepared.cleanupWorkspaceSnapshot();
}, 30000);

it.each(["full_root", "full_special"] as const)("rejects unsafe %s data before host writes after capacity fallback", async attack => {
  const f = await exportFailureFixture(attack);
  await expect(f.prepared.restoreWorkspace()).rejects.toThrow("Unsafe workspace export directory");
  expect(f.counts).toEqual({ captures: 1, fullExports: 1, capacityFailures: 1 });
  await expect(fs.stat(path.join(f.root, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(f.root, "deleted"), "utf8")).toBe("delete me");
  expect(await fs.readFile(f.outside, "utf8")).toBe("private");
  await f.prepared.cleanupWorkspaceSnapshot();
}, 30000);
