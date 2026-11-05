// Independent, credential-free admission for the native completion comparison.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  NATIVE_COMPLETION_SOURCE_CONTRACT, NATIVE_COMPLETION_SOURCE_FILES,
  nativeCompletionSourceFingerprint, nativeSourceSha256,
} from "./native-completion-source-contract.mjs";

import { inspectNativeCompletionSourceMetadata, inspectNativeCompletionRunnerd, NATIVE_COMPLETION_RUNNERD_PATH } from "./native-completion-git-source.mjs";

const root = resolve(import.meta.dirname, "../..");
export const NATIVE_COMPLETION_PREFLIGHT_SCHEMA = "paperclip.native-completion-preflight.v1";
export const NATIVE_COMPLETION_CELL_IDS = ["runner-codex", "runner-acpx-claude", "runner-opencode"].flatMap(profile =>
  ["assigned-skill-explicit-invocation", "native-blocked-report"].map(task => `native-completion.${profile}.local.${task}`));
export function nativeCompletionGates(variant) {
  if (!["candidate", "historical"].includes(variant)) throw new Error("Unknown native completion source variant");
  return [
    { id: "NC-schemas", name: "Variant-native completion schemas", cwd: "packages/paperclip-runner",
      files: ["src/contracts/completion-result.test.ts"],
      required: ["distinguishes user-facing answer content", "propagates answer and wait descriptions", "requires a reason code for verification that was not run"] },
    { id: "NC-tools", name: "Native tool delivery and retained provider catalogs", cwd: "packages/paperclip-runner", files: [
      "src/drivers/codex/codex-app-server-driver.lifecycle.test.ts", "src/drivers/runner-tool-bridge.test.ts",
      "src/drivers/opencode/mcp-bridge.test.ts", "src/live/runnerd-codex-transport.test.ts"],
      testPattern: "binds to loopback|preserves stock Codex instructions on|includes ACPX terminal tools|preserves answer and internal wait descriptions",
      required: ["runner semantic MCP bridge binds to loopback", "OpenCode MCP bridge binds to loopback",
        "preserves stock Codex instructions on task recovery", "preserves stock Codex instructions on prepared recovery",
        "preserves stock Codex instructions on direct recovery", "includes ACPX terminal tools in the authenticated bridge catalog",
        ...(variant === "candidate" ? ["codex", "opencode", "claude_managed", "aws_agentcore", "acpx"].map(provider =>
          `preserves answer and internal wait descriptions in the serialized native ${provider} tool catalog`) : [])] },
    { id: "NC-resume", name: "Variant-native fingerprint and checkpoint refresh", cwd: ".",
      files: ["server/src/services/native-runtime/native-session-resume.test.ts"], testPattern: "refreshes retained",
      required: ["refreshes retained 'completion descriptions'", "refreshes retained 'task-bound human-input description'",
        ...(variant === "candidate" ? ["native completion tool guidance"] : [])] },
    { id: "NC-eval", name: "Independent native oracle, defaults, admission and attempt policy", cwd: ".",
      config: "tests/runner-e2e/vitest.config.ts", files: [
        "tests/runner-e2e/native-completion-scoring.test.ts", "tests/runner-e2e/native-completion-defaults.test.ts",
        "tests/runner-e2e/native-completion-admission.test.ts", "tests/runner-e2e/automatic-retry.test.ts",
        "tests/runner-e2e/context-integrity.test.ts", "tests/runner-e2e/context-integrity-evidence.test.ts",
        "tests/runner-e2e/context-integrity-flow-logs.test.ts"],
      required: ["allows toolchain paths and excludes every present or future credential",
        "retains credential-free prerequisites inside the exact campaign root",
        "retains the first transient_infrastructure failure without a second attempt",
        "retains the first provider_variance failure without a second attempt"] },
  ];
}
export const NATIVE_COMPLETION_COMMAND_GATE_IDS = ["NC-node", "NC-typecheck", "NC-manifest", "NC-discovery", "NC-rust-carrier"];
export function nativeCompletionCommandGateIds(mode) {
  return NATIVE_COMPLETION_COMMAND_GATE_IDS.map(id => mode === "trusted_hosted_archive" && id === "NC-rust-carrier" ? "NC-hosted-runnerd" : id);
}
export function gradeNativeCompletionGate(gate, report, exitCode) {
  const assertions = (report?.testResults ?? []).flatMap(file => file.assertionResults ?? []);
  const requirements = gate.required.map(name => ({ name, passed: assertions.some(assertion =>
    assertion.fullName?.includes(name) && assertion.status === "passed") }));
  const files = gate.files.map(file => ({ file, passed: (report?.testResults ?? []).some(result =>
    result.name?.endsWith(file) && result.status === "passed" && result.assertionResults?.some(assertion => assertion.status === "passed") &&
    result.assertionResults.every(assertion => assertion.status === "passed" || (gate.testPattern && assertion.status === "skipped" &&
      !gate.required.some(name => assertion.fullName?.includes(name))))) }));
  return { id: gate.id, name: gate.name, passed: exitCode === 0 && requirements.every(row => row.passed) && files.every(row => row.passed),
    exitCode, files, requirements, total: report?.numTotalTests ?? 0, passedTests: report?.numPassedTests ?? 0,
    failedTests: report?.numFailedTests ?? 0, pendingTests: report?.numPendingTests ?? 0 };
}

