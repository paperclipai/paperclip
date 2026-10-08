// Deterministic prerequisite for the stock-harness Product E2E suite. No model
// calls or credentials. Reuse the existing protocol assertions, not model
// self-reports about what its system instructions contain.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStockInstructionVariant } from "./stock-harness-instruction-variant.mjs";

const root = resolve(import.meta.dirname, "../..");
export const stockHarnessGates = [
  { id: "SH-1", name: "Native Codex additive instructions", cwd: "packages/paperclip-runner", files: [
    "src/drivers/codex/codex-app-server-driver.test.ts",
    "src/drivers/codex/codex-app-server-driver.lifecycle.test.ts",
    "src/live/runnerd-codex-transport.test.ts",
    "src/live/live-session.test.ts",
    "src/cli/eval-provider-runtime.test.ts",
  ], testPattern: "adds Paperclip developer instructions|preserves stock Codex instructions|captures exact provider frames and correlates|direct eval provider runtime|exposes native completion consistently on fresh and resumed sessions|passes caller-supplied native system instructions",
  required: ["adds Paperclip developer instructions", "preserves stock Codex instructions on task recovery",
    "preserves stock Codex instructions on prepared recovery", "preserves stock Codex instructions on direct recovery",
    "captures exact provider frames and correlates", "exposes native completion consistently on fresh and resumed sessions",
    "passes caller-supplied native system instructions"] },
  { id: "SH-2", name: "Production-default hire bundle", cwd: ".", files: [
    "server/src/__tests__/agent-skills-routes.test.ts",
    "server/src/services/onboarding-first-task-assets.test.ts",
  ], required: ["materializes minimal default instructions for non-CEO agents with no prompt template"] },
  { id: "SH-3", name: "Shared legacy startup and continuation", cwd: ".", files: [
    "packages/adapter-utils/src/server-utils.test.ts",
    "packages/adapter-utils/src/prompt-sections.test.ts",
    "packages/adapter-utils/src/acpx-engine/execute.test.ts",
    "packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.test.ts",
    "packages/adapters/pi-local/src/server/execute.remote.test.ts",
    "packages/adapters/opencode-local/src/server/execute.test.ts",
    "packages/adapters/cursor-cloud/src/server/execute.test.ts",
    "server/src/__tests__/codex-local-execute.test.ts",
  ], required: ["keeps task and chat defaults to identity and connection guidance",
    "does not restore generic procedures on resume or with the legacy opt-in",
    "integrates the env-free store", "advertises folded routing metadata", "bounds routing descriptions",
    "loads an old env-bearing file with rotated credentials", "drops a skill that fails to materialize"] },
  // Hermes is not in the root Vitest project list. Run its package config so
  // the requested file cannot silently disappear from discovery.
  { id: "SH-3-hermes", name: "Hermes shared-prompt delivery", cwd: "packages/adapters/hermes",
    files: ["src/server/prompt-rendering.test.ts"],
    required: ["renders standard assignment wake with task authority", "renders scoped planning wake authority"] },
  { id: "SH-eval", name: "Independent oracle and qualification admission", cwd: ".",
    config: "tests/runner-e2e/vitest.config.ts",
    files: ["tests/runner-e2e/stock-harness-manifest.test.ts", "tests/runner-e2e/paperclip-document.test.ts", "tests/runner-e2e/stock-harness.test.ts", "tests/runner-e2e/stock-harness-checks.test.mjs",
      "tests/runner-e2e/stock-harness-admission.test.ts", "tests/runner-e2e/stock-harness-digest.test.ts",
      "tests/runner-e2e/select-rerun-artifacts.test.ts", "tests/runner-e2e/stock-harness-instruction-variant.test.mjs", "tests/runner-e2e/automatic-retry.test.ts"],
    required: ["requires generated capability manifests for the current skill sources", "the shipped recipe delivers the current", "the shipped recipe supports an unnumbered issue", "rejects old SHA before providers", "allows toolchain paths and excludes every present or future credential",
      "changes when the evaluated server/src/onboarding-assets/default/AGENTS.md changes",
      "changes when the evaluated packages/adapter-utils/src/server-utils.ts changes",
      "changes when the evaluated packages/shared/src/connection-intent-guidance.ts changes",
      "retains credential-free prerequisites inside the exact campaign root"] },
];

