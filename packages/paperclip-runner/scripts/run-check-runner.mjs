import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getShutdownPromise,
  installSignalHandlers,
  runCommand,
  uninstallSignalHandlers,
} from "./run-check-static.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

export const REQUIRED_PARITY_TESTS = [
  "runs_the_mock_core_path_with_stable_output",
  "replay_fixture_parity",
];

const LPT_PRIORITY = new Map([
  ["codex_provider", 100],
  ["acpx_sidecar_stopped_time", 90],
  ["acpx_park_preparation", 85],
  ["acpx_quiet_turn_continuation", 80],
  ["paperclip_runner_core", 75],
  ["native_provider_backend", 70],
  ["acpx_warm_attachment", 65],
  ["acpx_sidecar_transport", 60],
  ["acpx_park_readiness", 55],
  ["acpx_provider_turns", 50],
  ["provider_bridge", 45],
  ["stdio_mcp", 40],
]);

const SINGLE_THREAD_BINARIES = new Set(["acpx_sidecar_stopped_time"]);

export function buildRunnerCheckPlan({ cpus = availableParallelism() } = {}) {
  const safeCpus = Math.max(1, Number.isFinite(cpus) ? Math.floor(cpus) : 4);
  return {
    binaryConcurrency: Math.min(6, Math.max(2, safeCpus)),
    heavyTestThreads: Math.max(2, safeCpus),
    defaultTestThreads: Math.max(2, Math.floor(safeCpus / 2)),
    compilePhase: [
      { label: "check:acpx-profiles", command: node, args: ["scripts/generate-acpx-profiles.mjs", "--check"], cwd: packageRoot },
      { label: "cargo:fmt", command: "cargo", args: ["fmt", "--manifest-path", "runner/Cargo.toml", "--all", "--", "--check"], cwd: packageRoot },
      {
        label: "cargo:test-no-run",
        command: "cargo",
        args: [
          "test",
          "--release",
          "--manifest-path",
          "runner/Cargo.toml",
          "--locked",
          "--workspace",
          "--no-run",
          "--message-format=json-render-diagnostics",
        ],
        cwd: packageRoot,
      },
    ],
    docTestCommand: {
      label: "cargo:test-doc",
      command: "cargo",
      args: ["test", "--release", "--manifest-path", "runner/Cargo.toml", "--locked", "--workspace", "--doc"],
      cwd: packageRoot,
    },
    requiredParityTests: [...REQUIRED_PARITY_TESTS],
  };
}

export function parseCargoTestArtifacts(jsonLinesText) {
  const testBinaries = [];
  const seenExecutables = new Set();
  const binEnv = {};

  for (const rawLine of jsonLinesText.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== "compiler-artifact" || !message.executable) continue;
    const kinds = Array.isArray(message.target?.kind) ? message.target.kind : [];
    const name = String(message.target?.name ?? path.basename(message.executable));
    const manifestDir = message.manifest_path ? path.dirname(message.manifest_path) : packageRoot;

    if (message.profile?.test === true) {
      if (seenExecutables.has(message.executable)) continue;
      seenExecutables.add(message.executable);
      testBinaries.push({
        name,
        kinds,
        executable: message.executable,
        manifestDir,
        label: kinds.includes("lib") ? `${name} (lib)` : name,
      });
    } else if (kinds.includes("bin")) {
      binEnv[`CARGO_BIN_EXE_${name}`] = message.executable;
    }
  }

  return { testBinaries, binEnv };
}

export function orderTestBinariesLpt(testBinaries) {
  return [...testBinaries].sort((a, b) => {
    const pa = LPT_PRIORITY.get(a.name) ?? 0;
    const pb = LPT_PRIORITY.get(b.name) ?? 0;
    if (pa !== pb) return pb - pa;
    return a.label.localeCompare(b.label);
  });
}

export function verifyRequiredParityTests(combinedOutput, requiredFilters = REQUIRED_PARITY_TESTS) {
  const missing = [];
  for (const filter of requiredFilters) {
    const escaped = filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const okPattern = new RegExp(`test\\s+\\S*${escaped}\\S*\\s+\\.\\.\\.\\s+ok\\b`);
    if (!okPattern.test(combinedOutput)) missing.push(filter);
  }
  return missing;
}

export async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const slots = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: slots }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

export function formatCargoCompilerDiagnostics(stdout) {
  const rendered = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason === "compiler-message" && typeof message.message?.rendered === "string") {
      rendered.push(message.message.rendered);
    }
  }
  return rendered.length > 0 ? rendered.join("") : stdout;
}

function splitOutput(chunks) {
  const stdout = Buffer.concat(chunks.filter((c) => c.stream === "stdout").map((c) => c.chunk)).toString("utf8");
  const stderr = Buffer.concat(chunks.filter((c) => c.stream === "stderr").map((c) => c.chunk)).toString("utf8");
  return { stdout, stderr };
}

