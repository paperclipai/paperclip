// Provider staging only: setup, cleanup and model latency are measured separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalNativeRuntimeContextDigest } from "../dist/contracts/runtime-context.js";
import { materializeNativeRuntimeSkills, releaseMaterializedNativeRuntimeSkills, verifyMaterializedNativeRuntimeSkills } from "../dist/drivers/runtime-context-materializer.js";

const argument = name => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const fileCount = Number(argument("--files") ?? 128);
const repetitions = Number(argument("--repetitions") ?? 3);
assert.ok(Number.isSafeInteger(fileCount) && fileCount >= 4 && fileCount <= 9000);
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const hash = value => createHash("sha256").update(value).digest("hex");
const temporaryRoot = argument("--temp-root") ?? tmpdir();
await mkdir(temporaryRoot, { recursive: true });
const root = await mkdtemp(join(temporaryRoot, "shared-layout-benchmark-"));
const homes = [];
async function asset(contents) {
  const files = Object.entries(contents).sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, content]) => ({ path, sha256: hash(content), mode: 0o444, size: Buffer.byteLength(content) }));
  const digest = hash(JSON.stringify(files));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const manifest = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest, fileCount: files.length, totalBytes, files })}\n`;
  const rootPath = join(root, "assets", "bundles", digest);
  await mkdir(rootPath, { recursive: true });
  for (const file of files) {
    await mkdir(dirname(join(rootPath, file.path)), { recursive: true });
    const target = join(rootPath, file.path);
    const existing = await readFile(target).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (existing !== null) assert.deepEqual(existing, Buffer.from(contents[file.path]));
    else {
      await writeFile(target, contents[file.path], { flag: "wx" });
      await chmod(target, file.mode);
    }
  }
  await mkdir(join(root, "assets", "manifests"), { recursive: true });
  await writeFile(join(root, "assets", "manifests", `${digest}.json`), manifest);
  return { schema: "paperclip.runtime-asset.v1", digest, manifestDigest: hash(manifest), rootPath, fileCount: files.length, totalBytes };
}
async function inventory(directory) {
  const result = { files: 0, bytes: 0, payloadCopies: 0 };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await inventory(path);
      for (const key of Object.keys(result)) result[key] += child[key];
    } else {
      assert.ok(entry.isFile());
      result.files++;
      result.bytes += (await lstat(path)).size;
      if (entry.name === "payload-0.txt") result.payloadCopies++;
    }
  }
  return result;
}
async function writable(directory) {
  const info = await lstat(directory);
  await chmod(directory, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const entry of await readdir(directory)) await writable(join(directory, entry));
}
const samples = [];
const started = performance.now();
try {
  const contents = Object.fromEntries(Array.from({ length: fileCount }, (_, index) => [`references/payload-${index}.txt`, `${index}:`.padEnd(16_384, "x")]));
  for (let index = 0; index < 4; index++) contents[`skills/entry-${index}/SKILL.md`] = `---\nname: entry-${index}\ndescription: Staging diagnostic\n---\nRead ../../references/payload-0.txt\n`;
  const repository = await asset(contents);
  const instructions = { entryPath: "AGENTS.md", bundle: await asset({ "AGENTS.md": "Diagnostic" }) };
  const setupMs = performance.now() - started;
  for (const selected of [2, 4]) {
    const contexts = {};
    for (const layout of ["portable", "shared"]) {
      const skills = [];
      for (let index = 0; index < selected; index++) {
        const entryPath = `skills/entry-${index}/SKILL.md`;
        const key = `entry-${index}`;
        if (layout === "portable") {
          const projection = { "SKILL.md": contents[entryPath], ...Object.fromEntries(Object.entries(contents).map(([path, text]) => [`.paperclip-repository/${path}`, text])) };
          skills.push({ key, runtimeName: key, versionId: key, bundle: await asset(projection) });
        } else {
          const bundle = await asset({ "SKILL.md": `[Original](../../repositories/${repository.digest}/${entryPath})\n` });
          skills.push({ key, runtimeName: key, versionId: key, bundle, repository: { bundle: repository, entryPath, policyPath: null } });
        }
      }
      const context = { prompt: { revision: "diagnostic", text: "diagnostic", digest: hash("diagnostic") }, instructions, skills,
        mcp: { assignmentSetId: "none", digest: hash("none"), bindingId: null } };
      contexts[layout] = { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    }
    for (let repeat = 0; repeat < repetitions; repeat++) {
      // Alternate ordering to reduce cache/order bias. Both layouts stage fresh homes.
      for (const layout of repeat % 2 ? ["shared", "portable"] : ["portable", "shared"]) {
        const home = join(root, `home-${selected}-${repeat}-${layout}`); homes.push(home);
        const begin = performance.now();
        await materializeNativeRuntimeSkills(contexts[layout], join(home, "skills"));
        const stagingMs = performance.now() - begin;
        const disk = await inventory(home);
        assert.equal(disk.payloadCopies, layout === "shared" ? 1 : selected);
        let warmVerificationMs = null;
        if (layout === "shared") {
          const begin = performance.now();
          await verifyMaterializedNativeRuntimeSkills(contexts[layout], join(home, "skills"));
          warmVerificationMs = performance.now() - begin;
        }
        const sample = { selected, repeat, layout, stagingMs, warmVerificationMs, ...disk };
        samples.push(sample); console.error(JSON.stringify(sample));
        const cleanup = performance.now();
        await releaseMaterializedNativeRuntimeSkills(join(home, "skills"));
        sample.cleanupMs = performance.now() - cleanup;
      }
    }
    // The shared source remains fully verified even when an attacker restores mtime.
    const target = join(repository.rootPath, "references/payload-0.txt");
    const before = await lstat(target), original = await readFile(target);
    await chmod(target, 0o600); await writeFile(target, Buffer.alloc(original.length, 121)); await utimes(target, before.atime, before.mtime);
    const badHome = join(root, `changed-${selected}`); homes.push(badHome);
    await assert.rejects(materializeNativeRuntimeSkills(contexts.shared, join(badHome, "skills")), /integrity/);
    assert.equal(await lstat(join(badHome, "skills")).catch(() => null), null);
    await writeFile(target, original); await chmod(target, 0o444);
  }
  console.log(JSON.stringify({ schema: "paperclip.shared-skill-layout-benchmark.v1", sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    benchmarkScriptSha256: hash(await readFile(new URL(import.meta.url))), platform: process.platform, arch: process.arch, node: process.version, fileCount, repetitions, repository: { files: repository.fileCount, bytes: repository.totalBytes, digest: repository.digest }, fixtureSetupMs: setupMs,
    scope: "Provider staging and shared warm byte verification; excludes DB preparation, model latency, and OS cache eviction. Portable historical path checks are unchanged.",
    restoredMtimeMutationRejected: true, samples }, null, 2));
} finally {
  for (const home of homes) await releaseMaterializedNativeRuntimeSkills(join(home, "skills"));
  await writable(root); await rm(root, { recursive: true, force: true });
}
