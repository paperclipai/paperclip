#!/usr/bin/env node
// Typechecks the test projects outside `pnpm -r`.
//
// Each project imports server source through relative paths, so its tsconfig.json
// is one program over most of the server. Its tsconfig.layers.json reads that
// source as the declarations from server/scripts/typecheck-layers.mjs, which this
// script builds first. It then fails if a project still loads server source,
// because that is what makes these programs large. See "Typecheck memory" in
// doc/test-infrastructure.md.
//
// --reuse-declarations skips the build. Use it only straight after a server
// typecheck on the same commit, because stale declarations pass silently.
//
// Usage: node scripts/typecheck-test-projects.mjs [--low-memory] [--checkers <n>] [--reuse-declarations] [project ...]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOW_MEMORY_VARIABLE, runTsc } from "./run-tsc.mjs";
import { runPnpm } from "./typecheck-low-memory.mjs";
import { isTestFile, typecheckLayers } from "../server/scripts/typecheck-layers.mjs";

export const PROJECTS = [
  "server/src/__tests__/helpers/maintenance",
  "tests/e2e",
  "tests/lifecycle-baseline",
  "tests/restart-chaos",
  "tests/runner-e2e",
  "tests/speko-native",
];

const GLOBAL_PROJECT_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".npmrc",
  "scripts/run-tsc.mjs",
  "scripts/ci-typecheck-lane.mjs",
  "scripts/typecheck-test-projects.mjs",
  "server/scripts/typecheck-layers.mjs",
  "server/tsconfig.json",
]);

const PROJECT_INPUT_PREFIXES = {
  "server/src/__tests__/helpers/maintenance": [
    "server/",
    "packages/db/",
    "packages/shared/",
    "scripts/sleep-qualification/",
  ],
  "tests/e2e": [
    "tests/e2e/",
    "tests/fixtures/",
    "tests/fetch-allowed-port",
    "tests/runner-e2e/",
    "cli/src/",
    "packages/shared/",
    "server/src/adapters/",
    "server/src/lib/oauth-browser-return",
    "server/src/agent-auth-jwt",
  ],
  "tests/lifecycle-baseline": [
    "tests/lifecycle-baseline/",
    "server/src/services/run-liveness",
    "server/src/services/recovery/",
    "server/src/services/native-runtime/",
    "server/src/services/execution-recovery-attempt",
    "server/src/services/heartbeat",
    "packages/paperclip-runner/",
    "packages/shared/",
    "packages/db/src/schema/",
    "packages/db/src/index.ts",
  ],
  "tests/restart-chaos": [
    "tests/restart-chaos/",
    "tests/runner-e2e/",
    "server/src/services/recovery/",
    "server/src/services/heartbeat",
    "server/src/services/accounting-transaction",
    "server/src/services/usage-receipts",
    "server/src/__tests__/helpers/embedded-postgres",
    "packages/db/src/schema/",
    "packages/db/src/index.ts",
    "packages/shared/",
  ],
  "tests/runner-e2e": [
    "tests/runner-e2e/",
    "packages/paperclip-runner/",
    "packages/paperclip-eval-kernel/",
    "packages/adapter-utils/",
    "packages/plugins/sdk/",
    "packages/shared/",
    "packages/db/src/schema/",
    "packages/db/src/index.ts",
    "server/src/routes/native-run-mcp",
    "server/src/services/native-runtime/",
  ],
  "tests/speko-native": [
    "tests/speko-native/",
    "packages/db/src/schema/",
    "packages/db/src/index.ts",
    "packages/shared/",
    "server/src/services/chat-",
    "server/src/routes/chat-",
    "server/src/services/voice",
  ],
};

/**
 * Selects the test projects affected by `changedFiles` in PR mode.
 * Returns all `projects` when `changedFiles` is null/undefined or touches global inputs.
 */
export function selectTestProjects(changedFiles, projects = PROJECTS) {
  if (!Array.isArray(changedFiles)) return [...projects];
  if (changedFiles.some((file) => GLOBAL_PROJECT_INPUTS.has(file) || file.startsWith("patches/"))) {
    return [...projects];
  }
  return projects.filter((project) => {
    const prefixes = PROJECT_INPUT_PREFIXES[project];
    // Fail closed for any new project without explicit input rules.
    if (!prefixes) return true;
    return changedFiles.some((file) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix)));
  });
}

