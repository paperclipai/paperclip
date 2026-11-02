import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createServer, get, Agent } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const filename = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(filename), "../..");
const arg = (name, fallback) => {
  const position = process.argv.indexOf(`--${name}`);
  return position < 0 ? fallback : process.argv[position + 1];
};
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};

if (process.argv.includes("--worker")) {
  const { publishNativeHarnessBackup } = await import(pathToFileURL(arg("module")));
  let publishing = false;
  const server = createServer((_request, response) => {
    response.setHeader("x-publication-active", publishing ? "1" : "0");
    response.end("ok");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.send({ kind: "ready", port: server.address().port });
  process.on("message", async message => {
    if (message.kind === "close") {
      server.closeAllConnections();
      server.close(() => process.disconnect());
      return;
    }
    if (message.kind !== "publish") return;
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    await delay(20);
    const cpu = process.cpuUsage();
    const started = performance.now();
    publishing = true;
    try {
      await publishNativeHarnessBackup({
        db: {}, companyId: "benchmark", scopeDigest: "fixture",
        backupRoot: message.backupRoot, pendingRoot: message.pendingRoot,
        stamp: async () => {},
      });
      const durationMs = performance.now() - started;
      const cpuUsed = process.cpuUsage(cpu);
      publishing = false;
      await delay(20);
      histogram.disable();
      assert.equal(await fs.readFile(path.join(message.backupRoot, "current/manifest.json"), "utf8"), "replacement");
      assert.deepEqual((await fs.readdir(message.backupRoot)).sort(), ["current"]);
      assert.equal(await fs.readFile(path.join(message.liveRoot, "untouched.txt"), "utf8"), "live");
      assert.equal((await fs.stat(message.liveRoot)).mode & 0o777, 0o555);
      process.send({ kind: "result", durationMs, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
        eventLoopMaxMs: histogram.max / 1e6, workCompleted: true });
    } catch (error) {
      publishing = false;
      process.send({ kind: "error", message: error.stack });
    }
  });
} else {
  const baselineRef = arg("baseline-ref");
  assert(baselineRef, "--baseline-ref is required");
  const pairs = Number(arg("pairs", "3"));
  const directories = Number(arg("directories", "100"));
  const filesPerDirectory = Number(arg("files-per-directory", "100"));
  const intervalMs = Number(arg("interval-ms", "5"));
  for (const value of [pairs, directories, filesPerDirectory, intervalMs]) assert(Number.isSafeInteger(value) && value > 0);
  const evidence = await fs.mkdtemp(path.join(tmpdir(), "native-backup-publication-proof-"));
  const { build } = await import("esbuild");
  const buildVariant = async variant => {
    const outfile = path.join(evidence, `${variant}.mjs`);
    await build({ absWorkingDir: checkout, entryPoints: ["server/src/services/native-runtime/native-harness-backup-publication.ts"],
      outfile, bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: true,
      alias: { "@paperclipai/db/work-signals": path.join(checkout, "packages/db/src/work-signals.ts") },
      plugins: variant === "baseline" ? [{ name: "pinned-source", setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, args => {
          const relative = path.relative(checkout, args.path);
          if (relative.startsWith("..") || relative.includes("node_modules")) return;
          return { contents: execFileSync("git", ["show", `${baselineRef}:${relative}`], { cwd: checkout, encoding: "utf8" }),
            loader: "ts", resolveDir: path.dirname(args.path) };
        });
      } }] : [],
    });
    return outfile;
  };
  const modules = { baseline: await buildVariant("baseline"), treatment: await buildVariant("treatment") };
  const makeFixture = async label => {
    const root = await fs.mkdtemp(path.join(tmpdir(), `backup-publication-${label}-`));
    const backupRoot = path.join(root, "backups");
    const liveRoot = path.join(root, "live");
    const pendingRoot = path.join(backupRoot, "pending");
    await fs.mkdir(liveRoot);
    await fs.writeFile(path.join(liveRoot, "untouched.txt"), "live");
    await fs.chmod(liveRoot, 0o555);
    for (const version of ["current", "previous"]) {
      const versionRoot = path.join(backupRoot, version);
      for (let directory = 0; directory < directories; directory++) {
        const target = path.join(versionRoot, `skill-${directory}`);
        await fs.mkdir(target, { recursive: true });
        for (let file = 0; file < filesPerDirectory; file++) {
          await fs.writeFile(path.join(target, `file-${file}.txt`), "retired instructions\n".repeat(4), { mode: 0o444 });
        }
        await fs.chmod(target, 0o555);
      }
      await fs.symlink(liveRoot, path.join(versionRoot, "outside"));
      await fs.chmod(versionRoot, 0o555);
    }
    await fs.mkdir(pendingRoot);
    await fs.writeFile(path.join(pendingRoot, "manifest.json"), "replacement");
    return { root, backupRoot, liveRoot, pendingRoot };
  };
  const run = async variant => {
    const fixture = await makeFixture(variant);
    const worker = fork(filename, ["--worker", "--module", modules[variant]], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const exited = new Promise(resolve => worker.once("exit", resolve));
    const nextMessage = kind => new Promise((resolve, reject) => {
      const onMessage = message => {
        if (message.kind !== kind && message.kind !== "error") return;
        worker.off("message", onMessage); worker.off("exit", onExit);
        if (message.kind === "error") reject(new Error(message.message)); else resolve(message);
      };
      const onExit = code => reject(new Error(`worker exited before ${kind}: ${code}`));
      worker.on("message", onMessage); worker.once("exit", onExit);
    });
    const { port } = await nextMessage("ready");
    const agent = new Agent({ keepAlive: true, maxSockets: 512 });
    const requests = [];
    let sent = 0;
    const epoch = performance.now();
    const dispatch = intended => {
      const dispatched = performance.now();
      requests.push(new Promise(resolve => {
        const request = get({ hostname: "127.0.0.1", port, agent }, response => {
          response.resume();
          response.on("end", () => resolve({ intended, dispatchLateMs: dispatched - intended,
            latencyMs: performance.now() - intended, active: response.headers["x-publication-active"] === "1", error: false }));
        });
        request.setTimeout(10_000, () => request.destroy(new Error("request timeout")));
        request.on("error", () => resolve({ intended, dispatchLateMs: dispatched - intended,
          latencyMs: performance.now() - intended, active: false, error: true }));
      }));
    };
    let ticker;
    const pump = () => {
      const now = performance.now();
      while (epoch + (sent + 1) * intervalMs <= now) dispatch(epoch + (++sent * intervalMs));
      ticker = setTimeout(pump, Math.max(0, epoch + (sent + 1) * intervalMs - performance.now()));
    };
    ticker = setTimeout(pump, intervalMs);
    try {
      await delay(250);
      const pending = nextMessage("result");
      const start = performance.now();
      worker.send({ kind: "publish", ...fixture });
      const publication = await pending;
      const end = performance.now();
      await delay(250);
      clearTimeout(ticker);
      const completed = await Promise.all(requests);
      const during = completed.filter(request => request.intended >= start && request.intended <= end);
      assert(during.length > 0);
      const result = { variant, ...publication, sent, completed: completed.length,
        errors: completed.filter(request => request.error).length, duringRequests: during.length,
        requestsServedDuringPublication: completed.filter(request => request.active).length,
        foregroundP95Ms: percentile(during.map(request => request.latencyMs), 0.95),
        foregroundMaxMs: Math.max(...during.map(request => request.latencyMs)),
        generatorMaxLateMs: Math.max(...completed.map(request => request.dispatchLateMs)) };
      console.log(JSON.stringify(result));
      return result;
    } finally {
      clearTimeout(ticker); agent.destroy();
      if (worker.connected) worker.send({ kind: "close" });
      await exited;
      await fs.chmod(fixture.liveRoot, 0o700);
      if ((await fs.readdir(fixture.backupRoot)).join() === "current") await fs.rm(fixture.root, { recursive: true });
    }
  };
  const measurements = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const variant of pair % 2 ? ["treatment", "baseline"] : ["baseline", "treatment"]) measurements.push(await run(variant));
  }
  const report = { baselineRef: execFileSync("git", ["rev-parse", baselineRef], { cwd: checkout, encoding: "utf8" }).trim(),
    treatmentHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
    treatmentDiff: execFileSync("git", ["diff", "HEAD", "--", "server/src/services/native-runtime/native-harness-backup-cleanup.ts", "server/src/services/native-runtime/native-harness-backup-publication.ts"], { cwd: checkout, encoding: "utf8" }),
    node: process.version, platform: `${process.platform}/${process.arch}`, pairs, directories, filesPerDirectory,
    filesRemovedPerPublication: 2 * directories * filesPerDirectory, intervalMs, evidence, measurements };
  const output = arg("output", path.join(evidence, "result.json"));
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Evidence: ${output}`);
}
