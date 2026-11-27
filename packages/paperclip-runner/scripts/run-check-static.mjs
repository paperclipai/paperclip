import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const node = process.execPath;

const SYNTAX_CHECK_SCRIPTS = [
  "scripts/protocol-contract.mjs",
  "scripts/generate-protocol-manifest.mjs",
  "scripts/generate-protocol-schema-module.mjs",
  "scripts/generate-acpx-sidecar-contract.mjs",
  "scripts/generate-replay-goldens.mjs",
  "scripts/generate-semantic-action-catalog.mjs",
];

const PROTOCOL_TYPE_GENERATORS = [
  "scripts/generate-protocol-schema-module.mjs",
  "scripts/generate-acpx-sidecar-contract.mjs",
  "scripts/generate-runtime-context-contract.mjs",
  "scripts/generate-provider-failure-contract.mjs",
];

function cmd(label, command, args, cwd = packageRoot) {
  return { label, command, args, cwd };
}

export function buildStaticCheckPlan() {
  return [
    {
      name: "eval-kernel",
      mode: "serial",
      steps: [
        cmd("check:eval-kernel", pnpm, ["--filter", "@paperclipai/paperclip-eval-kernel", "test"]),
      ],
    },
    {
      name: "read-only-checks",
      mode: "parallel",
      steps: [
        cmd("check:acpx-profiles", node, ["scripts/generate-acpx-profiles.mjs", "--check"]),
        cmd("check:antigravity-models", node, ["scripts/generate-antigravity-models.mjs", "--check"]),
        cmd("check:protocol-manifest", node, ["scripts/generate-protocol-manifest.mjs", "--check"]),
        ...SYNTAX_CHECK_SCRIPTS.map((script) => cmd(`syntax:${script}`, node, ["--check", script])),
        ...PROTOCOL_TYPE_GENERATORS.map((script) => cmd(`protocol-types:${script}`, node, [script, "--check"])),
      ],
    },
    {
      name: "disjoint-builds",
      mode: "parallel-chains",
      chains: [
        {
          name: "typescript-and-replay-goldens",
          steps: [
            cmd("tsc:version", node, ["./node_modules/typescript/bin/tsc", "--version"]),
            cmd("tsc:tsconfig", node, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]),
            cmd("tsc:surfaces", node, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.surfaces.json"]),
            cmd("build:verified-entrypoints", node, ["scripts/build-verified-provider-entrypoints.mjs"]),
            cmd("install:copilot-assets", node, ["scripts/install-copilot-assets.mjs"]),
            cmd("check:replay-goldens", node, ["scripts/generate-replay-goldens.mjs", "--check"]),
          ],
        },
        {
          name: "rust-binaries",
          steps: [
            cmd("cargo:debug-bins", "cargo", [
              "build", "--manifest-path", "runner/Cargo.toml", "--locked", "--workspace", "--bins",
            ]),
            cmd("cargo:release-runnerd", "cargo", [
              "build", "--release", "--manifest-path", "runner/Cargo.toml", "--locked",
              "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd",
            ]),
          ],
        },
        {
          name: "plugin-sdk-deps",
          steps: [
            cmd("plugin-sdk:ensure-build-deps", pnpm, ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]),
          ],
        },
      ],
    },
    {
      name: "stage-runner-binary",
      mode: "serial",
      steps: [
        cmd("stage:runner-binary", node, ["scripts/stage-runner-binary.mjs"]),
      ],
    },
    {
      name: "heavy-test-suites",
      mode: "parallel",
      steps: [
        cmd("test:typescript:prep", node, ["scripts/run-prep-tests.mjs", "--skip-build"]),
        cmd("check:api-authority", node, ["scripts/check-api-authority.mjs", "--skip-build"]),
      ],
    },
  ];
}

const activeChildren = new Map();
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let cancelSignal = null;
let shutdownPromise = null;

function killProcessTree(child, signal, detached) {
  if (detached && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
  }
}

function destroyPipes(child) {
  try {
    child.stdout?.destroy();
  } catch {
  }
  try {
    child.stderr?.destroy();
  } catch {
  }
}

export async function stopActiveChildren(signal = "SIGTERM", { graceMs = 5_000, forceGraceMs = 500 } = {}) {
  const entries = [...activeChildren.entries()];
  if (entries.length === 0) return;
  for (const [child, entry] of entries) {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, signal, entry.detached);
    }
  }
  const waitForAll = Promise.all(entries.map(([, entry]) => entry.done));
  let timer;
  const timedOut = await Promise.race([
    waitForAll.then(() => false),
    new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(true), graceMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (!timedOut) return;
  for (const [child, entry] of entries) {
    killProcessTree(child, "SIGKILL", entry.detached);
    destroyPipes(child);
  }
  let forceTimer;
  await Promise.race([
    waitForAll,
    new Promise((resolvePromise) => {
      forceTimer = setTimeout(resolvePromise, forceGraceMs);
      forceTimer.unref?.();
    }),
  ]);
  clearTimeout(forceTimer);
  for (const [, entry] of entries) {
    entry.forceResolve();
  }
}

function forwardSignal(signal) {
  cancelSignal = signal;
  if (shutdownPromise) return;
  shutdownPromise = stopActiveChildren(signal).finally(() => {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 128);
  });
}

export function installSignalHandlers() {
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  process.on("SIGHUP", forwardSignal);
}

export function uninstallSignalHandlers() {
  process.removeListener("SIGINT", forwardSignal);
  process.removeListener("SIGTERM", forwardSignal);
  process.removeListener("SIGHUP", forwardSignal);
}