export function stockHarnessGatesForVariant(variant) {
  if (variant !== "reduced" && variant !== "historical") throw new Error("Unknown stock instruction variant.");
  return stockHarnessGates.map(gate => variant !== "historical" ? gate : {
    ...gate,
    required: gate.required.map(name => name === "materializes minimal default instructions for non-CEO agents with no prompt template"
      ? "materializes the bundled default instruction set for non-CEO agents with no prompt template"
      : name === "keeps task and chat defaults to identity and connection guidance"
        ? "keeps the default local-agent prompt action-oriented"
        : name === "does not restore generic procedures on resume or with the legacy opt-in"
          ? "adds the execution contract to resume delta prompts and opted-in fresh prompts" : name),
  });
}

export function gradeGate(gate, report, exitCode) {
  const assertions = (report?.testResults ?? []).flatMap(file => file.assertionResults ?? []);
  const requirements = (gate.required ?? []).map(name => ({ name,
    passed: assertions.some(assertion => assertion.fullName?.includes(name) && assertion.status === "passed") }));
  const files = gate.files.map(file => ({ file,
    passed: (report?.testResults ?? []).some(result => result.name?.endsWith(file) && result.status === "passed" &&
      result.assertionResults?.some(assertion => assertion.status === "passed") &&
      result.assertionResults.every(assertion => assertion.status === "passed" ||
        (gate.testPattern && assertion.status === "skipped" && !(gate.required ?? []).some(name => assertion.fullName?.includes(name))))) }));
  return { id: gate.id, name: gate.name, passed: exitCode === 0 && requirements.every(row => row.passed) && files.every(row => row.passed),
    exitCode, files, requirements, total: report?.numTotalTests ?? 0, passedTests: report?.numPassedTests ?? 0,
    failedTests: report?.numFailedTests ?? 0, pendingTests: report?.numPendingTests ?? 0 };
}

export function sourceFingerprint() {
  const hash = createHash("sha256");
  const sources = new Set([
    ...stockHarnessGates.flatMap(gate => gate.files.map(file => join(gate.cwd, file))),
    "tests/runner-e2e/stock-harness.ts", "tests/runner-e2e/stock-harness-checks.mjs", "tests/runner-e2e/catalog.ts",
    "tests/runner-e2e/stock-harness-admission.ts", "tests/runner-e2e/launch.ts", "tests/runner-e2e/runner.spec.ts",
    "tests/runner-e2e/stock-harness-instruction-variant.mjs", "tests/runner-e2e/stock-harness-instruction-variant.d.mts", "tests/runner-e2e/fixtures/stock-harness/historical-default-agents.md",
    "tests/runner-e2e/automatic-retry.ts", "tests/runner-e2e/types.ts",
    "packages/adapter-utils/src/acpx-engine/execute.ts", "packages/adapter-utils/src/acpx-engine/ephemeral-session-environment.ts",
    "tests/runner-e2e/context-integrity-cases.ts", "tests/runner-e2e/context-integrity-flow.ts", "tests/runner-e2e/context-integrity-scoring.ts",
    "tests/runner-e2e/stock-harness-manifest.ts", "packages/paperclip-runner/scripts/generate-capability-contract.mjs",
    "packages/paperclip-runner/spec/capability/source-contract.json",
    "packages/paperclip-runner/scripts/check-capability-inventory.mjs", "packages/paperclip-runner/scripts/lib/capability-inventory.mjs",
    "packages/paperclip-runner/spec/capability/capabilities.yaml", "packages/paperclip-runner/spec/capability/eval-traceability.yaml",
    "packages/paperclip-runner/spec/capability/mcp-tool-map.yaml", "packages/paperclip-runner/spec/capability/inventory.schema.json",
    "packages/paperclip-runner/src/generated/capability-contract.ts", "packages/paperclip-runner/docs/capability-contract.md",
    ...["capabilities.yaml", "mcp-tool-map.yaml", "eval-traceability.yaml", "capability-contract.md", "downstream-handoff.md"]
      .map(file => `packages/paperclip-runner/generated/capability/${file}`),
    "packages/adapter-utils/src/server-utils.ts", "packages/shared/src/connection-intent-guidance.ts",
    "server/src/onboarding-assets/default/AGENTS.md", "server/src/routes/agents.ts", "scripts/ensure-plugin-build-deps.mjs",
    "packages/paperclip-runner/src/drivers/codex/codex-app-server-driver-impl.ts",
    "packages/paperclip-runner/src/live/runnerd-codex-transport.ts",
    "packages/paperclip-runner/src/live/live-session.ts",
    "packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs",
    "packages/paperclip-runner/runner/crates/runner-core/src/bin/fake-codex-app-server.rs",
    "packages/paperclip-runner/runner/Cargo.toml", "packages/paperclip-runner/runner/Cargo.lock",
    "packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
    "packages/paperclip-runner/runner/crates/runner-core/tests/codex_provider.rs",
  ]);
  const sourceErrors = [];
  sources.add("skills/paperclip/SKILL.md");
  sources.add("skills/paperclip/references/issue-documents.md");
  for (const source of [...sources].sort()) {
    hash.update(source);
    try { hash.update("present\0").update(readFileSync(join(root, source))); }
    catch (error) {
      if (source === "skills/paperclip/references/issue-documents.md" && error.code === "ENOENT") hash.update("absent\0");
      else sourceErrors.push(source);
    }
  }
  return { fingerprint: hash.digest("hex"), sourceErrors };
}

