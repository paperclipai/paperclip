/** Compare native asset filesystem work in isolation; no database or provider is started. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as current from "../src/services/native-runtime/runtime-asset-files.js";
import { verifyFileManifest } from "../src/services/file-manifest-cache.js";

const argument = (name: string) => process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const samples = Number(argument("--samples") ?? 3);
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 10);
const baselineRef = argument("--baseline-ref");
assert.ok(baselineRef, "Supply --baseline-ref=<commit> from before native asset file extraction");
const baselineRevision = execFileSync("git", ["rev-parse", baselineRef], { encoding: "utf8" }).trim();
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-materialize-bench-"));
try {
  const original = execFileSync("git", ["show", `${baselineRevision}:server/src/services/native-runtime/runtime-context.ts`], { encoding: "utf8" });
  // Load the exact original filesystem functions without the unrelated service graph.
  const functionStart = original.indexOf("const safeRelativePath =");
  const functionEnd = original.indexOf("async function verifyMaterializedAsset(");
  const writeStart = original.indexOf("for (const file of sorted) {");
  const writeEnd = original.indexOf("await fs.mkdir(path.dirname(rootPath)");
  assert.ok(functionStart >= 0 && functionEnd > functionStart && writeStart >= 0 && writeEnd > writeStart,
    "The baseline must contain the code from before native asset file extraction");
  const functions = original.slice(functionStart, functionEnd);
  const writing = original.slice(writeStart, writeEnd);
  assert.ok(functions.includes("async function collectDirectoryFiles"));
  assert.ok(writing.includes("fs.chmod"));
  const baselinePath = path.join(temporary, "baseline.mts");
  await fs.writeFile(baselinePath, `import fs from 'node:fs/promises'; import path from 'node:path';
    const MAX_ASSET_FILES = 10000, MAX_ASSET_BYTES = 64 * 1024 * 1024;
    type AssetFile = { path: string; content: Buffer; mode: number };
    ${functions}
    async function writeAssetFiles(stagingRoot: string, sorted: AssetFile[]) { ${writing} }
    export { collectDirectoryFiles, writeAssetFiles, makeDirectoriesReadOnly };`);
  const baseline = await import(pathToFileURL(baselinePath).href) as typeof current;
  const suppliedSource = argument("--source");
  const source = suppliedSource ?? path.join(temporary, "source");
  const content = Buffer.alloc(16_384, 120);
  for (let i = 0; !suppliedSource && i < 671; i++) {
    const target = path.join(source, `references/${i % 16}/file-${i}.md`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const results: Record<string, { readMs: number; writeMs: number; verifyMs: number; totalMs: number }[]> = { baseline: [], current: [] };
  let fileCount = 0;
  let totalBytes = 0;
  let expectedDigest: string | undefined;
  for (let i = 0; i < samples; i++) {
    for (const [label, implementation] of i % 2 ? [["current", current], ["baseline", baseline]] as const
      : [["baseline", baseline], ["current", current]] as const) {
      const destination = path.join(temporary, `${label}-${i}`);
      const started = performance.now();
      const files = await implementation.collectDirectoryFiles(source);
      const readMs = performance.now() - started;
      const manifest = files.map(file => ({ path: file.path, size: file.content.length,
        mode: file.mode, executable: Boolean(file.mode & 0o111), sha256: createHash("sha256").update(file.content).digest("hex") }));
      const digest = createHash("sha256").update(JSON.stringify([...manifest].sort((a, b) => a.path.localeCompare(b.path)))).digest("hex");
      if (expectedDigest) assert.equal(digest, expectedDigest, "Source must stay unchanged across comparisons");
      expectedDigest = digest;
      fileCount = files.length;
      totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
      const writingStarted = performance.now();
      await implementation.writeAssetFiles(destination, files);
      await implementation.makeDirectoriesReadOnly(destination);
      const writeMs = performance.now() - writingStarted;
      const verifyStarted = performance.now();
      assert.equal(await verifyFileManifest(source, manifest), true);
      assert.equal(await verifyFileManifest(destination, manifest), true);
      const result = { readMs, writeMs, verifyMs: performance.now() - verifyStarted, totalMs: performance.now() - started };
      if (!suppliedSource) assert.equal(files.length, 671);
      results[label]!.push(result);
      console.error(JSON.stringify({ label, sample: i, ...result }));
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  console.log(JSON.stringify({ platform: process.platform, node: process.version, baselineRef, baselineRevision,
    ownerSha256: createHash("sha256").update(await fs.readFile(new URL("../src/services/native-runtime/runtime-asset-files.ts", import.meta.url))).digest("hex"),
    fixture: suppliedSource ? "supplied skill directory (read only)" : "synthetic skill",
    fixtureManifestSha256: expectedDigest, files: fileCount, bytes: totalBytes, samples: results,
    medianMs: Object.fromEntries(Object.entries(results).map(([label, values]) => [label, median(values.map(value => value.totalMs))])) }, null, 2));
} finally {
  async function writable(directory: string): Promise<void> {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await writable(target);
      else await fs.chmod(target, 0o600);
    }
  }
  // This invocation owns this temporary tree, including its read-only bundles.
  await writable(temporary);
  await fs.rm(temporary, { recursive: true, force: true });
}
