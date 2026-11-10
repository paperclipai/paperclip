#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function repoPath(root, file) {
  const relative = path.relative(root, path.resolve(root, file));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Expected a file inside the checkout: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

// This is an experiment report, deliberately not a CI execution plan. Import
// graphs cannot describe filesystem reads, subprocesses, or external services.
export async function measureVitestImpact({ root = process.cwd(), projects, changedFiles }) {
  root = realpathSync(root);
  if (!projects?.length || !changedFiles?.length) {
    throw new Error("Specify at least one project and one changed file");
  }
  const files = [...new Set(changedFiles.map((file) => repoPath(root, file)))].sort();
  const { createVitest } = await import("vitest/node");
  const results = [];
  // Each project gets its own graph to bound memory usage. Cross-package imports
  // are still followed, but projects omitted by the caller are NOT assessed.
  for (const project of new Set(projects)) {
    const started = performance.now();
    const ctx = await createVitest({
      root,
      watch: false,
      project: [project],
      exclude: ["**/dist/**"],
      reporters: [],
      related: files.map((file) => path.resolve(root, file)),
    });
    try {
      if (ctx.projects.length !== 1 || ctx.projects[0].name !== project) {
        throw new Error(`Expected exactly one project named ${project}`);
      }
      const inventory = await ctx.globTestSpecifications();
      if (!inventory.length) throw new Error(`No test files found for ${project}`);
      const ready = performance.now();
      const selected = await ctx.getRelevantTestSpecifications();
      const finished = performance.now();
      const selectedTests = selected.map((spec) => repoPath(root, spec.moduleId)).sort();
      const selectedSet = new Set(selectedTests);
      results.push({
        project,
        totalFiles: inventory.length,
        selectedFiles: selectedTests.length,
        startupSeconds: (ready - started) / 1000,
        selectionSeconds: (finished - ready) / 1000,
        selectedTests,
        omittedTests: inventory.map((spec) => repoPath(root, spec.moduleId))
          .filter((file) => !selectedSet.has(file)).sort(),
      });
    } finally {
      await ctx.close();
    }
  }
  return {
    mode: "report-only",
    changedFiles: files,
    limitations: [
      "Only the explicitly requested projects were assessed.",
      "Selection follows imports, not filesystem reads, subprocesses, or external services.",
      "Zero selected files is not proof that a change needs no tests.",
      "This report must not be used to omit required CI jobs.",
    ],
    projects: results,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    project: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    base: { type: "string" },
    output: { type: "string" },
  } });
  if (!values.project?.length || (!!values.base === !!values.file?.length)) {
    throw new Error("Usage: node scripts/ci/vitest-impact-report.mjs --project NAME [--project NAME] (--file PATH [--file PATH] | --base REF) [--output FILE]");
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  let comparison = { kind: "hypothetical", head };
  let changedFiles = values.file;
  if (values.base) {
    // Vitest reads the working tree, so do not label dirty sources as HEAD.
    if (git("status", "--porcelain", "--untracked-files=no").trim()) {
      throw new Error("--base requires a clean tracked working tree; use --file for a hypothetical change");
    }
    const base = git("rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`).trim();
    // Compare the actual trees, including both sides of a rename. The caller
    // supplies the event base; HEAD should be the tested PR merge commit in CI.
    changedFiles = git("diff", "--name-only", "--no-renames", "-z", base, head, "--")
      .split("\0").filter(Boolean);
    comparison = { kind: "git-diff", base, head };
  }
  process.env.NODE_ENV = "test";
  process.env.VITEST = "true";
  // Config/plugins are executable code. Run this only in a test job, never in
  // the trusted metadata-only CI routing gate. Bound a failed graph traversal.
  const timeout = setTimeout(() => {
    console.error("Vitest impact analysis exceeded five minutes; report unavailable");
    process.exit(1);
  }, 300_000);
  try {
    const report = await measureVitestImpact({ projects: values.project, changedFiles });
    const json = `${JSON.stringify({ ...report, comparison }, null, 2)}\n`;
    if (values.output) writeFileSync(values.output, json);
    else process.stdout.write(json);
    for (const result of report.projects) {
      console.error(`${result.project}: ${result.selectedFiles}/${result.totalFiles} files; `
        + `${result.selectionSeconds.toFixed(2)}s graph + ${result.startupSeconds.toFixed(2)}s startup`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
