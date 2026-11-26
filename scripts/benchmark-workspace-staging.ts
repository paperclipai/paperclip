import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { prepareSandboxManagedRuntime, type SandboxSyncOperation } from "../packages/adapter-utils/src/sandbox-managed-runtime.js";
import { captureDirectorySnapshot, directorySnapshotSha256, disposeDirectorySnapshot } from "../packages/adapter-utils/src/workspace-restore-merge.js";

const execute = promisify(execFile);
const argument = (name: string, fallback: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const files = Number(argument("files", "10000"));
const samples = Number(argument("samples", "5"));
const transferDelayMs = Number(argument("transfer-delay-ms", "0"));
const baselineRef = argument("baseline-ref", "origin/master");
assert.ok(Number.isSafeInteger(files) && files > 0 && files <= 100000);
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 10);
assert.ok(Number.isSafeInteger(transferDelayMs) && transferDelayMs >= 0 && transferDelayMs <= 10000);
const repository = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-staging-benchmark-"));
const previousHome = process.env.PAPERCLIP_HOME;
process.env.PAPERCLIP_HOME = path.join(root, "home");
const moduleDirectory = path.join(repository, "packages/adapter-utils/src");
const token = randomUUID();
const baselineModule = path.join(moduleDirectory, `sandbox-managed-runtime.benchmark-${token}.ts`);
const baselineCache = path.join(moduleDirectory, `workspace-seed-cache.benchmark-${token}.ts`);
try {
  const revision = (await execute("git", ["rev-parse", baselineRef], { cwd: repository })).stdout.trim();
  const source = async (file: string) => (await execute("git", ["show", `${revision}:packages/adapter-utils/src/${file}.ts`],
    { cwd: repository, maxBuffer: 1024 * 1024 })).stdout;
  await fs.writeFile(baselineCache, await source("workspace-seed-cache"));
  await fs.writeFile(baselineModule, (await source("sandbox-managed-runtime"))
    .replace('"./workspace-seed-cache.js"', `"./${path.basename(baselineCache)}"`));
  const baseline = (await import(pathToFileURL(baselineModule).href)).prepareSandboxManagedRuntime as typeof prepareSandboxManagedRuntime;
  const host = path.join(root, "host"); await fs.mkdir(host);
  const git = (...args: string[]) => execute("git", ["-C", host, ...args]);
  await git("init", "-b", "main");
  for (let start = 0; start < files; start += 32) {
    await Promise.all(Array.from({ length: Math.min(32, files - start) }, async (_, offset) => {
      const index = start + offset;
      const dir = path.join(host, `directory-${Math.floor(index / 100)}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `file-${index}.txt`), `${index}\n${"Synthetic workspace data\n".repeat(160)}`);
    }));
  }
  await fs.writeFile(path.join(host, ".gitignore"), "ignored.txt\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  await fs.writeFile(path.join(host, "directory-0", "file-0.txt"), "uncommitted bytes\n");
  await fs.unlink(path.join(host, "directory-0", "file-1.txt"));
  await fs.writeFile(path.join(host, "untracked.txt"), "new bytes\n");
  await fs.writeFile(path.join(host, "ignored.txt"), "must stay private\n");
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    for (const mode of sample % 2 ? ["after", "before"] : ["before", "after"]) {
      const prepare = mode === "before" ? baseline : prepareSandboxManagedRuntime;
      const location = path.join(root, `${mode}-${sample}`); await fs.mkdir(location);
      const remote = path.join(location, "remote");
      let bytes = 0;
      const phases: Record<string, number> = {};
      const run = async (command: string) => { await execute("sh", ["-c", command]); };
      const sync = async (operations: SandboxSyncOperation[]) => {
        if (transferDelayMs) await delay(transferDelayMs);
        for (const operation of operations) {
          for (const file of operation.files) {
            bytes += (await fs.stat(file.sourcePath)).size;
            await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
            await fs.copyFile(file.sourcePath, file.targetPath);
          }
          for (const command of operation.postUploadCommands ?? []) await run(command.command);
        }
        return { operations: [] };
      };
      const start = performance.now();
      const runtime = await prepare({
        spec: { provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 30000, apiKey: null, transport: "sandbox" },
        adapterKey: "benchmark", workspaceLocalDir: host,
        workspaceSeedCacheDirectory: path.join(location, "cache"),
        workspaceDurableSeed: { workspaceArchivePath: path.join(location, "workspace.tar"), gitArchivePath: path.join(location, "git.tar") },
        runtimeSpan: async (name, work) => {
          const phaseStart = performance.now();
          try { return await work(); }
          finally { phases[name] = (phases[name] ?? 0) + performance.now() - phaseStart; }
        },
        client: {
          makeDir: dir => fs.mkdir(dir, { recursive: true }).then(() => {}), run,
          writeFile: (file, data) => fs.writeFile(file, Buffer.from(data)), readFile: file => fs.readFile(file),
          listFiles: dir => fs.readdir(dir), remove: file => fs.rm(file, { force: true, recursive: true }), syncIn: sync,
        },
      });
      const wallMs = performance.now() - start;
      const snapshot = runtime.workspaceSyncSnapshot!;
      const actual = await captureDirectorySnapshot(remote, { exclude: snapshot.baseline.exclude, ignoredPaths: snapshot.baseline.ignoredPaths, diskBacked: true });
      try { assert.equal(directorySnapshotSha256(actual), directorySnapshotSha256(snapshot.baseline)); }
      finally { await disposeDirectorySnapshot(actual); await runtime.cleanupWorkspaceSnapshot(); }
      assert.equal((await execute("git", ["-C", remote, "rev-parse", "HEAD"])).stdout, (await git("rev-parse", "HEAD")).stdout);
      await assert.rejects(fs.stat(path.join(remote, "ignored.txt")), { code: "ENOENT" });
      assert.equal((await fs.readdir(path.join(location, "cache"))).length, 1);
      results.push({ mode, sample, wallMs, bytes, phases });
      await fs.rm(location, { recursive: true, force: true });
    }
  }
  const summary = Object.fromEntries(["before", "after"].map(mode => {
    const timings = results.filter(result => result.mode === mode).map(result => result.wallMs).sort((a, b) => a - b);
    return [mode, { medianMs: timings[Math.floor(timings.length / 2)], minMs: timings[0], maxMs: timings.at(-1) }];
  }));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, baselineRef: revision,
    files, samples, transferDelayMs, transport: "local copy and shell extraction; optional controlled transfer delay", summary, results }, null, 2));
} finally {
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousHome;
  await Promise.all([root, baselineModule, baselineCache].map(file => fs.rm(file, { force: true, recursive: true })));
}