export function gradeNativeCompletionDiscovery(output, exitCode) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const rows = lines.slice(1).map(line => line.split("\t"));
  const ids = rows.map(row => row[0]);
  return { passed: exitCode === 0 && lines[0] === "ID\tSUITE\tGENERATION\tPROVIDER\tMODEL\tCREDENTIALS" &&
    rows.length === 6 && new Set(ids).size === 6 && NATIVE_COMPLETION_CELL_IDS.every(id => ids.includes(id)) &&
    rows.every(row => row.length === 6 && row[1] === "native-completion" && row[2] === "native" && row[4]?.trim() && row[5]?.trim()),
    executionIds: ids, expectedCells: 6, expectedTurns: 6, maximumAttemptsPerCell: 1 };
}
/** capture() stores compact provenance JSON on its first line, then diagnostics. */
export function gradeNativeCompletionHostedRunnerdEvidence(text, expected) {
  try { return JSON.stringify(JSON.parse(text.split(/\r?\n/, 1)[0])) === JSON.stringify(expected); }
  catch { return false; }
}
export function gradeNativeCompletionRustCarrier(output, exitCode) {
  return exitCode === 0 && /^test provider_events::tests::preserves_closed_compatibility_terminal_tool_identity \.\.\. ok$/m.test(output) &&
    /test result: ok\. 1 passed; 0 failed;/.test(output);
}
export function nativeCompletionPrerequisiteEnvironment(source) {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL",
    "CARGO_HOME", "RUSTUP_HOME", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "PAPERCLIP_RUNNER_E2E_SOURCE_SHA"].flatMap(name => source[name] === undefined ? [] : [[name, source[name]]]));
}
function currentSource() {
  const source = nativeCompletionSourceFingerprint();
  return { ...source, ...inspectNativeCompletionSourceMetadata({ repositoryRoot: root,
    sourceFiles: NATIVE_COMPLETION_SOURCE_FILES, baseSha: source.baseSha, variant: source.variant,
    shallowParentAnchors: NATIVE_COMPLETION_SOURCE_CONTRACT.shallowParentAnchors,
  }) };
}
function buildOutputFingerprint() {
  const hash = createHash("sha256");
  function visit(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(relative, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) { const bytes = readFileSync(join(root, file)); hash.update(JSON.stringify([file, bytes.length])).update(bytes); }
      else throw new Error(`Unexpected build output: ${file}`);
    }
  }
  for (const directory of ["packages/shared/dist", "packages/plugins/sdk/dist", "packages/paperclip-runner/dist"]) {
    if (!existsSync(join(root, directory, "index.js"))) throw new Error(`Missing prerequisite build output: ${directory}`);
    visit(directory);
  }
  const daemon = runnerdBinary();
  const bytes = readFileSync(daemon);
  hash.update(JSON.stringify(["debug/paperclip-runnerd", bytes.length])).update(bytes);
  return hash.digest("hex");
}
function runnerdBinary() {
  return join(root, `${NATIVE_COMPLETION_RUNNERD_PATH}${process.platform === "win32" ? ".exe" : ""}`);
}
function runnerdProvenance(source, env) {
  return inspectNativeCompletionRunnerd({ repositoryRoot: root, sourceSha: source.sha,
    sourceFingerprint: source.fingerprint, environment: env });
}
export function assertNativeCompletionPreflightReceipt(report, current) {
  const expected = [...nativeCompletionGates(current.variant).map(gate => gate.id), ...nativeCompletionCommandGateIds(current.runnerdProvenance?.mode)];
  const hostedGate = report?.gates?.find(gate => gate.id === "NC-hosted-runnerd");
  const truthfulHosted = current.runnerdProvenance?.mode !== "trusted_hosted_archive" ||
    hostedGate?.executed === false && hostedGate?.calibration === "not_executed" && hostedGate?.total === 0 &&
    hostedGate?.passedTests === 0 && hostedGate?.reuse === "trusted_same_run_build";
  if (!truthfulHosted || report?.schema !== NATIVE_COMPLETION_PREFLIGHT_SCHEMA || report.passed !== true || report.providerCalls !== 0 ||
      report.live !== "not_run" || report.sourceSha !== current.sha || !/^[a-f0-9]{40}$/.test(current.sha ?? "") ||
      ![current.fingerprint, current.fixtureFingerprint, current.manifestFingerprint, current.buildOutputFingerprint]
        .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
      report.sourceFingerprint !== current.fingerprint || report.fixtureFingerprint !== current.fixtureFingerprint ||
      report.manifestFingerprint !== current.manifestFingerprint || report.variant !== current.variant ||
      report.baseSha !== NATIVE_COMPLETION_SOURCE_CONTRACT.baseSha || report.archiveSha !== NATIVE_COMPLETION_SOURCE_CONTRACT.archiveSha ||
      report.layering !== true || current.layering !== true || report.immutable !== true || current.immutable !== true ||
      !/^[a-f0-9]{64}$/.test(current.sourceMetadataFingerprint ?? "") ||
      report.sourceMetadataFingerprint !== current.sourceMetadataFingerprint ||
      !Array.isArray(report.sourceMetadataErrors) || report.sourceMetadataErrors.length !== 0 || current.sourceMetadataErrors?.length !== 0 ||
      !Array.isArray(report.sourceErrors) || report.sourceErrors.length !== 0 || current.sourceErrors?.length !== 0 ||
      report.setup?.passed !== true || report.setup.sdkExitCode !== 0 || report.setup.runnerTypeScriptExitCode !== 0 ||
      report.setup.runnerdExitCode !== (current.runnerdProvenance?.mode === "trusted_hosted_archive" ? null : 0) ||
      current.runnerdProvenance?.passed !== true || !["trusted_hosted_archive", "fresh_local_build"].includes(current.runnerdProvenance?.mode) ||
      JSON.stringify(report.setup.runnerdProvenance) !== JSON.stringify(current.runnerdProvenance) ||
      report.setup.runnerdSelectedPath !== current.runnerdProvenance.selectedPath ||
      report.setup.runnerdSha256 !== current.runnerdProvenance.binarySha256 ||
      !/^[a-f0-9]{64}$/.test(current.runnerdProvenance.binarySha256 ?? "") ||
      report.setup.runnerdSourceSha !== current.sha || report.setup.runnerdSourceFingerprint !== current.fingerprint ||
      report.setup.buildOutputFingerprint !== current.buildOutputFingerprint ||
      !Array.isArray(report.setup.evidence) || report.setup.evidence.length !== 3 ||
      ["setup-sdk.txt", "setup-runner-typescript.txt", "setup-runnerd.txt"].some(file => report.setup.evidence.filter(row =>
        row.file === file && /^[a-f0-9]{64}$/.test(row.sha256 ?? "")).length !== 1) ||
      !Array.isArray(report.gates) || report.gates.length !== expected.length ||
      expected.some(id => report.gates.filter(gate => gate.id === id && gate.passed === true && gate.exitCode === 0).length !== 1) ||
      report.expectedCells !== 6 || report.expectedTurns !== 6 || report.maximumAttemptsPerCell !== 1) {
    throw new Error("Native completion requires passing prerequisites for this exact immutable source SHA, variant and fingerprint.");
  }
  return report;
}
function runCommand(command, args, env, timeout = 10 * 60_000, cwd = root) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8", timeout });
}
function capture(output, name, run) {
  const file = `${name}.txt`, bytes = `${run?.stdout ?? ""}\n${run?.stderr ?? ""}`;
  writeFileSync(join(output, file), bytes);
  return { file, sha256: nativeSourceSha256(bytes) };
}
export function assertRetainedNativeCompletionEvidence(output, evidence) {
  if (!evidence || typeof evidence.file !== "string" || !/^[A-Za-z0-9_.-]+$/.test(evidence.file) ||
      nativeSourceSha256(readFileSync(join(output, evidence.file))) !== evidence.sha256)
    throw new Error("Native completion retained prerequisite evidence changed or is unavailable.");
  return readFileSync(join(output, evidence.file), "utf8");
}
function manifestCommands(env) {
  return ["generate-capability-contract.mjs", "check-capability-inventory.mjs"].map(file => runCommand(process.execPath,
    [join(root, "packages/paperclip-runner/scripts", file), ...(file.startsWith("generate-") ? ["--check"] : [])], env));
}