export function getShutdownPromise() {
  return shutdownPromise;
}

export function runCommand(step, { bufferOutput = false, env = process.env, shell = false } = {}) {
  if (cancelSignal) {
    return Promise.resolve({
      label: step.label,
      code: SIGNAL_EXIT_CODES[cancelSignal] ?? 128,
      durationMs: 0,
      chunks: [],
    });
  }
  const startedAt = Date.now();
  const detached = process.platform !== "win32";
  return new Promise((resolvePromise) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env,
      shell,
      detached,
      stdio: bufferOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let resolveDone;
    const done = new Promise((r) => {
      resolveDone = r;
    });
    const chunks = [];
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      resolveDone();
      resolvePromise(payload);
    };
    activeChildren.set(child, {
      done,
      detached,
      forceResolve: () => finish({
        label: step.label,
        code: SIGNAL_EXIT_CODES[cancelSignal] ?? 128,
        durationMs: Date.now() - startedAt,
        chunks,
      }),
    });
    if (bufferOutput) {
      child.stdout.on("data", (chunk) => chunks.push({ stream: "stdout", chunk }));
      child.stderr.on("data", (chunk) => chunks.push({ stream: "stderr", chunk }));
    }
    child.once("error", (error) => {
      finish({
        label: step.label,
        code: 1,
        durationMs: Date.now() - startedAt,
        chunks,
        error,
      });
    });
    child.once("close", (code, signal) => {
      finish({
        label: step.label,
        code: signal ? (SIGNAL_EXIT_CODES[signal] ?? 128) : (code ?? 1),
        durationMs: Date.now() - startedAt,
        chunks,
      });
    });
  });
}

function flushResult(result, prefix) {
  for (const { stream, chunk } of result.chunks) {
    process[stream].write(chunk);
  }
  if (result.error) {
    console.error(`${prefix} ${result.label} failed to spawn: ${result.error.message}`);
  }
}

async function runChain(chain, { bufferOutput = true, prefix = "[check:static]", verbosePhases = true } = {}) {
  const results = [];
  for (const step of chain.steps) {
    const result = await runCommand(step, { bufferOutput, env: step.env ?? process.env, shell: Boolean(step.shell) });
    results.push(result);
    if (result.code !== 0) break;
  }
  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const failed = results.find((result) => result.code !== 0);
  if (verbosePhases) {
    console.log(`${prefix} --- chain:${chain.name} (${(totalMs / 1000).toFixed(1)}s, exit=${failed?.code ?? 0}) ---`);
  }
  for (const result of results) flushResult(result, prefix);
  return { name: chain.name, results, failed };
}

export async function executePhases(phases, { prefix = "[check:static]", verbosePhases = true } = {}) {
  installSignalHandlers();
  try {
    for (const phase of phases) {
      if (shutdownPromise) {
        await shutdownPromise;
        return;
      }
      const phaseStart = Date.now();
      if (verbosePhases) console.log(`${prefix} phase=${phase.name} mode=${phase.mode}`);
      if (phase.mode === "serial") {
        for (const step of phase.steps) {
          const result = await runCommand(step, { bufferOutput: false, env: step.env ?? process.env, shell: Boolean(step.shell) });
          if (shutdownPromise) {
            await shutdownPromise;
            return;
          }
          if (result.code !== 0) {
            console.error(`${prefix} FAILED ${result.label} (exit=${result.code})`);
            process.exit(result.code);
          }
        }
      } else if (phase.mode === "parallel") {
        const bufferOutput = phase.steps.length > 1;
        const results = await Promise.all(
          phase.steps.map(async (step) => {
            const result = await runCommand(step, { bufferOutput, env: step.env ?? process.env, shell: Boolean(step.shell) });
            if (bufferOutput) {
              if (verbosePhases) {
                console.log(`${prefix} --- ${result.label} (${(result.durationMs / 1000).toFixed(1)}s, exit=${result.code}) ---`);
              }
              flushResult(result, prefix);
            }
            return result;
          }),
        );
        if (shutdownPromise) {
          await shutdownPromise;
          return;
        }
        const failed = results.find((result) => result.code !== 0);
        if (failed) {
          console.error(`${prefix} FAILED ${failed.label} (exit=${failed.code})`);
          process.exit(failed.code);
        }
      } else if (phase.mode === "parallel-chains") {
        const chains = await Promise.all(phase.chains.map((chain) => runChain(chain, { bufferOutput: true, prefix, verbosePhases })));
        if (shutdownPromise) {
          await shutdownPromise;
          return;
        }
        const firstFailure = chains.find((chain) => chain.failed)?.failed ?? null;
        if (firstFailure) {
          console.error(`${prefix} FAILED ${firstFailure.label} (exit=${firstFailure.code})`);
          process.exit(firstFailure.code);
        }
      }
      if (verbosePhases) console.log(`${prefix} phase=${phase.name} done (${((Date.now() - phaseStart) / 1000).toFixed(1)}s)`);
    }
  } finally {
    uninstallSignalHandlers();
  }
}

async function executePlan(phases) {
  await executePhases(phases, { prefix: "[check:static]", verbosePhases: true });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`[check:static] unrecognized argument(s): ${unknown.join(" ")}`);
    process.exit(1);
  }
  const phases = buildStaticCheckPlan();
  if (dryRun) {
    console.log(JSON.stringify({ phases }, null, 2));
    return;
  }
  await executePlan(phases);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
