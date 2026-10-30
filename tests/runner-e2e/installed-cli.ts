/** Optional published-install lane. No production hook or admission override. */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { CREDENTIAL_NAMES, type MatrixExecution } from "./types.js";

export const installedCliKeys = ["PAPERCLIP_RUNNER_E2E_INSTALLED_CLI", "PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256", "PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT", "PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256"] as const;
const overrideKeys = ["PAPERCLIP_RUNNER_BINARY", "PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "PAPERCLIP_RUNNER_ACPX_QUALIFICATION", "PAPERCLIP_ACPX_BUILTIN_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST"] as const;
const suites = new Set(["extended-harnesses", "pi-native", "pi-controls", "rich-acp-warm-continuity"]);
const installedCodexCells = new Set([
  "first-task.runner-codex.local.task-card-accept",
  "everyday-workflows.runner-codex.local.build-revise",
  "agent-chat.runner-codex.local.continuity-restart",
  "everyday-workflows.runner-codex.daytona.recover-controller",
]);
const installedCopilotCells = new Set([
  "copilot-protection.runner-acpx-copilot.daytona.attached-async-settlement",
  "copilot-protection.runner-acpx-copilot.daytona.native-permission-deny-write",
  "copilot-protection.runner-acpx-copilot.local.attached-async-settlement",
  "copilot-protection.runner-acpx-copilot.local.native-permission-deny-write",
  "copilot-provider-death.runner-acpx-copilot.daytona.pending-permission-provider-death",
  "copilot-provider-death.runner-acpx-copilot.local.pending-permission-provider-death",
  "extended-harnesses.runner-acpx-copilot.daytona.file-edit-validate",
  "extended-harnesses.runner-acpx-copilot.daytona.hello-complete",
  "extended-harnesses.runner-acpx-copilot.daytona.plan-approve-complete",
  "extended-harnesses.runner-acpx-copilot.daytona.question-resume-complete",
  "extended-harnesses.runner-acpx-copilot.daytona.structured-question-restart-resume",
  "extended-harnesses.runner-acpx-copilot.local.file-edit-validate",
  "extended-harnesses.runner-acpx-copilot.local.hello-complete",
  "extended-harnesses.runner-acpx-copilot.local.plan-approve-complete",
  "extended-harnesses.runner-acpx-copilot.local.question-resume-complete",
  "extended-harnesses.runner-acpx-copilot.local.structured-question-restart-resume",
  "native-active-stop.runner-acpx-copilot.daytona.pending-permission-stop",
  "native-active-stop.runner-acpx-copilot.local.pending-permission-stop",
  "rich-acp-warm-continuity.runner-acpx-copilot.daytona.warm-three-turn",
  "rich-acp-warm-continuity.runner-acpx-copilot.local.warm-three-turn",
]);
export function usesInstalledCli(env: NodeJS.ProcessEnv): boolean {
  return installedCliKeys.some(key => env[key] !== undefined);
}
export function assertInstalledCliSelection(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[]): void {
  if (!usesInstalledCli(env)) return;
  if (!installedCliKeys.every(key => Boolean(env[key])) || executions.length === 0 || executions.some(e => !(
    (e.profile.id === "runner-acpx-pi" && e.profile.qualificationCandidate === "pi" && e.suite.manualOnly && suites.has(e.suite.id)) ||
    (e.profile.id === "runner-codex" && e.profile.provider === "codex" && installedCodexCells.has(e.id)) ||
    (e.profile.id === "runner-acpx-copilot" && e.profile.qualificationCandidate === "copilot" && e.suite.manualOnly && installedCopilotCells.has(e.id))
  ))) throw new Error("Installed CLI proof requires complete pins and explicit supported Pi, Codex, or Copilot cases");
  for (const key of overrideKeys) if (env[key] !== undefined) throw new Error(`Installed CLI proof forbids ${key}`);
  if (env.NODE_OPTIONS !== undefined || env.NODE_PATH !== undefined) throw new Error("Installed CLI proof forbids ambient Node injection");
}
async function readOwned(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) throw new Error("Installed CLI proof requires a bounded regular file");
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink() || bytes.length !== Number(before.size)) throw new Error("Installed CLI proof file changed during admission");
    return bytes;
  } finally { await handle.close(); }
}
export async function verifyInstalledCli(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[]) {
  if (!usesInstalledCli(env)) return undefined;
  assertInstalledCliSelection(env, executions);
  const entry = env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI!;
  const serverRoot = env.PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT!;
  for (const path of [entry, serverRoot]) if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error("Installed CLI proof paths must be canonical and unlinked");
  if (!entry.endsWith("/dist/index.js")) throw new Error("Installed CLI proof requires published dist/index.js");
  const cliRoot = resolve(dirname(entry), "..");
  const cli = JSON.parse((await readOwned(join(cliRoot, "package.json"), 65536)).toString());
  const manifest = findPackageJSON("@paperclipai/server", pathToFileURL(entry));
  if (!manifest || await realpath(manifest) !== join(serverRoot, "package.json")) throw new Error("Installed CLI resolved a foreign server dependency");
  const server = JSON.parse((await readOwned(join(serverRoot, "package.json"), 65536)).toString());
  if (cli.name !== "paperclipai" || cli.bin?.paperclipai !== "./dist/index.js" || server.name !== "@paperclipai/server" || typeof cli.version !== "string" || cli.version !== server.version || server.exports?.["."]?.import !== "./dist/index.js") throw new Error("Installed CLI/server public package identity differs");
  const serverEntry = join(serverRoot, "dist/index.js");
  if (await realpath(serverEntry) !== serverEntry) throw new Error("Installed server entrypoint escapes its package");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const cliSha256 = digest(await readOwned(entry, 64 * 1024 * 1024));
  const serverSha256 = digest(await readOwned(serverEntry, 16 * 1024 * 1024));
  if (cliSha256 !== env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256 || serverSha256 !== env.PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256) throw new Error("Installed CLI/server bytes differ from their reviewed pins");
  return { schema: "paperclip.e2e.installed-cli-admission/v1", entry, cliRoot, cliSha256, serverRoot, serverEntry, serverSha256, version: cli.version, defaultRuntimeResolution: true, qualificationOverride: false };
}

