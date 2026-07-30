#!/usr/bin/env node
// Pre-reload compile gate for the dev watcher.
//
// The live Paperclip server runs `tsx watch src/index.ts`. On every save tsx
// tears down the running server and re-imports the entry; if the new code does
// not load (a half-saved file with a syntax error, or a transiently-missing
// import like `./run-gate.ts`) the restart crashes and NOTHING is left
// listening on :3100 — taking the whole fleet down until the file is valid
// again. This happened twice over the weekend.
//
// This gate is the pre-reload safety net the supervisor runs BEFORE it swaps
// the running server:
// 1. Bundle the entry's source graph with esbuild. This is cheap and
//    side-effect-free: no code execution, no port binding, no DB.
// 2. Typecheck the shared/db workspace packages whose schema/contracts can
//    invalidate the live server even when the server bundle still parses.
// 3. Boot a temp migrated embedded-Postgres DB and perform a real issue-create
//    smoke through the app, proving the create path still works before reload.
//
// Exit 0  -> the candidate compiles; the supervisor may reload.
// Exit !0 -> syntax error / unresolved import; errors printed to stderr and the
//            supervisor KEEPS the currently-running server. Fail safe: a bad
//            edit can never take the server down, only delay the next reload.
//
// Usage: node dev-watch-gate.mjs [entry] [--cwd <dir>]
//   entry defaults to "src/index.ts"; cwd defaults to the server package root.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..");

const args = process.argv.slice(2);
let entry = "src/index.ts";
let cwd = serverRoot;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--cwd") {
    cwd = path.resolve(args[i + 1] ?? cwd);
    i += 1;
  } else if (!args[i].startsWith("--")) {
    entry = args[i];
  }
}

let esbuild;
let tsxLoaderPath;
let typescriptTscPath;
try {
  esbuild = require("esbuild");
} catch {
  // esbuild lives in the repo root node_modules, not the server package's.
  esbuild = require(path.resolve(serverRoot, "..", "node_modules", "esbuild"));
}
try {
  tsxLoaderPath = require.resolve("tsx");
} catch {
  tsxLoaderPath = require.resolve(path.resolve(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"));
}
try {
  typescriptTscPath = require.resolve("typescript/bin/tsc");
} catch {
  typescriptTscPath = require.resolve(path.resolve(repoRoot, "node_modules", "typescript", "bin", "tsc"));
}

// Externalize everything that resolves into a real `node_modules` (third-party
// deps), but FOLLOW our own `@paperclipai/*` workspace packages so a broken edit
// inside a shared package is caught too. pnpm symlinks workspace packages under
// node_modules, so we key off the package-name prefix rather than the path.
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (resolveArgs) => {
      if (resolveArgs.kind === "entry-point") return undefined;
      const id = resolveArgs.path;
      const isRelative = id.startsWith(".") || path.isAbsolute(id);
      if (isRelative) return undefined; // follow our own source
      if (id.startsWith("@paperclipai/")) return undefined; // follow workspace source
      return { path: id, external: true }; // real dependency: don't follow
    });
  },
};

function runCommand(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", (error) => {
      process.stderr.write(`[dev-watch-gate] failed to run ${command}: ${error.message}\n`);
      resolve(false);
    });
  });
}

async function runTypeScriptCompile(label, projectPath) {
  process.stdout.write(`[dev-watch-gate] typechecking ${label}\n`);
  return await runCommand(process.execPath, [typescriptTscPath, "-p", projectPath, "--noEmit"], {
    cwd: repoRoot,
  });
}

async function runDbMigrationNumberingCheck() {
  process.stdout.write("[dev-watch-gate] checking db migration numbering\n");
  return await runCommand(process.execPath, ["--import", tsxLoaderPath, path.resolve(repoRoot, "packages/db/src/check-migration-numbering.ts")], {
    cwd: repoRoot,
  });
}

async function runIssueCreateSmoke() {
  process.stdout.write("[dev-watch-gate] running issue-create smoke with migrated temp DB\n");
  return await runCommand(process.execPath, ["--import", tsxLoaderPath, path.resolve(serverRoot, "scripts", "dev-watch-issue-create-smoke.ts")], {
    cwd: repoRoot,
  });
}

try {
  const result = await esbuild.build({
    entryPoints: [path.resolve(cwd, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    absWorkingDir: cwd,
    plugins: [externalizeThirdParty],
  });
  if (result.errors.length > 0) {
    const formatted = await esbuild.formatMessages(result.errors, { kind: "error", color: true });
    process.stderr.write(formatted.join(""));
    process.exit(1);
  }
  if (!(await runTypeScriptCompile("@paperclipai/shared", path.resolve(repoRoot, "packages/shared/tsconfig.json")))) {
    process.stderr.write("[dev-watch-gate] shared typecheck failed; keeping the running server\n");
    process.exit(1);
  }
  if (!(await runDbMigrationNumberingCheck())) {
    process.stderr.write("[dev-watch-gate] db migration numbering check failed; keeping the running server\n");
    process.exit(1);
  }
  if (!(await runTypeScriptCompile("@paperclipai/db", path.resolve(repoRoot, "packages/db/tsconfig.json")))) {
    process.stderr.write("[dev-watch-gate] db typecheck failed; keeping the running server\n");
    process.exit(1);
  }
  if (!(await runIssueCreateSmoke())) {
    process.stderr.write("[dev-watch-gate] issue-create smoke failed; keeping the running server\n");
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  // esbuild throws on compile failure; its `.errors` carry the resolve/parse
  // diagnostics. Anything else (esbuild missing, OOM) also fails the gate —
  // the supervisor treats a non-zero exit as "keep the running server".
  const errors = error?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const formatted = await esbuild.formatMessages(errors, { kind: "error", color: true });
    process.stderr.write(formatted.join(""));
  } else {
    process.stderr.write(`[dev-watch-gate] gate failed to run: ${error?.message ?? error}\n`);
  }
  process.exit(1);
}