// The same steps as the server's typecheck script.
export const PREPARE_STEPS = [
  ["--filter", "@paperclipai/paperclip-runner", "run", "build:typescript"],
  ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
];

/**
 * Finds the server source in a program's file list, as paths relative to the
 * server. Test support files have no layer, and declaration and JSON files add
 * little, so only other source files count.
 */
export function findServerSource(files, serverRoot) {
  return files
    .map((file) => path.relative(serverRoot, file).split(path.sep).join("/"))
    .filter(
      (file) =>
        file.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !isTestFile(file),
    );
}

function listProgramFiles(config, { cwd, env }) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, files: result.stdout.split("\n").filter(Boolean), output: result.stdout };
}

export function typecheckTestProjects({
  root,
  projects = PROJECTS,
  reuseDeclarations = false,
  checkers,
  env = process.env,
  pnpm = runPnpm,
  run = runTsc,
  listFiles = listProgramFiles,
  log = console.log,
  logError = console.error,
}) {
  const serverRoot = path.join(root, "server");
  if (!reuseDeclarations) {
    for (const args of PREPARE_STEPS) {
      const status = pnpm(args, { cwd: root, env });
      if (status !== 0) return status;
    }

    const layers = typecheckLayers({
      serverRoot,
      declarationsOnly: true,
      checkers,
      run: (args, options) => run(args, { ...options, env }),
      log,
    });
    // Report the server's own errors first. They would repeat in each project.
    if (layers !== 0) return layers;
  }

  const checkerArgs = Number.isInteger(checkers) && checkers >= 1 ? ["--checkers", String(checkers)] : [];
  let exitCode = 0;
  for (const project of projects) {
    log(`typecheck:test-projects: ${project}`);
    const config = path.posix.join(project, "tsconfig.layers.json");
    const { status, signal } = run(["-p", config, ...checkerArgs], { cwd: root, env });
    if (signal) return status || 1;
    if (status !== 0) exitCode = status;

    const listing = listFiles(config, { cwd: root, env });
    if (listing.status !== 0) {
      logError(`typecheck:test-projects: could not list the files of ${project}\n${listing.output ?? ""}`);
      exitCode ||= listing.status;
      continue;
    }
    const source = findServerSource(listing.files, serverRoot);
    if (source.length > 0) {
      logError(
        `typecheck:test-projects: ${project} loads ${source.length} server source files. ` +
          `It must read them as layer declarations. First files: ${source.slice(0, 5).join(", ")}`,
      );
      exitCode ||= 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let lowMemory = false;
  let reuseDeclarations = false;
  let checkers;
  const projects = [];
  const unknownFlags = [];
  let invalidCheckers = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--low-memory") {
      lowMemory = true;
    } else if (arg === "--reuse-declarations") {
      reuseDeclarations = true;
    } else if (arg === "--checkers") {
      checkers = Number(args[++i]);
      if (!Number.isInteger(checkers) || checkers < 1) invalidCheckers = true;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(arg);
    } else {
      projects.push(arg);
    }
  }
  const unknown = projects.filter((project) => !PROJECTS.includes(project));
  if (unknownFlags.length > 0) {
    console.error(`Unknown option: ${unknownFlags.join(", ")}`);
    process.exitCode = 2;
  } else if (invalidCheckers) {
    console.error("--checkers requires a positive integer");
    process.exitCode = 2;
  } else if (unknown.length > 0) {
    console.error(`Unknown project: ${unknown.join(", ")}. Known projects: ${PROJECTS.join(", ")}`);
    process.exitCode = 2;
  } else {
    process.exitCode = typecheckTestProjects({
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      projects: projects.length > 0 ? projects : PROJECTS,
      reuseDeclarations,
      checkers,
      env: lowMemory ? { ...process.env, [LOW_MEMORY_VARIABLE]: "1" } : process.env,
    });
  }
}