export async function probeInstalledCodexStartup(input: {
  consumerRoot: string;
  serverRoot: string;
  expectedRunnerSha256: string;
  timeoutMs?: number;
}) {
  for (const key of [...overrideKeys, "NODE_OPTIONS", "NODE_PATH"]) {
    if (process.env[key] !== undefined) throw new Error(`Installed Codex startup forbids ${key}`);
  }
  const inside = (root: string, filename: string) => {
    const name = relative(root, filename);
    return name !== "" && name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
  };
  for (const filename of [input.consumerRoot, input.serverRoot]) {
    if (!isAbsolute(filename) || resolve(filename) !== filename || await realpath(filename) !== filename) throw new Error("Installed Codex startup paths must be canonical and unlinked");
  }
  if (!inside(join(input.consumerRoot, "node_modules"), input.serverRoot) || !/^[a-f0-9]{64}$/.test(input.expectedRunnerSha256)) throw new Error("Installed Codex startup requires a contained server and reviewed daemon digest");
  const manifest = JSON.parse((await readOwned(join(input.serverRoot, "package.json"), 65536)).toString());
  if (manifest.name !== "@paperclipai/server" || manifest.exports?.["."]?.import !== "./dist/index.js") throw new Error("Installed Codex startup requires the published server");
  const vendorRoot = join(input.serverRoot, "dist/vendor/paperclip-runner");
  const entries = [join(vendorRoot, "index.js"), join(input.serverRoot, "dist/services/native-runtime/native-codex-runner.js")];
  for (const filename of entries) if (await realpath(filename) !== filename) throw new Error("Installed Codex startup runtime escapes its package");
  const [runtime, production] = await Promise.all(entries.map(filename => import(pathToFileURL(filename).href)));
  const runnerBinary = await realpath(production.resolvePaperclipRunnerBinary());
  if (runnerBinary !== join(vendorRoot, "bin", `${process.platform}-${process.arch}`, "paperclip-runnerd")) throw new Error("Installed Codex startup requires the normal platform daemon; no source or flat fallback");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const runnerSha256 = digest(await readOwned(runnerBinary, 512 * 1024 * 1024));
  if (runnerSha256 !== input.expectedRunnerSha256) throw new Error("Installed Codex startup daemon differs from its reviewed pin");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-codex-startup-")));
  const home = join(directory, "home"), codexHome = join(directory, "codex-home"), workspace = join(directory, "workspace");
  for (const filename of [home, codexHome, workspace]) await mkdir(filename, { mode: 0o700 });
  const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`, HOME: home, CODEX_HOME: codexHome,
    TMPDIR: directory, LC_ALL: "C", TZ: "UTC", PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled" };
  let session: any;
  let bundle: any;
  let cleanupConfirmed = false;
  let startupFailed = false;
  let startupFailure: unknown;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Installed Codex startup timed out")), Math.max(1, Math.min(input.timeoutMs ?? 45000, 120000)));
  try {
    const codexCommand = await realpath(runtime.resolveCodexCommand(undefined, environment, workspace));
    if (!inside(join(input.consumerRoot, "node_modules"), codexCommand)) throw new Error("Installed Codex startup resolved an ambient Codex executable");
    const codexSha256 = digest(await readOwned(codexCommand, 512 * 1024 * 1024));
    const codexVersion = execFileSync(codexCommand, ["--version"], { cwd: workspace, env: environment, encoding: "utf8", timeout: 10000, maxBuffer: 16384 }).trim();
    if (!codexVersion || codexVersion.length > 200) throw new Error("Installed Codex startup returned no bounded version identity");
    const args = runtime.createIsolatedCodexAppServerArgs(environment);
    args.splice(args.indexOf("app-server"), 0, "-c", 'cli_auth_credentials_store="file"');
    bundle = runtime.createRunnerdCodexTransport({ provider: "codex", stateDirectory: directory, environment,
      sourceCodexHome: "", runnerBinary, codexCommand, codexArgs: args, closeGraceMs: 10000,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } });
    const driver = new runtime.CodexAppServerDriver({
      taskEnvelope: { schema: "paperclip.skillless_task.v1", objective: "Credential-free installed startup proof.",
        completionContract: { revision: "installed-startup-v1", criteria: [] }, constraints: [], expectedResultSchema: "paperclip.run_result.v1" },
      model: "gpt-5.6-sol", conversationMode: "direct", requestedCollaborationMode: "plan", approvalPolicy: "never",
      includeCollaborationModeInstructions: false, dynamicTools: [], environment,
      transportFactory: () => bundle.transport, requireProviderSessionIdentity: true,
    });
    session = await driver.openSession({ runId: "installed-startup", normalizedSessionId: "installed-startup", workingDirectory: workspace, signal: controller.signal });
    const event = await session.events()[Symbol.asyncIterator]().next();
    const identity = session.ids();
    const evidence = bundle.evidence();
    if (event.value?.eventType !== "session.started" || event.value.payload?.context?.model !== "gpt-5.6-sol" ||
      event.value.payload?.context?.sandbox?.permissionProfile?.id !== "paperclip-runner-workspace-read-only" ||
      !identity.driverSessionId || !identity.providerSessionId || evidence.providerDriver !== "codex_app_server" ||
      !(evidence.runnerPid > 0) || !(evidence.codexPid > 0)) throw new Error("Installed Codex startup returned no matching native identity or read-only model context");
    await session.close({ reason: "credential-free installed startup complete" });
    session = undefined;
    if (!bundle.evidence().runnerExited) throw new Error("Installed Codex startup cleanup is incomplete");
    cleanupConfirmed = true;
    return { schema: "paperclip.e2e.installed-codex-startup/v1", platform: `${process.platform}-${process.arch}`,
      runnerSha256, codexSha256, codexVersion, providerDriver: "codex_app_server", model: "gpt-5.6-sol",
      nativeSessionStarted: true, cleanupConfirmed: true, providerTurns: 0, credentialsUsed: false,
      defaultRuntimeResolution: true, reasoningEffortExercised: false };
  } catch (error) {
    startupFailed = true;
    startupFailure = error;
    throw error;
  } finally {
    clearTimeout(timer);
    const cleanupFailures: unknown[] = [];
    try {
      if (session) await session.close({ reason: "installed startup cleanup" });
      else if (bundle && !cleanupConfirmed) await bundle.transport.close("installed startup cleanup");
    } catch (error) { cleanupFailures.push(error); }
    try {
      if (!bundle || bundle.evidence().runnerExited) await rm(directory, { recursive: true, force: true });
    } catch (error) { cleanupFailures.push(error); }
    if (startupFailed) {
      const evidence = bundle?.evidence();
      const bounded = (value: unknown) => String(value).replaceAll(directory, "[private-startup]").slice(0, 2000);
      const primaryMessage = bounded(startupFailure instanceof Error ? startupFailure.message : startupFailure);
      const diagnostic = { schema: "paperclip.e2e.installed-codex-startup-failure/v1", platform: `${process.platform}-${process.arch}`,
        runnerExited: evidence?.runnerExited ?? null, runnerExitCode: evidence?.runnerExitCode ?? null,
        runnerSignal: evidence?.runnerSignal ?? null,
        diagnostics: (Array.isArray(evidence?.diagnostics) ? evidence.diagnostics : []).slice(-16).map(bounded),
        cleanupFailures: cleanupFailures.map(error => bounded(error instanceof Error ? error.message : error)) };
      throw new AggregateError([startupFailure, ...cleanupFailures], `Installed Codex startup failed: ${primaryMessage}\n${JSON.stringify(diagnostic)}`, { cause: startupFailure });
    }
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Installed Codex startup cleanup failed", { cause: cleanupFailures[0] });
  }
}

/** This prep lane cannot create agents or read the normal local credential file. */
export function assertInstalledStartupOnly(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[], options: { ids: string[]; maxParallel: number; maxAutomaticRetries: number; headed: boolean; ui: boolean; debug: boolean; list: boolean; matrixJson: boolean }) {
  assertInstalledCliSelection(env, executions);
  if (!usesInstalledCli(env) || executions.length !== 1 || executions[0]?.id !== "extended-harnesses.runner-acpx-pi.local.hello-complete" || options.ids.length !== 1 || options.ids[0] !== executions[0]?.id || options.maxParallel !== 1 || options.maxAutomaticRetries !== 0 || options.headed || options.ui || options.debug || options.list || options.matrixJson) throw new Error("Installed startup-only requires one explicit local Pi hello, no retries or interactive mode");
  if (CREDENTIAL_NAMES.some(key => env[key] !== undefined) || Object.keys(env).some(key => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA|XAI|GROK|CURSOR|COPILOT|GITHUB|GH)(?:_|$)/.test(key) && env[key] !== undefined)) throw new Error("Installed startup-only forbids provider credential inputs");
}
