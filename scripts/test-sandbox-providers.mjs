#!/usr/bin/env node

// Runs the Vitest suite of every sandbox provider plugin.
//
// Sandbox providers are outside the root workspace (see pnpm-workspace.yaml), so
// neither the root install nor `pnpm test:run` reaches them. This script installs
// them the same way scripts/typecheck-test-programs.mjs does, because that script
// owns the provider install: it does that install, links the in-repo plugin SDK
// and, when given no programs, typechecks nothing. The tests then run in parallel,
// and each provider's output prints in one block when its suite finishes.
//
// The `Sandbox provider tests` job in .github/workflows/pr-trusted.yml runs this
// script. The `//#ci:sandbox-providers` inputs in turbo.json decide when it runs.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_PROVIDERS, typecheckTestPrograms } from "./typecheck-test-programs.mjs";

// Four suites at once keep a CI runner busy without slowing Daytona, the longest one.
export const MAX_CONCURRENCY = 4;

// A provider inside another provider runs with its parent: Cloudflare's Vitest config
// includes bridge-template/src, so running bridge-template on its own repeats those tests.
export function providersWithTests({ root, providers = SANDBOX_PROVIDERS }) {
  return providers.filter((directory) => {
    if (providers.some((other) => other !== directory && directory.startsWith(`${other}/`))) return false;
    const manifest = path.join(root, directory, "package.json");
    if (!existsSync(manifest)) return false;
    return typeof JSON.parse(readFileSync(manifest, "utf8")).scripts?.test === "string";
  });
}

function runPnpmTest({ root, directory, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn("pnpm", ["test"], { cwd: path.join(root, directory), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
      resolve({ status: 1, output: Buffer.concat(chunks).toString(), seconds: (Date.now() - started) / 1000 });
    });
    child.on("close", (status, signal) => {
      resolve({
        status: signal ? 1 : status ?? 1,
        output: Buffer.concat(chunks).toString(),
        seconds: (Date.now() - started) / 1000,
      });
    });
  });
}

export async function runProviderTests({
  root,
  env = process.env,
  providers = providersWithTests({ root }),
  concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, availableParallelism())),
  prepare = () => typecheckTestPrograms({ root, env, programs: [], coverage: false }),
  runOne = runPnpmTest,
  write = (text) => process.stdout.write(text),
  grouped = env.GITHUB_ACTIONS === "true",
}) {
  if (providers.length === 0) {
    write("test:sandbox-providers: no sandbox provider has a test script\n");
    return 1;
  }
  const prepared = prepare();
  if (prepared !== 0) {
    write("test:sandbox-providers: could not install the sandbox providers\n");
    return prepared;
  }

  const results = [];
  const queue = [...providers];
  async function worker() {
    for (let directory = queue.shift(); directory; directory = queue.shift()) {
      const result = await runOne({ root, directory, env });
      const name = path.basename(directory);
      const outcome = result.status === 0 ? "passed" : "failed";
      const header = `${name}: ${outcome} in ${result.seconds.toFixed(1)}s`;
      const body = result.output.endsWith("\n") || result.output === "" ? result.output : `${result.output}\n`;
      write(grouped ? `::group::${header}\n${body}::endgroup::\n` : `--- ${header}\n${body}`);
      if (result.status !== 0 && grouped) write(`::error title=Sandbox provider tests::${name} failed\n`);
      results.push({ name, ...result });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, providers.length) }, worker));

  const failed = results.filter((result) => result.status !== 0).map((result) => result.name).sort();
  write(`test:sandbox-providers: ${results.length - failed.length} of ${results.length} provider suites passed\n`);
  if (failed.length > 0) {
    write(`test:sandbox-providers: failed: ${failed.join(", ")}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = await runProviderTests({ root });
}