export function assertPreflightReceipt(report, current) {
  const instructionVariant = readStockInstructionVariant();
  const expected = [...stockHarnessGates.map(gate => gate.id), "SH-1-rust"];
  if (report?.schema !== "paperclip.stock-harness-preflight.v3" || report.passed !== true ||
      report.setup?.passed !== true || report.setup?.exitCode !== 0 ||
      report.setup?.sdkExitCode !== 0 || report.setup?.runnerdExitCode !== 0 ||
      report.setup?.runnerdSha256 !== current.runnerdSha256 ||
      report.setup?.fakeCodexSha256 !== current.fakeCodexSha256 ||
      report.providerCalls !== 0 || report.sourceSha !== current.sha ||
      report.sourceFingerprint !== current.fingerprint || report.sourceErrors?.length !== 0 ||
      report.instructionVariant?.variant !== instructionVariant.variant || report.instructionVariant?.sha256 !== instructionVariant.sha256 ||
      !Array.isArray(report.gates) || report.gates.length !== expected.length ||
      expected.some(id => report.gates.filter(gate => gate.id === id && gate.passed === true && gate.exitCode === 0).length !== 1)) {
    throw new Error("Stock harness requires passing prerequisites for this exact source SHA and fingerprint.");
  }
  return report;
}

export function main(args = process.argv.slice(2)) {
  const { variant, sha256 } = readStockInstructionVariant();
  const instructionVariant = { variant, sha256 };
  const gates = stockHarnessGatesForVariant(variant);
  if (args.includes("--list")) {
    console.log(JSON.stringify({ gates, instructionVariant, rust: "runtime_instructions_are_additive_for_codex_on_start_and_resume", live: "not invoked" }, null, 2));
    return;
  }
  if (args.some(arg => !arg.startsWith("--output-dir=") && !arg.startsWith("--verify=") && arg !== "--allow-rust-network"))
    throw new Error("Use --list, --output-dir=<path>, --verify=<receipt>, or --allow-rust-network; never paid providers.");
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const verify = args.find(arg => arg.startsWith("--verify="))?.slice("--verify=".length);
  if (verify) {
    const source = sourceFingerprint();
    if (git.status !== 0 || source.sourceErrors.length) throw new Error("Cannot verify stock harness source provenance.");
    const report = assertPreflightReceipt(JSON.parse(readFileSync(verify, "utf8")), {
      sha: git.stdout.trim(), fingerprint: source.fingerprint,
      runnerdSha256: createHash("sha256").update(readFileSync(join(root,
        "packages/paperclip-runner/runner/target/debug", `paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`))).digest("hex"),
      fakeCodexSha256: createHash("sha256").update(readFileSync(join(root,
        "packages/paperclip-runner/runner/target/debug/fake-codex-app-server"))).digest("hex"),
    });
    const output = resolve(verify, "..");
    for (const gate of gates) {
      const grade = gradeGate(gate, JSON.parse(readFileSync(join(output, `${gate.id}.json`), "utf8")), 0);
      if (!grade.passed) throw new Error(`Missing or failed retained prerequisite assertions: ${gate.id}`);
    }
    if (!/test runtime_instructions_are_additive_for_codex_on_start_and_resume \.\.\. ok/.test(readFileSync(join(output, "rust.txt"), "utf8")))
      throw new Error("Missing passing retained Rust prerequisite.");
    console.log(JSON.stringify(report));
    return report;
  }
  const output = args.find(arg => arg.startsWith("--output-dir="))?.slice("--output-dir=".length) ??
    join(root, "tests/runner-e2e/results", `stock-harness-preflight-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(output, { recursive: true });
  const env = Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL",
    "CARGO_HOME", "RUSTUP_HOME", "CI", "GITHUB_ACTIONS",
  ].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  // A protected cold install disables lifecycle scripts. Use the same ordinary
  // SDK dependency builder as server startup, before importing server tests.
  const setupRun = spawnSync(process.execPath, [join(root, "scripts/ensure-plugin-build-deps.mjs")], {
    cwd: root, env, encoding: "utf8", timeout: 5 * 60_000,
  });
  writeFileSync(join(output, "setup.txt"), `${setupRun.stdout ?? ""}\n${setupRun.stderr ?? ""}`);
  // The exact daemon-frame test uses the real local Rust daemon. Legacy cold
  // cells do not download native artifacts, so compile it before TS discovery.
  const runnerd = setupRun.status === 0 ? spawnSync("cargo", ["build", "--locked",
    ...(args.includes("--allow-rust-network") ? [] : ["--offline"]),
    "--workspace", "--bins"], {
    cwd: join(root, "packages/paperclip-runner/runner"), env, encoding: "utf8", timeout: 10 * 60_000,
  }) : null;
  writeFileSync(join(output, "runnerd-build.txt"), `${runnerd?.stdout ?? ""}\n${runnerd?.stderr ?? ""}`);
  const setup = { passed: setupRun.status === 0 && runnerd?.status === 0,
    exitCode: setupRun.status !== 0 ? setupRun.status : runnerd?.status ?? null,
    sdkExitCode: setupRun.status, runnerdExitCode: runnerd?.status ?? null };
  if (!setup.passed) {
    const source = sourceFingerprint();
    writeFileSync(join(output, "preflight.json"), JSON.stringify({
      schema: "paperclip.stock-harness-preflight.v3", instructionVariant, sourceSha: git.stdout?.trim() || null,
      sourceFingerprint: source.fingerprint, measuredAt: new Date().toISOString(), providerCalls: 0,
      live: "not_run", passed: false, sourceErrors: source.sourceErrors, setup, gates: [],
    }, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }
  const runnerdBinary = join(root, "packages/paperclip-runner/runner/target/debug",
    `paperclip-runnerd${process.platform === "win32" ? ".exe" : ""}`);
  setup.runnerdSha256 = createHash("sha256").update(readFileSync(runnerdBinary)).digest("hex");
  setup.fakeCodexSha256 = createHash("sha256").update(readFileSync(join(root,
    "packages/paperclip-runner/runner/target/debug/fake-codex-app-server"))).digest("hex");
  const results = [];
  for (const gate of gates) {
    console.log(`Checking ${gate.id}: ${gate.name}`);
    const file = join(output, `${gate.id}.json`);
    const run = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...gate.files,
      ...(gate.config ? ["--config", gate.config] : []),
      ...(gate.testPattern ? ["--testNamePattern", gate.testPattern] : []),
      "--reporter=default", "--reporter=json", `--outputFile.json=${file}`],
    { cwd: resolve(root, gate.cwd),
      env: gate.id === "SH-1" ? { ...env, PAPERCLIP_STOCK_PREFLIGHT_RUNNERD: runnerdBinary } : env,
      stdio: "inherit", timeout: 10 * 60_000 });
    let report;
    try { report = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing evidence fails closed below */ }
    results.push(gradeGate(gate, report, run.status));
  }
  const rust = spawnSync("cargo", ["test", ...(args.includes("--allow-rust-network") ? [] : ["--offline"]), "-p", "paperclip-runner-core", "--test", "codex_provider",
    "runtime_instructions_are_additive_for_codex_on_start_and_resume", "--", "--exact"],
  { cwd: join(root, "packages/paperclip-runner/runner"), env, encoding: "utf8", timeout: 10 * 60_000 });
  const rustOutput = `${rust.stdout ?? ""}\n${rust.stderr ?? ""}`;
  writeFileSync(join(output, "rust.txt"), rustOutput);
  results.push({ id: "SH-1-rust", passed: rust.status === 0 && /test runtime_instructions_are_additive_for_codex_on_start_and_resume \.\.\. ok/.test(rustOutput), exitCode: rust.status });
  const { fingerprint, sourceErrors } = sourceFingerprint();
  const report = { schema: "paperclip.stock-harness-preflight.v3", instructionVariant, sourceSha: git.stdout?.trim() || null,
    sourceFingerprint: fingerprint, measuredAt: new Date().toISOString(), providerCalls: 0,
    live: "not_run", passed: git.status === 0 && sourceErrors.length === 0 && results.every(row => row.passed), sourceErrors, setup, gates: results };
  writeFileSync(join(output, "preflight.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Stock harness prerequisite evidence: ${output}/preflight.json`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
