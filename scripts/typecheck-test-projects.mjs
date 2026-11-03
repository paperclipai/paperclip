#!/usr/bin/env node
// Typechecks the test projects outside `pnpm -r`.
//
// Each project imports server source through relative paths, so its tsconfig.json
// is one program over most of the server. Its tsconfig.layers.json reads that
// source as the declarations from server/scripts/typecheck-layers.mjs, which this
// script builds first. See "Typecheck memory" in doc/DEVELOPING.md.
//
// Usage: node scripts/typecheck-test-projects.mjs [--low-memory] [project ...]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOW_MEMORY_VARIABLE, runTsc } from "./run-tsc.mjs";
import { runPnpm } from "./typecheck-low-memory.mjs";
import { typecheckLayers } from "../server/scripts/typecheck-layers.mjs";

export const PROJECTS = [
  "server/src/__tests__/helpers/maintenance",
  "tests/lifecycle-baseline",
  "tests/runner-e2e",
  "tests/speko-native",
];

// The same steps as the server's typecheck script.
export const PREPARE_STEPS = [
  ["--filter", "@paperclipai/paperclip-runner", "run", "build:typescript"],
  ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
];

export function typecheckTestProjects({
  root,
  projects = PROJECTS,
  env = process.env,
  pnpm = runPnpm,
  run = runTsc,
  log = console.log,
}) {
  for (const args of PREPARE_STEPS) {
    const status = pnpm(args, { cwd: root, env });
    if (status !== 0) return status;
  }

  const layers = typecheckLayers({
    serverRoot: path.join(root, "server"),
    declarationsOnly: true,
    run: (args, options) => run(args, { ...options, env }),
    log,
  });
  // Report the server's own errors first. They would repeat in each project.
  if (layers !== 0) return layers;

  let exitCode = 0;
  for (const project of projects) {
    log(`typecheck:test-projects: ${project}`);
    const { status, signal } = run(["-p", path.posix.join(project, "tsconfig.layers.json")], { cwd: root, env });
    if (signal) return status || 1;
    if (status !== 0) exitCode = status;
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const projects = args.filter((arg) => arg !== "--low-memory");
  const unknown = projects.filter((project) => !PROJECTS.includes(project));
  if (unknown.length > 0) {
    console.error(`Unknown project: ${unknown.join(", ")}. Known projects: ${PROJECTS.join(", ")}`);
    process.exitCode = 2;
  } else {
    process.exitCode = typecheckTestProjects({
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      projects: projects.length > 0 ? projects : PROJECTS,
      env: args.includes("--low-memory") ? { ...process.env, [LOW_MEMORY_VARIABLE]: "1" } : process.env,
    });
  }
}
