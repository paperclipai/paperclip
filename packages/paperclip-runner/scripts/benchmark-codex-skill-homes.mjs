#!/usr/bin/env node
// Compares per-session Codex skill copies with a shared skill home.
// Usage: node scripts/benchmark-codex-skill-homes.mjs <skills-dir> <work-root>
//   <skills-dir>  a directory whose subdirectories are skill bundles (read only)
//   <work-root>   an empty scratch directory; it is removed afterwards
// Requires `pnpm run build:typescript` (reads the compiled dist).
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
} from "../dist/contracts/runtime-context.js";
import { removeCodexSkillHomeTree } from "../dist/drivers/codex-skill-home.js";
import { prepareIsolatedCodexHome } from "../dist/drivers/runtime-context-materializer.js";

const [skillsDir, workRoot] = process.argv.slice(2).map((value) => value && resolve(value));
if (!skillsDir || !workRoot) {
  console.error("usage: benchmark-codex-skill-homes.mjs <skills-dir> <work-root>");
  process.exit(2);
}

async function bytesAndFiles(path) {
  const info = await lstat(path).catch(() => null);
  if (!info) return { bytes: 0, files: 0 };
  if (info.isFile()) return { bytes: info.size, files: 1 };
  if (!info.isDirectory()) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const name of await readdir(path)) {
    const child = await bytesAndFiles(join(path, name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const names = (await readdir(skillsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();
const zero = "0".repeat(64);
const value = {
  prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
  instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: zero, manifestDigest: zero,
    rootPath: skillsDir, fileCount: 1, totalBytes: 1 } },
  skills: names.map((name) => ({
    key: `benchmark/${name}`, runtimeName: name, versionId: "benchmark",
    bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: digest(name), manifestDigest: digest(name),
      rootPath: join(skillsDir, name), fileCount: 1, totalBytes: 1 },
  })),
  mcp: { assignmentSetId: "benchmark", digest: zero, bindingId: null },
};
const context = { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
const source = await bytesAndFiles(skillsDir);

const report = { skills: names.length, sourceBytes: source.bytes, sourceFiles: source.files, modes: {} };
await mkdir(workRoot, { recursive: true });
try {
  for (const mode of ["copy", "shared"]) {
    const root = join(workRoot, mode);
    const storeRoot = join(root, "skill-homes");
    const runs = [];
    for (const session of [1, 2, 3]) {
      const codexHome = join(root, `session-${session}`, "codex-home");
      const started = performance.now();
      await prepareIsolatedCodexHome({ context, codexHome, ...(mode === "shared" ? { skillHomeStoreRoot: storeRoot } : {}) });
      runs.push({ session, ms: Math.round(performance.now() - started), sessionBytes: (await bytesAndFiles(join(root, `session-${session}`))).bytes });
    }
    const total = await bytesAndFiles(root);
    report.modes[mode] = { runs, storeBytes: (await bytesAndFiles(storeRoot)).bytes, totalBytes: total.bytes, totalFiles: total.files };
  }
} finally {
  await removeCodexSkillHomeTree(workRoot);
}
console.log(JSON.stringify(report, null, 2));
