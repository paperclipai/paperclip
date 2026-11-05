// Brackets the Runner package's `build` so server's prepare:runner-vendor can
// reuse this build instead of repeating it when nothing has changed. See
// build-inputs.mjs for what counts as an input and an output.
//
//   --begin   first step of the build: forgets the previous stamp and records
//             the inputs the build is about to read
//   --finish  last step of the build, after every check: writes the stamp if
//             the inputs are still the ones the build began with, with a
//             manifest of every file under dist; otherwise writes nothing, so
//             the next consumer rebuilds
//
// Each build chain has its own pending record, named after the shell that
// runs the chain (the parent of both phases), so two Runner builds running at
// once in one checkout do not consume each other's record.
//
// Usage: node scripts/record-build-inputs.mjs (--begin | --finish) [--package-root <dir>]
// The package root defaults to this package; the flag exists for tests that
// build a throwaway package layout.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginRunnerBuild,
  recordRunnerBuild,
  repoRootFromRunnerPackage,
  runnerPackageRootFromScripts,
} from "./build-inputs.mjs";

export function parseArguments(argv) {
  let packageRoot = null;
  let phase = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--begin" || argument === "--finish") {
      if (phase) throw new Error(`${argument} cannot be combined with --${phase}`);
      phase = argument.slice(2);
      continue;
    }
    if (argument === "--package-root") {
      packageRoot = argv[index + 1];
      if (!packageRoot) throw new Error("--package-root needs a directory");
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  if (!phase) throw new Error("one of --begin or --finish is required");
  return { phase, packageRoot };
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const { phase, packageRoot: requested } = parseArguments(argv);
  const packageRoot = requested ? path.resolve(requested) : runnerPackageRootFromScripts();
  const repoRoot = repoRootFromRunnerPackage(packageRoot);

  if (phase === "begin") {
    const pending = beginRunnerBuild({ repoRoot, packageRoot });
    log(
      `${pending.schema} begin: digest=${pending.digest.slice(0, 12)} files=${pending.fileCount} ` +
        `bytes=${pending.byteCount}`,
    );
    return pending;
  }

  const record = recordRunnerBuild({ repoRoot, packageRoot });
  if (!record.recorded) {
    log(`${record.code === "inputs_changed_during_build" ? "paperclip.runner-build-inputs" : record.code} not recorded: ${record.detail}`);
    return record;
  }
  log(
    `${record.schema} recorded: digest=${record.digest.slice(0, 12)} files=${record.fileCount} ` +
      `bytes=${record.byteCount} outputs=${record.outputCount} stamp=${path.relative(packageRoot, record.stampPath)}`,
  );
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
