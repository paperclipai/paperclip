import assert from "node:assert/strict";
import { execFile as execute } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { materializeManagedProjectWorkspace } from "../server/src/services/managed-repository-checkout.js";

const execFile = promisify(execute);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "repository-cache-benchmark-"));
const previousHome = process.env.PAPERCLIP_HOME;
const previousTrace = process.env.GIT_TRACE_PACKFILE;
process.env.PAPERCLIP_HOME = path.join(root, "home");
const source = path.join(root, "source");
const cache = path.join(root, "cache/company");
const samples = Number(process.argv.find(arg => arg.startsWith("--samples="))?.split("=")[1] ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 10);
try {
  await fs.mkdir(source);
  const git = async (...args: string[]) => (await execFile("git", ["-C", source, ...args])).stdout;
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.test");
  for (let batch = 0; batch < 4; batch++) {
    await Promise.all(Array.from({ length: 32 }, (_, index) => fs.writeFile(path.join(source, `file-${batch * 32 + index}.bin`), randomBytes(256 * 1024))));
    await git("add", "."); await git("commit", "-m", `History ${batch}`);
  }
  const repoUrl = pathToFileURL(source).href;
  const prepare = (target: string, useCache: boolean) => materializeManagedProjectWorkspace(target,
    { repoUrl, ...(useCache ? { objectCacheCompanyDirectory: cache } : {}) });
  const warmStart = performance.now(); await prepare(path.join(root, "prime"), true);
  const cachePrimeMs = performance.now() - warmStart;
  const expected = await git("rev-parse", "HEAD");
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    for (const mode of sample % 2 ? ["after", "before"] : ["before", "after"]) {
      const target = path.join(root, `${mode}-${sample}`);
      const trace = path.join(root, `${mode}-${sample}.pack`);
      process.env.GIT_TRACE_PACKFILE = trace;
      const start = performance.now(); await prepare(target, mode === "after");
      const wallMs = performance.now() - start;
      const receivedPackBytes = await fs.stat(trace).then(stat => stat.size, () => 0);
      delete process.env.GIT_TRACE_PACKFILE;
      assert.equal((await execFile("git", ["-C", target, "rev-parse", "HEAD"])).stdout, expected);
      await assert.rejects(fs.stat(path.join(target, ".git/objects/info/alternates")), { code: "ENOENT" });
      await execFile("git", ["-C", target, "fsck", "--full"]);
      results.push({ mode, sample, wallMs, receivedPackBytes });
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  const summary = Object.fromEntries(["before", "after"].map(mode => {
    const timings = results.filter(result => result.mode === mode).map(result => result.wallMs).sort((a, b) => a - b);
    return [mode, { medianMs: timings[Math.floor(timings.length / 2)], minMs: timings[0], maxMs: timings.at(-1) }];
  }));
  console.log(JSON.stringify({ node: process.version, platform: process.platform, transport: "local file:// Git upload-pack; no injected latency",
    files: 128, contentBytes: 32 * 1024 * 1024, commits: 4, samples, cachePrimeMs, summary, results }, null, 2));
} finally {
  if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
  if (previousTrace === undefined) delete process.env.GIT_TRACE_PACKFILE; else process.env.GIT_TRACE_PACKFILE = previousTrace;
  await fs.rm(root, { recursive: true, force: true });
}