export function main(args = process.argv.slice(2)) {
  if (args.includes("--list")) {
    console.log(JSON.stringify({ variants: ["candidate", "historical"], gates: nativeCompletionGates("candidate"),
      commands: { local: nativeCompletionCommandGateIds("fresh_local_build"), hosted: nativeCompletionCommandGateIds("trusted_hosted_archive") },
      cells: NATIVE_COMPLETION_CELL_IDS, providerCalls: 0 }, null, 2)); return;
  }
  if (args.some(arg => !arg.startsWith("--output-dir=") && !arg.startsWith("--verify=")))
    throw new Error("Use --list, --output-dir=<path> or --verify=<receipt>; never paid providers.");
  const source = currentSource(), env = nativeCompletionPrerequisiteEnvironment(process.env);
  const verify = args.find(arg => arg.startsWith("--verify="))?.slice("--verify=".length);
  if (verify) {
    const report = assertNativeCompletionPreflightReceipt(JSON.parse(readFileSync(verify, "utf8")), {
      ...source, buildOutputFingerprint: buildOutputFingerprint(), runnerdProvenance: runnerdProvenance(source, env),
    });
    const output = resolve(verify, "..");
    for (const evidence of report.setup.evidence) assertRetainedNativeCompletionEvidence(output, evidence);
    for (const gate of nativeCompletionGates(source.variant)) {
      const retained = report.gates.find(row => row.id === gate.id);
      const grade = gradeNativeCompletionGate(gate, JSON.parse(assertRetainedNativeCompletionEvidence(output, retained.evidence)), 0);
      if (!grade.passed) throw new Error(`Missing or failed retained native prerequisite assertions: ${gate.id}`);
    }
    for (const id of nativeCompletionCommandGateIds(report.setup.runnerdProvenance.mode)) {
      const retained = report.gates.find(row => row.id === id), text = assertRetainedNativeCompletionEvidence(output, retained.evidence);
      if (id === "NC-node" && (!/# fail 0\b/.test(text) || !/# tests [1-9]\d*\b/.test(text)))
        throw new Error("Missing passing native admission calibrations.");
      if (id === "NC-discovery" && !gradeNativeCompletionDiscovery(text.split("\n\n")[0], 0).passed)
        throw new Error("Native completion six-cell discovery changed.");
      if (id === "NC-rust-carrier" && !gradeNativeCompletionRustCarrier(text, 0))
        throw new Error("Missing passing retained Rust terminal-tool carrier calibration.");
      if (id === "NC-hosted-runnerd" && (retained.executed !== false || retained.calibration !== "not_executed" ||
          retained.total !== 0 || retained.passedTests !== 0 ||
          !gradeNativeCompletionHostedRunnerdEvidence(text, report.setup.runnerdProvenance)))
        throw new Error("Hosted runnerd reuse must retain exact binary proof and report Rust calibration not executed.");
      if (id === "NC-manifest" && manifestCommands(env).some(run => run.status !== 0))
        throw new Error("Generated native capability manifests are stale.");
    }
    console.log(JSON.stringify(report)); return report;
  }
  const output = resolve(args.find(arg => arg.startsWith("--output-dir="))?.slice("--output-dir=".length) ??
    join(root, "tests/runner-e2e/results", `native-completion-preflight-${new Date().toISOString().replaceAll(":", "-")}`));
  mkdirSync(output, { recursive: true });
  const report = { schema: NATIVE_COMPLETION_PREFLIGHT_SCHEMA, sourceSha: source.sha, sourceFingerprint: source.fingerprint,
    fixtureFingerprint: source.fixtureFingerprint, manifestFingerprint: source.manifestFingerprint,
    variant: source.variant, baseSha: source.baseSha, archiveSha: source.archiveSha,
    sourceErrors: source.sourceErrors, immutable: source.immutable, layering: source.layering,
    sourceMetadata: source.sourceMetadata, sourceMetadataErrors: source.sourceMetadataErrors,
    sourceMetadataFingerprint: source.sourceMetadataFingerprint,
    measuredAt: new Date().toISOString(), providerCalls: 0, live: "not_run", expectedCells: 6, expectedTurns: 6, maximumAttemptsPerCell: 1,
    setup: { passed: false, sdkExitCode: null, runnerTypeScriptExitCode: null, runnerdExitCode: null, evidence: [] }, gates: [], passed: false };
  if (!source.sha || source.sourceErrors.length || !source.layering || !source.immutable) {
    writeFileSync(join(output, "preflight.json"), JSON.stringify(report, null, 2) + "\n");
    console.error(`Native completion source admission failed before providers: ${[...source.sourceErrors, ...source.sourceMetadataErrors].join("; ")}`);
    process.exitCode = 1; return report;
  }
  const sdk = runCommand(process.execPath, [join(root, "scripts/ensure-plugin-build-deps.mjs")], env, 5 * 60_000);
  report.setup.sdkExitCode = sdk.status; report.setup.evidence.push(capture(output, "setup-sdk", sdk));
  const runner = sdk.status === 0 ? runCommand("pnpm", ["--filter", "@paperclipai/paperclip-runner", "build:typescript"], env) : null;
  report.setup.runnerTypeScriptExitCode = runner?.status ?? null;
  report.setup.evidence.push(capture(output, "setup-runner-typescript", runner));
  const hosted = env.GITHUB_ACTIONS === "true";
  const runnerd = sdk.status === 0 && runner?.status === 0 && !hosted ? runCommand("cargo",
    ["build", "--locked", "--offline", "--workspace", "--bins"], env,
    10 * 60_000, join(root, "packages/paperclip-runner/runner")) : null;
  report.setup.runnerdExitCode = runnerd?.status ?? null;
  report.setup.runnerdProvenance = runnerdProvenance(source, env);
  report.setup.evidence.push(capture(output, "setup-runnerd", hosted
    ? { stdout: JSON.stringify(report.setup.runnerdProvenance), stderr: "Rust build and unit calibration not executed in this hosted cell; reusing trusted same-run build." }
    : runnerd));
  report.setup.passed = sdk.status === 0 && runner?.status === 0 && (hosted || runnerd?.status === 0) && report.setup.runnerdProvenance.passed;
  if (report.setup.passed) {
    report.setup.buildOutputFingerprint = buildOutputFingerprint();
    report.setup.runnerdSha256 = report.setup.runnerdProvenance.binarySha256;
    report.setup.runnerdSelectedPath = report.setup.runnerdProvenance.selectedPath;
    report.setup.runnerdSourceSha = source.sha;
    report.setup.runnerdSourceFingerprint = source.fingerprint;
    for (const gate of nativeCompletionGates(source.variant)) {
      console.log(`Checking ${gate.id}: ${gate.name}`);
      const file = `${gate.id}.json`, run = runCommand(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...gate.files,
        ...(gate.config ? ["--config", gate.config] : []), ...(gate.testPattern ? ["--testNamePattern", gate.testPattern] : []),
        "--reporter=default", "--reporter=json", `--outputFile.json=${join(output, file)}`], env, 10 * 60_000, resolve(root, gate.cwd));
      capture(output, gate.id, run);
      let result; try { result = JSON.parse(readFileSync(join(output, file), "utf8")); } catch { /* Missing discovery fails closed. */ }
      report.gates.push({ ...gradeNativeCompletionGate(gate, result, run.status),
        evidence: existsSync(join(output, file)) ? { file, sha256: nativeSourceSha256(readFileSync(join(output, file))) } : null });
    }
    const commands = [
      { id: "NC-node", command: process.execPath, args: ["--test", "--test-reporter=tap", "tests/runner-e2e/native-completion-checks.test.mjs", "tests/runner-e2e/native-completion-source-contract.test.mjs", "tests/runner-e2e/native-completion-git-source.test.mjs"] },
      { id: "NC-typecheck", command: process.execPath, args: ["node_modules/typescript/bin/tsc", "-p", "tests/runner-e2e/tsconfig.json"] },
      ...(!hosted ? [{ id: "NC-rust-carrier", command: "cargo", args: ["test", "--locked", "--offline",
        "-p", "paperclip-runner-core", "--lib", "provider_events::tests::preserves_closed_compatibility_terminal_tool_identity", "--", "--exact"],
        cwd: join(root, "packages/paperclip-runner/runner") }] : []),
      { id: "NC-discovery", command: process.execPath, args: ["--import", "./server/node_modules/tsx/dist/loader.mjs", "tests/runner-e2e/launch.ts", "--list", "--suite", "native-completion"] },
    ];
    for (const command of commands) {
      console.log(`Checking ${command.id}`);
      const run = runCommand(command.command, command.args, env, 10 * 60_000, command.cwd ?? root);
      report.gates.push({ id: command.id, passed: run.status === 0 &&
        (command.id !== "NC-discovery" || gradeNativeCompletionDiscovery(run.stdout, run.status).passed) &&
        (command.id !== "NC-rust-carrier" || gradeNativeCompletionRustCarrier(`${run.stdout ?? ""}\n${run.stderr ?? ""}`, run.status)) &&
        (command.id !== "NC-node" || /# fail 0\b/.test(run.stdout) && /# tests [1-9]\d*\b/.test(run.stdout)),
        exitCode: run.status, evidence: capture(output, command.id, run) });
    }
    if (hosted) report.gates.push({ id: "NC-hosted-runnerd", name: "Trusted hosted runnerd provenance; Rust calibration not executed",
      passed: report.setup.runnerdProvenance.passed, exitCode: 0, executed: false, calibration: "not_executed",
      reuse: "trusted_same_run_build", total: 0, passedTests: 0, evidence: capture(output, "NC-hosted-runnerd", {
        stdout: JSON.stringify(report.setup.runnerdProvenance), stderr: "Rust unit calibration must be qualified by the separate exact-source local receipt and normal CI." }) });
    const manifest = manifestCommands(env), combined = { stdout: manifest.map(run => run.stdout ?? "").join("\n"), stderr: manifest.map(run => run.stderr ?? "").join("\n") };
    report.gates.push({ id: "NC-manifest", passed: manifest.every(run => run.status === 0),
      exitCode: manifest.find(run => run.status !== 0)?.status ?? 0, evidence: capture(output, "NC-manifest", combined) });
    const after = currentSource();
    report.passed = report.gates.every(gate => gate.passed) && after.immutable && after.layering &&
      after.sha === source.sha && after.fingerprint === source.fingerprint && after.sourceErrors.length === 0 &&
      after.sourceMetadataFingerprint === source.sourceMetadataFingerprint && after.sourceMetadataErrors.length === 0 &&
      buildOutputFingerprint() === report.setup.buildOutputFingerprint &&
      JSON.stringify(runnerdProvenance(after, env)) === JSON.stringify(report.setup.runnerdProvenance);
  }
  writeFileSync(join(output, "preflight.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Native completion prerequisite evidence: ${join(output, "preflight.json")}`);
  if (!report.passed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