async function executeRunnerCheck(plan) {
  installSignalHandlers();
  try {
    const compileStart = Date.now();
    console.log("[check:runner] phase=compile-and-lint mode=parallel");
    const compileResults = await Promise.all(
      plan.compilePhase.map((step) => runCommand(step, { bufferOutput: true })),
    );
    if (getShutdownPromise()) {
      await getShutdownPromise();
      return;
    }
    const parsedCompile = compileResults.map((result) => ({ ...result, ...splitOutput(result.chunks) }));
    for (const result of parsedCompile) {
      console.log(`[check:runner] --- ${result.label} (${(result.durationMs / 1000).toFixed(1)}s, exit=${result.code}) ---`);
      if (result.label !== "cargo:test-no-run" && result.stdout) process.stdout.write(result.stdout);
      if (result.label === "cargo:test-no-run" && result.code !== 0 && result.stdout) {
        process.stderr.write(formatCargoCompilerDiagnostics(result.stdout));
      }
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) console.error(`[check:runner] ${result.label} spawn error: ${result.error.message}`);
    }
    const compileFailure = parsedCompile.find((result) => result.code !== 0);
    if (compileFailure) {
      console.error(`[check:runner] FAILED ${compileFailure.label} (exit=${compileFailure.code})`);
      process.exit(compileFailure.code);
    }

    const cargoResult = parsedCompile.find((result) => result.label === "cargo:test-no-run");
    const { testBinaries, binEnv } = parseCargoTestArtifacts(cargoResult.stdout);
    if (testBinaries.length === 0) {
      console.error("[check:runner] FAILED: cargo test --no-run produced zero test executables");
      process.exit(1);
    }
    const ordered = orderTestBinariesLpt(testBinaries);
    console.log(
      `[check:runner] phase=compile-and-lint done (${((Date.now() - compileStart) / 1000).toFixed(1)}s, ` +
        `${ordered.length} test binaries discovered)`,
    );

    const testStart = Date.now();
    console.log(`[check:runner] phase=execute-tests concurrency=${plan.binaryConcurrency}`);
    const testSteps = [
      ...ordered.map((binary) => {
        const threads = SINGLE_THREAD_BINARIES.has(binary.name)
          ? 1
          : binary.name === "codex_provider"
            ? plan.heavyTestThreads
            : plan.defaultTestThreads;
        return {
          label: binary.label,
          command: binary.executable,
          args: ["--test-threads", String(threads)],
          cwd: binary.manifestDir,
          env: {
            ...process.env,
            ...binEnv,
            CARGO_MANIFEST_DIR: binary.manifestDir,
          },
        };
      }),
      {
        ...plan.docTestCommand,
        env: process.env,
      },
    ];

    const testResults = await runWithConcurrency(testSteps, plan.binaryConcurrency, async (step) => {
      if (getShutdownPromise()) {
        return { label: step.label, code: 143, durationMs: 0, stdout: "", stderr: "" };
      }
      const raw = await runCommand(step, { bufferOutput: true, env: step.env });
      const { stdout, stderr } = splitOutput(raw.chunks);
      const result = { ...raw, stdout, stderr };
      const summary = stdout.match(/test result: .*/)?.[0] ?? "";
      if (result.code !== 0 || result.durationMs >= 1000 || summary) {
        console.log(
          `[check:runner] ${result.code === 0 ? "PASS" : "FAIL"} ${result.label} ` +
            `(${(result.durationMs / 1000).toFixed(2)}s)${summary ? ` — ${summary}` : ""}`,
        );
      }
      if (result.code !== 0) {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (result.error) console.error(`[check:runner] ${result.label} spawn error: ${result.error.message}`);
      }
      return result;
    });

    if (getShutdownPromise()) {
      await getShutdownPromise();
      return;
    }

    const firstFailure = testResults.find((result) => result.code !== 0);
    if (firstFailure) {
      console.error(`[check:runner] FAILED ${firstFailure.label} (exit=${firstFailure.code})`);
      process.exit(firstFailure.code);
    }

    const combinedOutput = testResults.map((result) => result.stdout).join("\n");
    const missingParity = verifyRequiredParityTests(combinedOutput, plan.requiredParityTests);
    if (missingParity.length > 0) {
      console.error(
        `[check:runner] FAILED: required parity test(s) did not pass in workspace run: ${missingParity.join(", ")}`,
      );
      process.exit(1);
    }

    console.log(
      `[check:runner] phase=execute-tests done (${((Date.now() - testStart) / 1000).toFixed(1)}s; ` +
        `parity verified: ${plan.requiredParityTests.join(", ")})`,
    );
  } finally {
    uninstallSignalHandlers();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`[check:runner] unrecognized argument(s): ${unknown.join(" ")}`);
    process.exit(1);
  }
  const plan = buildRunnerCheckPlan();
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await executeRunnerCheck(plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
