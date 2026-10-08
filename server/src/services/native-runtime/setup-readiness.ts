import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { copyBackGrokAuth, resolveManagedGrokHomeDir } from "@paperclipai/adapter-grok-local/server";
import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { runAdapterExecutionTargetShellCommand } from "@paperclipai/adapter-utils/execution-target";
import { QUALIFIED_ACPX_PROFILES, acpxRuntimeSessionDirectoryName, probeQualifiedAcpxEnvironment, probeNativeRunnerEnvironment, bundledRemoteRunnerBinary, readRunnerdArtifactBinding, resolveSourceCodexHome } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerBinary } from "./native-codex-runner.js";
import { prepareGrokRunnerCredentials } from "./grok-runner-credentials.js";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { resolvePaperclipRunnerTransport } from "@paperclipai/adapter-utils/runner-connectivity";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";

const execFileAsync = promisify(execFile);
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export interface RemoteNativeSetupArtifacts {
  runnerBinary: string;
  controllerRunnerBinary: string;
  providerPackRoot: string;
  codexCommand?: string;
  manifest: ReturnType<typeof import("./native-session-executor.js").readRemoteProviderPackManifest>;
  /** Controller-only proof that provider teardown and credential handoff settled. */
  onCleanupConfirmed?: () => void;
}

/** Prepare the task's exact artifacts on an owned root, before any account probe. */
export async function withRemoteNativeSetupArtifacts(
  context: AdapterEnvironmentTestContext,
  provider: "codex" | "opencode" | "acpx",
  model: string | null,
  probe: (artifacts?: RemoteNativeSetupArtifacts) => Promise<AdapterEnvironmentTestResult>,
): Promise<AdapterEnvironmentTestResult> {
  const target = context.executionTarget;
  // SSH Codex already owns its task preparation and confirmed cleanup below.
  if (target?.kind !== "remote" || (target.transport === "ssh" && provider === "codex")) return probe();
  let claimedRoot: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let probeStarted = false;
  let probeCleanupConfirmed = false;
  let result: AdapterEnvironmentTestResult;
  const redact = (message: string) => redactNativeProbeMessage(message,
    Object.fromEntries(Object.entries(context.config.env && typeof context.config.env === "object" && !Array.isArray(context.config.env) ? context.config.env : {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  try {
    const runner = target.transport === "ssh" ? createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd }) : target.runner;
    if (!runner) throw new Error("runner_transport_ineligible: remote process runner is unavailable");
    const { createRemoteNativeArtifactPreparation, createRemoteProviderPackPreparation, readRemoteProviderPackManifest, readBundledRemoteProviderPackManifest } = await import("./native-session-executor.js");
    const configuredPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim() || null;
    const manifest = configuredPack ? readRemoteProviderPackManifest(configuredPack) : readBundledRemoteProviderPackManifest();
    const explicitRunner = process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH?.trim() || null;
    const controllerRunnerBinary = explicitRunner || (configuredPack ? resolvePaperclipRunnerBinary() : bundledRemoteRunnerBinary());
    // Validate controller identity before writing to the selected environment.
    readRunnerdArtifactBinding(controllerRunnerBinary);
    const platform = await runner.execute({ command: "sh", args: ["-c", "uname -s && uname -m"], cwd: target.remoteCwd, bypassSession: true, timeoutMs: 15_000 });
    const [os, arch] = platform.stdout.trim().split(/\s+/);
    if (platform.timedOut || platform.exitCode !== 0 || ({ Linux: "linux", Darwin: "darwin" } as Record<string, string>)[os] !== manifest.payload.target.platform
      || ({ x86_64: "x64", arm64: "arm64" } as Record<string, string>)[arch] !== manifest.payload.target.architecture) {
      throw new Error("runner_remote_provider_artifact_incompatible: the controller provider pack does not match the selected environment platform. Configure PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH with its qualified build-owned pack.");
    }
    const remoteRoot = posix.join(target.remoteCwd, ".paperclip-runtime", `paperclip-native-setup-${crypto.randomUUID()}`);
    const runnerBinary = posix.join(remoteRoot, "bin", "paperclip-runnerd");
    const providerPackRoot = posix.join(remoteRoot, "provider-pack");
    const codexNpmSpec = process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC?.trim() || null;
    const codexCommand = provider === "codex" ? (codexNpmSpec
      ? posix.join(remoteRoot, "harnesses", "codex", "node_modules", ".bin", "codex")
      : posix.join(remoteRoot, "bin", "codex")) : undefined;
    const nativeArtifacts = createRemoteNativeArtifactPreparation({ target, runner, remoteBinary: runnerBinary, controllerRunnerBinary, remoteRuntimeRoot: remoteRoot,
      remoteCodexBinary: codexCommand, runnerRemoteBinaryPath: explicitRunner, runnerRemoteCodexPath: process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH?.trim(), runnerRemoteCodexNpmSpec: codexNpmSpec, model: provider === "codex" ? model : null });
    const providerArtifacts = createRemoteProviderPackPreparation({ target, runner, manifest, configuredProviderPackRoot: configuredPack, stagedRemoteProviderPackRoot: providerPackRoot });
    const created = await runner.execute({ command: "sh", args: ["-c", `set -eu; umask 077; mkdir -p -- ${shellQuote(posix.dirname(remoteRoot))}; test -d ${shellQuote(posix.dirname(remoteRoot))} && test ! -L ${shellQuote(posix.dirname(remoteRoot))}; mkdir -m 0700 -- ${shellQuote(remoteRoot)}`], cwd: target.remoteCwd, bypassSession: true, timeoutMs: 10_000 });
    if (created.timedOut || created.exitCode !== 0) throw new Error("Native setup could not claim a private runtime directory in the selected environment.");
    claimedRoot = remoteRoot;
    cleanup = async () => {
      const cleaned = await runner.execute({ command: "rm", args: ["-rf", "--", remoteRoot], cwd: target.remoteCwd, bypassSession: true, timeoutMs: 10_000 });
      if (cleaned.timedOut || cleaned.exitCode !== 0) throw new Error("Native setup artifact cleanup is incomplete; private recovery state was retained.");
    };
    await nativeArtifacts.prepare(target.transport === "sandbox" && target.effectiveCapabilities?.runnerWebSocketIngress === true ? "listen_ws" : "dial_wss");
    await providerArtifacts.prepare();
    probeStarted = true;
    result = await probe({ runnerBinary, controllerRunnerBinary, providerPackRoot, manifest, ...(codexCommand ? { codexCommand } : {}),
      onCleanupConfirmed: () => { probeCleanupConfirmed = true; } });
  } catch (error) {
    result = { adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: "paperclip_runner_runtime_unavailable", level: "error",
      message: redact(error instanceof Error ? error.message : "The selected environment could not prepare the native runtime."),
      hint: "Check the controller's matching runner and provider-pack artifacts and the selected environment's upload capability. Legacy runner is available explicitly in Advanced." }] };
  }
  if (!cleanup || !claimedRoot) return result;
  const hint = redact(`Private recovery directory on the selected environment: ${claimedRoot}. Confirm provider teardown and credential handoff before removing this directory.`);
  // Artifact preparation starts no account probe. Once entered, only explicit
  // production teardown/copy-back proof permits deleting the claimed root.
  if (probeStarted && !probeCleanupConfirmed) {
    return { ...result, status: "fail", checks: [...result.checks, { code: "paperclip_runner_setup_state_retained", level: "error",
      message: "Native setup private recovery state was retained because provider teardown or credential handoff was not confirmed.", hint }] };
  }
  try {
    await cleanup();
  } catch {
    return { ...result, status: "fail", checks: [...result.checks, { code: "paperclip_runner_setup_cleanup_failed", level: "error",
      message: "Native setup artifact cleanup is incomplete; private recovery state was retained.", hint }] };
  }
  return result;
}

/** Check the selected runtime as well as the separate provider authentication probe. */
export async function assertNativeRunnerSetupReady(context: AdapterEnvironmentTestContext, artifacts?: RemoteNativeSetupArtifacts): Promise<void> {
  let stdout: string;
  if (context.executionTarget?.kind === "remote") {
    const probe = await runAdapterExecutionTargetShellCommand(
      `runner-setup-${crypto.randomUUID()}`,
      context.executionTarget,
      artifacts ? shellQuote(artifacts.runnerBinary) + ' --build-metadata' : 'for runner in /opt/paperclip-runner/bin/paperclip-runnerd "$HOME/.local/bin/paperclip-runnerd"; do if [ -x "$runner" ]; then exec "$runner" --build-metadata; fi; done; exec paperclip-runnerd --build-metadata',
      { cwd: context.executionTarget.remoteCwd, env: {}, timeoutSec: 15 },
    );
    if (probe.timedOut || probe.exitCode !== 0) {
      throw new Error("Paperclip Runner could not start in the selected environment. Install the runner in that environment or select Legacy runner in Advanced.");
    }
    stdout = probe.stdout;
  } else {
    const result = await execFileAsync(resolvePaperclipRunnerBinary(), ["--build-metadata"], { timeout: 15_000 });
    stdout = result.stdout;
  }
  const metadata = JSON.parse(stdout) as { binaryName?: string; prp?: { minimumVersion?: number; maximumVersion?: number } };
  if (metadata.binaryName !== "paperclip-runnerd" || !metadata.prp || (metadata.prp.minimumVersion ?? 2) > 1 || (metadata.prp.maximumVersion ?? 0) < 1) {
    throw new Error("The installed Paperclip Runner is incompatible with this server. Update the runner or select Legacy runner in Advanced.");
  }
}

/** Probe the installed provider pack on the selected target, without credentials. */
export async function assertRemoteAcpxSetupReady(context: AdapterEnvironmentTestContext, agent: "claude" | "grok" | "cursor", model: string, artifacts?: RemoteNativeSetupArtifacts): Promise<void> {
  if (context.executionTarget?.kind !== "remote") return;
  const expected = QUALIFIED_ACPX_PROFILES[agent];
  const script = `
    const { pathToFileURL } = await import('node:url');
    const root = process.argv[1];
    const agent = process.argv[2];
    const model = process.argv[3];
    const expected = JSON.parse(process.argv[4]);
    const profiles = await import(pathToFileURL(root + '/dist/drivers/acpx/qualified-profiles.js'));
    const actual = profiles.QUALIFIED_ACPX_PROFILES[agent];
    for (const key of ['commandDigest', 'acpxVersion', 'agentServerVersion', 'agentRuntimeVersion']) {
      if (actual?.[key] !== expected[key]) throw new Error('Provider pack does not match this Paperclip release');
    }
    const probes = await import(pathToFileURL(root + '/dist/drivers/acpx/' + (agent === 'cursor' ? 'profile-installation' : 'installation-integrity') + '.js'));
    await probes[{claude:'probeAcpxClaudeInstallation',grok:'probeAcpxGrokInstallation',cursor:'probeAcpxCursorInstallation'}[agent]](model);
  `;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = (artifacts ? 'pack=' + quote(artifacts.providerPackRoot) + '; ' : 'for pack in /opt/paperclip-runner/provider-pack "$HOME/.local/share/paperclip-runner/provider-pack"; do if [ -f "$pack/provider-pack.json" ]; then ') + 'exec "$pack/node_modules/node/bin/node" --input-type=module -e '
    + quote(script) + ' "$pack" ' + [agent, model, JSON.stringify(expected)].map(quote).join(' ')
    + (artifacts ? '' : '; fi; done; echo "Qualified provider pack is missing" >&2; exit 1');
  const result = await runAdapterExecutionTargetShellCommand(`provider-setup-${crypto.randomUUID()}`, context.executionTarget, command,
    { cwd: context.executionTarget.remoteCwd, env: {}, timeoutSec: 30 });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`The selected environment could not verify the ${agent} runtime. Install the current Paperclip provider pack and its provider prerequisites, or select Legacy runner in Advanced. ${result.stderr.trim().slice(-1024)}`);
  }
}

const PROBE_TRANSPORT_ENV_KEYS = ["PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"];

function redactNativeProbeMessage(message: string, environment: Record<string, string>): string {
  const redact = (value: unknown): void => {
    if (typeof value === "string" && value) message = message.replaceAll(value, "[REDACTED]");
    else if (value && typeof value === "object") for (const item of Object.values(value)) redact(item);
  };
  for (const [name, value] of Object.entries(environment)) {
    if (!/key|token|secret|password/i.test(name) || !value) continue;
    redact(value);
    try { redact(JSON.parse(value)); } catch { /* Most credentials are plain strings. */ }
  }
  return message.slice(0, 2000);
}

function nativeProbeFailureMessage(probe: { stdout: string; stderr: string }, environment: Record<string, string>): string {
  // Sandbox one-shot execution returns combined output as stdout. Preserve its
  // failure detail without exposing bound credentials or unbounded output.
  return redactNativeProbeMessage(probe.stderr.trim() || probe.stdout.trim()
    || "The selected native runtime could not verify this account.", environment);
}

/** SSH setup shares task artifacts, transport, isolated launch home, and process ownership. */
async function probeSshNativeCodex(options: {
  context: AdapterEnvironmentTestContext;
  model: string | null;
  reasoningEffort?: string;
  environment: Record<string, string>;
  sourceCodexHome: string;
  timeoutMs: number;
}) {
  const target = options.context.executionTarget;
  if (target?.kind !== "remote" || target.transport !== "ssh") throw new Error("Native SSH setup requires the selected SSH execution target.");
  const { createRemoteNativeArtifactPreparation, createRemoteRunnerProcessLauncher, stageRemoteRunnerFile, readRemoteRunnerState } = await import("./native-session-executor.js");
  const runner = createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd });
  const id = crypto.randomUUID();
  const runnerInstanceId = `setup-${id}`;
  // Eligibility is checked before writing to the selected host, using the
  // same server-owned public URL and CA configuration as ordinary tasks.
  const transport = await resolvePaperclipRunnerTransport({ target, runId: id, localConnectUrl: "ws://127.0.0.1/unused",
    runnerPublicUrl: process.env.PAPERCLIP_RUNNER_PUBLIC_URL?.trim() || null,
    runnerCaBundlePath: process.env.PAPERCLIP_RUNNER_CA_BUNDLE_PATH?.trim() || null, runnerIngressAuthorized: false });
  if (transport.mode !== "direct_outbound") throw new Error("Native SSH setup requires its qualified outbound runner transport.");
  if (transport.caBundlePath) await stat(transport.caBundlePath).catch(() => { throw new Error("runner_direct_wss_failed: configured runner CA bundle is unavailable"); });
  const remoteRoot = posix.join(target.remoteCwd, ".paperclip-runtime", `paperclip-native-setup-${id}`);
  const remoteBinary = posix.join(remoteRoot, "bin", "paperclip-runnerd");
  const remoteStateDirectory = posix.join(remoteRoot, "runner");
  const remoteFilesystemRoot = posix.join(remoteRoot, "filesystem");
  const remoteWorkspace = posix.join(remoteFilesystemRoot, "workspace");
  const remoteCodexNpmSpec = process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC?.trim() || null;
  const remoteCodexBinary = remoteCodexNpmSpec ? posix.join(remoteRoot, "harnesses", "codex", "node_modules", ".bin", "codex") : posix.join(remoteRoot, "bin", "codex");
  const explicitRunner = process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH?.trim() || null;
  const controllerRunnerBinary = explicitRunner || resolvePaperclipRunnerBinary();
  const artifacts = createRemoteNativeArtifactPreparation({ target, runner, remoteBinary, controllerRunnerBinary, remoteRuntimeRoot: remoteRoot, remoteCodexBinary,
    runnerRemoteBinaryPath: explicitRunner, runnerRemoteCodexPath: process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH?.trim(), runnerRemoteCodexNpmSpec: remoteCodexNpmSpec, model: options.model });
  const requireSuccess = (result: { timedOut: boolean; exitCode: number | null }, message: string) => {
    if (result.timedOut || result.exitCode !== 0) throw new Error(message);
  };
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "paperclip-native-setup-"));
  let remoteDirectoryCreated = false;
  let remoteCaBundlePath: string | undefined;
  return probeNativeRunnerEnvironment({ runtimeDirectory: runtimeDirectory, provider: "codex", model: options.model, reasoningEffort: options.reasoningEffort,
    workingDirectory: remoteWorkspace, environment: options.environment, timeoutMs: options.timeoutMs,
    transportOptions: {
      runnerBinary: controllerRunnerBinary, codexCommand: remoteCodexBinary, sourceCodexHome: options.sourceCodexHome,
      runnerFilesystemRoot: remoteFilesystemRoot, runnerStateDirectory: remoteStateDirectory,
      prpIdentity: { runnerInstanceId, runId: id, environmentLeaseId: `setup-${id}`, normalizedSessionId: `setup-${id}`, turnId: `turn-${id}`, itemId: `item-${id}` },
      readRunnerState: () => readRemoteRunnerState({ runner, stateDirectory: remoteStateDirectory }),
      controlPlaneRegistration: async authority => {
        // Claim a private per-probe root. Never merge credentials or state into
        // another session's directory on the remote host.
        const created = await runner.execute({ command: "sh", args: ["-c", 'set -eu; umask 077; mkdir -p -- "$1"; test -d "$1" && test ! -L "$1"; mkdir -- "$2"; install -d -m 0700 "$3" "$4" "$5"',
          "paperclip-native-setup", posix.dirname(remoteRoot), remoteRoot, remoteFilesystemRoot, remoteWorkspace, posix.join(remoteFilesystemRoot, "probe-home")], cwd: target.remoteCwd, bypassSession: true, timeoutMs: 10_000 });
        requireSuccess(created, "Native SSH setup could not claim a private runtime directory.");
        remoteDirectoryCreated = true;
        await artifacts.prepare("dial_wss");
        if (transport.caBundlePath) {
          remoteCaBundlePath = posix.join(remoteRoot, "bin", "runner-ca-bundle.pem");
          await stageRemoteRunnerFile({ target, runner, sourcePath: transport.caBundlePath, targetPath: remoteCaBundlePath, mode: 0o600 });
        }
        const registration = await registerRunnerPrpAuthority({ companyId: options.context.companyId, runId: id, authority });
        return { connection: { mode: "connect", connectUrl: transport.connectUrl, ...(remoteCaBundlePath ? { caBundlePath: remoteCaBundlePath } : {}) },
          startupFailureCode: "runner_direct_wss_failed", release: registration.release };
      },
      runnerProcessLauncher: createRemoteRunnerProcessLauncher({ target, runner, remoteBinary, stateDirectory: remoteStateDirectory,
        processIdentityPath: posix.join(remoteStateDirectory, "runner-process.identity"), diagnosticsDirectory: posix.join(remoteRoot, "diagnostics"), runnerInstanceId,
        ensureArtifact: async () => {
          // The normal transport has already materialized the bound account and
          // its managed config locally. Publish only those two fresh files.
          for (const name of ["auth.json", "config.toml"] as const) {
            const sourcePath = join(runtimeDirectory, "codex-home", name);
            try { await stat(sourcePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            await stageRemoteRunnerFile({ target, runner, sourcePath, targetPath: posix.join(remoteFilesystemRoot, "codex-home", name), mode: 0o600 });
          }
        } }),
    },
    ...(options.context.managedAiCredentialHome ? { onCodexCredentialRefresh: async (filename: string) => {
      if (filename !== posix.join(remoteFilesystemRoot, "codex-home", "auth.json")) throw new Error("The native Codex credential refresh handoff is invalid.");
      await copyBackCodexAuth({ hostAuthPath: join(options.context.managedAiCredentialHome!, "auth.json"), log: () => {}, readSandboxAuth: async () => {
        // Reuse the task's shell/base64 handoff without requiring a guest JS
        // runtime. Bound and validate the private owner-only credential file.
        const read = await runner.execute({ command: "sh", args: ["-c", 'set -eu; file=$1; test -f "$file" || exit 66; test ! -L "$file"; parent=$(dirname -- "$file"); while test "$parent" != /; do test -d "$parent" && test ! -L "$parent"; parent=$(dirname -- "$parent"); done; metadata=$(stat -c "%u %a %s" "$file" 2>/dev/null || stat -f "%u %Lp %z" "$file"); set -- $metadata; test "$1" = "$(id -u)" && test "$2" = 600 && test "$3" -le 65536; head -c 65537 -- "$file" | base64', "paperclip-native-refresh", filename], bypassSession: true, timeoutMs: 10_000 });
        if (read.timedOut || read.exitCode !== 0) throw Object.assign(new Error("Native Codex credential refresh handoff unavailable."), { code: read.exitCode === 66 ? "ENOENT" : "INVALID_CREDENTIAL" });
        const body = Buffer.from(read.stdout, "base64");
        if (body.length > 65_536) throw new Error("Native Codex credential refresh handoff exceeds the credential size limit.");
        return body;
      } });
    } } : {}),
    onCleanupConfirmed: async () => {
      if (remoteDirectoryCreated) {
        const cleaned = await runner.execute({ command: "rm", args: ["-rf", "--", remoteRoot], bypassSession: true, timeoutMs: 10_000 });
        requireSuccess(cleaned, "Native SSH setup cleanup is incomplete; private recovery state was retained.");
      }
      await rm(runtimeDirectory, { recursive: true, force: true });
    },
  });
}

/** Codex/OpenCode readiness requires their selected native daemon and provider turn. */
export async function testNativeRunnerAuthentication(context: AdapterEnvironmentTestContext, provider: "codex" | "opencode", model: string | null, artifacts?: RemoteNativeSetupArtifacts): Promise<AdapterEnvironmentTestResult> {
  const remote = context.executionTarget?.kind === "remote";
  const configured = context.config.env;
  const environment: Record<string, string> = Object.fromEntries([
    ...(remote ? [] : PROBE_TRANSPORT_ENV_KEYS.flatMap(key => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : [])),
    ...Object.entries(configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ]);
  const authKey = "_PAPERCLIP_NATIVE_SETUP_CODEX_AUTH_JSON_SECRET";
  const configKey = "_PAPERCLIP_NATIVE_SETUP_CODEX_CONFIG_TOML_SECRET";
  delete environment[authKey];
  delete environment[configKey];
  let sourceCodexHome: string | null | undefined;
  const effort = context.config.modelReasoningEffort ?? context.config.reasoningEffort ?? context.config.effort;
  const timeoutMs = remote ? 90_000 : 45_000;
  let runtimeDirectory: string | undefined;
  try {
    // Match task execution's closed host projection before the probe replaces
    // HOME. API keys never enter this projection from the ambient process.
    if (provider === "codex") {
      const { buildNativeProviderEnvironment } = await import("./native-session-executor.js");
      sourceCodexHome = context.managedAiCredentialHome ?? resolveSourceCodexHome(buildNativeProviderEnvironment(environment));
    }
    let receipt: Awaited<ReturnType<typeof probeNativeRunnerEnvironment>>;
    if (context.executionTarget?.kind === "remote" && context.executionTarget.transport === "ssh" && provider === "codex") {
      receipt = await probeSshNativeCodex({ context, model, environment, sourceCodexHome: sourceCodexHome ?? "", timeoutMs,
        ...(typeof effort === "string" && effort ? { reasoningEffort: effort } : {}) });
    } else if (context.executionTarget?.kind === "remote") {
      const target = context.executionTarget;
      // Authorize precisely the Linux pack/daemon from this controller's
      // distribution. Image-installed bytes must verify before their import.
      const { readBundledRemoteProviderPackManifest, readRemoteProviderPackManifest, remoteProviderPackVerificationScript } = await import("./native-session-executor.js");
      // Standard Linux images provide their qualified pack directly. Assembled
      // npm controllers instead ship the image manifest and Linux daemon.
      const configuredPack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim();
      const expectedPack = artifacts?.manifest ?? (configuredPack ? readRemoteProviderPackManifest(configuredPack) : readBundledRemoteProviderPackManifest());
      const controllerRunnerBinary = artifacts?.controllerRunnerBinary ?? (configuredPack
        ? process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH?.trim() || resolvePaperclipRunnerBinary()
        : bundledRemoteRunnerBinary());
      const expectedRunner = readRunnerdArtifactBinding(controllerRunnerBinary);
      const canonical = (value: unknown): string => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
        : value && typeof value === "object" ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}" : JSON.stringify(value);
      const expectedManifest = Buffer.from(canonical(expectedPack)).toString("base64");
      // Native runs stage the controller's explicitly bound Codex home. The
      // probe does the same, using bounded private-file reads and env transport.
      const remoteSourceCodexHome = context.managedAiCredentialHome ?? environment.CODEX_HOME?.trim();
      if (provider === "codex" && remoteSourceCodexHome) {
        const canonicalHome = await realpath(remoteSourceCodexHome);
        const optionalCredential = async (name: string) => readLocalAiCredentialFile(join(canonicalHome, name))
          .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        const auth = await optionalCredential("auth.json");
        const config = await optionalCredential("config.toml");
        if (auth !== undefined) environment[authKey] = auth;
        if (config !== undefined) environment[configKey] = config;
      }
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "PAPERCLIP_RUNNER_EXTERNAL_SANDBOX"]) delete environment[key];
      const script = `
        const { pathToFileURL } = await import('node:url');
        const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { readFileSync } = await import('node:fs');
        const { createHash } = await import('node:crypto');
        const { createRequire } = await import('node:module');
        // Reuse the production execution verifier without evaluating the pack.
        new Function('require', 'process', ${JSON.stringify(remoteProviderPackVerificationScript())})(createRequire(import.meta.url), { argv: ['', process.argv[1], process.argv[6]], versions: process.versions, platform: process.platform, arch: process.arch });
        if ('sha256:' + createHash('sha256').update(readFileSync(process.argv[4])).digest('hex') !== process.argv[5]) throw new Error('runner_remote_artifact_incompatible: selected daemon digest mismatch');
        const { probeNativeRunnerEnvironment } = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
        const redactNativeProbeMessage = ${redactNativeProbeMessage.toString()};
        const input = JSON.parse(process.argv[2]);
        const environment = Object.fromEntries([...new Set([...JSON.parse(process.argv[3]), ...${JSON.stringify(PROBE_TRANSPORT_ENV_KEYS)}])].filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
        const sensitiveEnvironment = { ...environment };
        const runtimeDirectory = await mkdtemp(join(tmpdir(), 'paperclip-native-setup-'));
        let codexCredentialRefreshPath;
        let cleanupConfirmed = false;
        try {
          let sourceCodexHome;
          if (input.provider === 'codex' && (environment.${authKey} !== undefined || environment.${configKey} !== undefined)) {
            sourceCodexHome = join(runtimeDirectory, 'source-codex-home');
            await mkdir(sourceCodexHome, { mode: 448 });
            if (environment.${authKey} !== undefined) await writeFile(join(sourceCodexHome, 'auth.json'), environment.${authKey}, { mode: 384 });
            if (environment.${configKey} !== undefined) await writeFile(join(sourceCodexHome, 'config.toml'), environment.${configKey}, { mode: 384 });
          }
          delete environment.${authKey}; delete environment.${configKey};
          const result = await probeNativeRunnerEnvironment({ ...input, runtimeDirectory, environment, timeoutMs: ${timeoutMs}, transportOptions: { runnerBinary: process.argv[4], sourceCodexHome: sourceCodexHome ?? '', ...(input.codexCommand ? { codexCommand: input.codexCommand } : {}) },
            onCleanupConfirmed: async () => { if (!codexCredentialRefreshPath) await rm(runtimeDirectory, { recursive: true, force: true }); cleanupConfirmed = true; },
            ...(input.copyBack ? { onCodexCredentialRefresh: async path => { codexCredentialRefreshPath = path; } } : {}) });
          console.log(JSON.stringify({ ...result, cleanupConfirmed, ...(codexCredentialRefreshPath ? { runtimeDirectory, codexCredentialRefreshPath } : {}) }));
        } catch (error) {
          const message = redactNativeProbeMessage(error instanceof Error ? error.message : 'The selected native runtime could not verify this account.', sensitiveEnvironment);
          console.log(JSON.stringify({ nativeProbeError: message, cleanupConfirmed, ...(codexCredentialRefreshPath ? { runtimeDirectory, codexCredentialRefreshPath } : {}) }));
        }
      `;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const input = { provider, model, ...(artifacts?.codexCommand ? { codexCommand: artifacts.codexCommand } : {}), ...(provider === "codex" && typeof effort === "string" && effort ? { reasoningEffort: effort } : {}), copyBack: Boolean(context.managedAiCredentialHome && provider === "codex") };
      const command = (artifacts ? 'runner=' + quote(artifacts.runnerBinary) + '; pack=' + quote(artifacts.providerPackRoot) + '; ' : 'runner=""; for candidate in /opt/paperclip-runner/bin/paperclip-runnerd "$HOME/.local/bin/paperclip-runnerd"; do if [ -x "$candidate" ]; then runner="$candidate"; break; fi; done; if [ -z "$runner" ]; then echo "Qualified Paperclip Runner is missing" >&2; exit 1; fi; for pack in /opt/paperclip-runner/provider-pack "$HOME/.local/share/paperclip-runner/provider-pack"; do if [ -f "$pack/provider-pack.json" ]; then ') + 'exec "$pack/' + expectedPack.payload.artifacts.nodeCommand.path + '" --input-type=module -e '
        + quote(script) + ' "$pack" ' + [JSON.stringify(input), JSON.stringify(Object.keys(environment))].map(quote).join(' ') + ' "$runner" ' + [expectedRunner.digest, expectedManifest].map(quote).join(' ') + (artifacts ? '' : '; fi; done; echo "Qualified provider pack is missing" >&2; exit 1');
      const probe = await runAdapterExecutionTargetShellCommand(`native-hello-${crypto.randomUUID()}`, target, command,
        { cwd: target.remoteCwd, env: environment, timeoutSec: 110 });
      if (probe.timedOut) throw new Error("Native provider hello probe timed out.");
      if (probe.exitCode !== 0) throw new Error(nativeProbeFailureMessage(probe, environment));
      const result = JSON.parse(probe.stdout.trim());
      if (result.codexCredentialRefreshPath) {
        try {
          if (!context.managedAiCredentialHome || provider !== "codex" || typeof result.runtimeDirectory !== "string"
            || !posix.isAbsolute(result.runtimeDirectory) || result.runtimeDirectory !== posix.normalize(result.runtimeDirectory)
            || !/^paperclip-native-setup-[A-Za-z0-9]+$/.test(posix.basename(result.runtimeDirectory))
            || result.codexCredentialRefreshPath !== posix.join(result.runtimeDirectory, "codex-home", "auth.json")) throw new Error("The native Codex credential refresh handoff is invalid.");
          const readScript = `const fs=require('node:fs'),path=require('node:path');let fd;try{let parent=path.dirname(process.argv[1]);while(true){if(!fs.lstatSync(parent).isDirectory())throw Error('directory');const next=path.dirname(parent);if(next===parent)break;parent=next;}fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&511)!==384||st.size>65536)throw Error('credential');const b=Buffer.alloc(65537);let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}if(n>65536)throw Error('size');process.stdout.write(b.subarray(0,n).toString('base64'));b.fill(0);}catch(e){process.exitCode=e.code==='ENOENT'?66:1;}finally{if(fd!==undefined)fs.closeSync(fd);}`;
          await copyBackCodexAuth({ hostAuthPath: join(context.managedAiCredentialHome, "auth.json"), log: () => {}, readSandboxAuth: async () => {
            const readCommand = artifacts ? quote(posix.join(artifacts.providerPackRoot, expectedPack.payload.artifacts.nodeCommand.path)) + ' -e ' + quote(readScript) + ' ' + quote(result.codexCredentialRefreshPath) : 'for pack in /opt/paperclip-runner/provider-pack "$HOME/.local/share/paperclip-runner/provider-pack"; do if [ -f "$pack/provider-pack.json" ]; then exec "$pack/' + expectedPack.payload.artifacts.nodeCommand.path + '" -e ' + quote(readScript) + ' ' + quote(result.codexCredentialRefreshPath) + '; fi; done; exit 1';
            const read = await runAdapterExecutionTargetShellCommand(`native-refresh-${crypto.randomUUID()}`, target, readCommand, { cwd: target.remoteCwd, env: {}, timeoutSec: 10 });
            if (read.timedOut || read.exitCode !== 0) throw Object.assign(new Error("Native Codex credential refresh handoff unavailable."), { code: read.exitCode === 66 ? "ENOENT" : "INVALID_CREDENTIAL" });
            return Buffer.from(read.stdout, "base64");
          } });
          if (result.cleanupConfirmed === true) {
            const cleaned = await runAdapterExecutionTargetShellCommand(`native-cleanup-${crypto.randomUUID()}`, target, 'rm -rf -- ' + quote(result.runtimeDirectory), { cwd: target.remoteCwd, env: {}, timeoutSec: 10 });
            if (cleaned.timedOut || cleaned.exitCode !== 0) throw new Error("Native Codex setup credential cleanup failed.");
          }
        } catch (error) {
          if (typeof result.nativeProbeError === "string" && result.nativeProbeError) {
            const original = new Error(result.nativeProbeError);
            throw new AggregateError([original, error], original.message + "; " + (error instanceof Error ? error.message : "Native Codex credential cleanup failed."), { cause: original });
          }
          throw error;
        }
      }
      if (result.cleanupConfirmed === true) artifacts?.onCleanupConfirmed?.();
      if (result.nativeProbeError) throw new Error(result.nativeProbeError);
      if (result.cleanupConfirmed !== true) throw new Error("Native setup cleanup is incomplete; private recovery state was retained.");
      receipt = result;
    } else {
      runtimeDirectory = await mkdtemp(join(tmpdir(), "paperclip-native-setup-"));
      receipt = await probeNativeRunnerEnvironment({ runtimeDirectory, provider, model, environment, timeoutMs,
        ...(provider === "codex" && typeof effort === "string" && effort ? { reasoningEffort: effort } : {}),
        onCleanupConfirmed: async () => { await rm(runtimeDirectory!, { recursive: true, force: true }); },
        transportOptions: { runnerBinary: resolvePaperclipRunnerBinary(), sourceCodexHome: sourceCodexHome ?? "" },
        ...(context.managedAiCredentialHome && provider === "codex" ? { onCodexCredentialRefresh: async (filename: string) => {
          await copyBackCodexAuth({ hostAuthPath: join(context.managedAiCredentialHome!, "auth.json"), log: () => {}, readSandboxAuth: async () => Buffer.from(await readLocalAiCredentialFile(filename)) });
        } } : {}),
      });
    }
    if (receipt.helloProbePassed !== true || receipt.provider !== provider || typeof receipt.effectiveModel !== "string" || !receipt.effectiveModel.trim() || (model !== null && receipt.effectiveModel !== model)
      || receipt.providerDriver !== (provider === "opencode" ? "opencode_server" : "codex_app_server")) throw new Error("The selected native runtime returned an incompatible account or model verification receipt.");
    return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(), checks: [{ code: `${provider}_hello_probe_passed`, level: "info",
      message: `The native ${provider} runtime verified the selected account and model in ${remote ? "the selected environment" : "the Paperclip host"}.` }] };
  } catch (error) {
    const message = redactNativeProbeMessage(error instanceof Error ? error.message : "The selected native runtime could not verify this account.", environment);
    const authentication = /(?:invalid (?:api[- ]?key|auth(?:entication)? token)|authentication (?:failed|required)|unauthenticated|unauthorized|not authenticated|please (?:log|sign) in|not logged in|\b(?:401|403)\b)/i.test(message);
    return { adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: `${provider}_hello_probe_${authentication ? "auth_required" : /timed out/i.test(message) ? "timeout" : "failed"}`, level: "error", message,
      hint: "Check the selected account, model access, and native runtime prerequisites, then retry. Legacy runner is available explicitly in Advanced." }] };
  }
}

/** Use the qualified native host and bound account, without borrowing a legacy CLI or ambient login. */
export async function testNativeAcpxAuthentication(context: AdapterEnvironmentTestContext, agent: "claude" | "grok" | "cursor", model: string, artifacts?: RemoteNativeSetupArtifacts): Promise<AdapterEnvironmentTestResult> {
  const configured = context.config.env;
  const remote = context.executionTarget?.kind === "remote";
  let environment: Record<string, string> = Object.fromEntries([
    ...(remote ? [] : PROBE_TRANSPORT_ENV_KEYS.flatMap(key => typeof process.env[key] === "string" ? [[key, process.env[key]!]] : [])),
    ...Object.entries(configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ]);
  const timeoutMs = context.executionTarget?.kind === "remote" ? 90_000 : 45_000;
  const expected = QUALIFIED_ACPX_PROFILES[agent];
  let runtimeDirectory: string | undefined;
  try {
    const grokHome = agent === "grok" && !environment.XAI_API_KEY?.trim()
      ? await realpath(context.managedAiCredentialHome ?? resolveManagedGrokHomeDir(process.env, context.companyId))
        .catch(() => { throw new Error("Grok subscription login is unavailable. Connect Grok Build or select an xAI API key."); }) : undefined;
    const grokCredential = agent === "grok" ? await prepareGrokRunnerCredentials({
      companyId: context.companyId, environment, remote,
      // Only the resolved connection or this company's login may be probed.
      managedHome: grokHome,
    }) : null;
    if (grokCredential) environment = Object.fromEntries(Object.entries(grokCredential.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    let receipt: Awaited<ReturnType<typeof probeQualifiedAcpxEnvironment>>;
    if (context.executionTarget?.kind === "remote") {
      const target = context.executionTarget;
      for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR"]) delete environment[key];
      // Only configured credential names cross the selected environment boundary.
      // Values remain transport env data, never command text or diagnostic metadata.
      const script = `
        const { pathToFileURL } = await import('node:url');
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { probeQualifiedAcpxEnvironment } = await import(pathToFileURL(process.argv[1] + '/dist/index.js'));
        const redactNativeProbeMessage = ${redactNativeProbeMessage.toString()};
        const names = JSON.parse(process.argv[4]);
        const environment = Object.fromEntries([...new Set([...names, ...${JSON.stringify(PROBE_TRANSPORT_ENV_KEYS)}])].filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
        const runtimeDirectory = await mkdtemp(join(tmpdir(), 'paperclip-native-setup-'));
        let grokCredentialRefreshPath;
        let cleanupConfirmed = false;
        try {
          const result = await probeQualifiedAcpxEnvironment({ runtimeDirectory, agent: process.argv[2], model: process.argv[3], environment, hello: true, timeoutMs: ${timeoutMs}, onGrokCredentialRefresh: async path => { grokCredentialRefreshPath = path; cleanupConfirmed = true; } });
          if (!grokCredentialRefreshPath) await rm(runtimeDirectory, { recursive: true, force: true });
          cleanupConfirmed = true;
          console.log(JSON.stringify({ ...result, cleanupConfirmed, ...(grokCredentialRefreshPath ? { runtimeDirectory, grokCredentialRefreshPath } : {}) }));
        } catch (error) {
          let message = error instanceof Error ? error.message : 'The selected native runtime could not verify this account.';
          message = redactNativeProbeMessage(message, environment);
          console.log(JSON.stringify({ nativeProbeError: message.slice(0, 2000), cleanupConfirmed, ...(grokCredentialRefreshPath ? { runtimeDirectory, grokCredentialRefreshPath } : {}) }));
        }
      `;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const command = (artifacts ? 'pack=' + quote(artifacts.providerPackRoot) + '; ' : 'for pack in /opt/paperclip-runner/provider-pack "$HOME/.local/share/paperclip-runner/provider-pack"; do if [ -f "$pack/provider-pack.json" ]; then ') + 'exec "$pack/node_modules/node/bin/node" --input-type=module -e '
        + quote(script) + ' "$pack" ' + [agent, model, JSON.stringify(Object.keys(environment))].map(quote).join(' ')
        + (artifacts ? '' : '; fi; done; echo "Qualified provider pack is missing" >&2; exit 1');
      const probe = await runAdapterExecutionTargetShellCommand(`native-hello-${crypto.randomUUID()}`, context.executionTarget, command,
        { cwd: context.executionTarget.remoteCwd, env: environment, timeoutSec: 110 });
      if (probe.timedOut) throw new Error("Native provider hello probe timed out.");
      if (probe.exitCode !== 0) throw new Error(nativeProbeFailureMessage(probe, environment));
      const result = JSON.parse(probe.stdout.trim());
      if (result.grokCredentialRefreshPath) {
        if (!grokCredential?.home || typeof result.runtimeDirectory !== "string"
          || !posix.isAbsolute(result.runtimeDirectory) || result.runtimeDirectory !== posix.normalize(result.runtimeDirectory) || !/^paperclip-native-setup-[A-Za-z0-9]+$/.test(posix.basename(result.runtimeDirectory))
          || result.grokCredentialRefreshPath !== posix.join(result.runtimeDirectory, "acpx", acpxRuntimeSessionDirectoryName("environment-probe"), "grok-home", "auth-refresh.json")) {
          throw new Error("The native Grok credential refresh handoff is invalid.");
        }
        // This is the same private, bounded transport read used by native runs;
        // credential bytes never enter the setup result or public diagnostics.
        const readScript = `const fs=require('node:fs'),path=require('node:path');let fd;try{let parent=path.dirname(process.argv[1]);while(true){if(!fs.lstatSync(parent).isDirectory())throw Error('directory');const next=path.dirname(parent);if(next===parent)break;parent=next;}fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid()||(st.mode&511)!==384||st.size>65536)throw Error('credential');const b=Buffer.alloc(65537);let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}if(n>65536)throw Error('size');process.stdout.write(b.subarray(0,n).toString('base64'));b.fill(0);}catch(e){process.exitCode=e.code==='ENOENT'?66:1;}finally{if(fd!==undefined)fs.closeSync(fd);}`;
        await copyBackGrokAuth({ hostHomeDir: grokCredential.home, log: () => {}, readSandboxAuth: async () => {
          const read = await runAdapterExecutionTargetShellCommand(`native-refresh-${crypto.randomUUID()}`, target, (artifacts ? quote(posix.join(artifacts.providerPackRoot, artifacts.manifest.payload.artifacts.nodeCommand.path)) : 'node') + ' -e ' + quote(readScript) + ' ' + quote(result.grokCredentialRefreshPath), { cwd: target.remoteCwd, env: {}, timeoutSec: 10 });
          if (read.timedOut || read.exitCode !== 0) throw Object.assign(new Error("Native Grok credential refresh handoff unavailable."), { code: read.exitCode === 66 ? "ENOENT" : "INVALID_CREDENTIAL" });
          return Buffer.from(read.stdout, "base64");
        } });
        if (result.cleanupConfirmed === true) {
          const cleaned = await runAdapterExecutionTargetShellCommand(`native-cleanup-${crypto.randomUUID()}`, context.executionTarget, 'rm -rf -- ' + quote(result.runtimeDirectory), { cwd: target.remoteCwd, env: {}, timeoutSec: 10 });
          if (cleaned.timedOut || cleaned.exitCode !== 0) throw new Error("Native Grok setup credential cleanup failed.");
        }
      }
      if (result.cleanupConfirmed === true) artifacts?.onCleanupConfirmed?.();
      if (result.nativeProbeError) throw new Error(result.nativeProbeError);
      receipt = result;
    } else {
      runtimeDirectory = await mkdtemp(join(tmpdir(), "paperclip-native-setup-"));
      receipt = await probeQualifiedAcpxEnvironment({ runtimeDirectory, agent, model, environment, hello: true, timeoutMs,
        ...(grokCredential?.home ? { onGrokCredentialRefresh: async (filename: string) => {
          await copyBackGrokAuth({ hostHomeDir: grokCredential.home!, log: () => {}, readSandboxAuth: async () => Buffer.from(await readLocalAiCredentialFile(filename)) });
        } } : {}),
      });
      // A successful receipt includes the driver's confirmed provider/credential cleanup.
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
    if (receipt.helloProbePassed !== true || receipt.effectiveModel !== model || receipt.commandDigest !== expected.commandDigest) {
      throw new Error("The selected native runtime returned an incompatible account or model verification receipt.");
    }
    return {
      adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(),
      checks: [{ code: `${agent}_hello_probe_passed`, level: "info",
        message: `The native ${agent} runtime verified the selected account and model in ${context.executionTarget?.kind === "remote" ? "the selected environment" : "the Paperclip host"}.` }],
    };
  } catch (error) {
    let message = error instanceof Error ? error.message : "The selected native runtime could not verify this account.";
    message = redactNativeProbeMessage(message, environment);
    const authentication = /(?:invalid (?:api[- ]?key|auth(?:entication)? token)|authentication (?:failed|required)|unauthenticated|unauthorized|not authenticated|please (?:log|sign) in|not logged in|\b(?:401|403)\b)/i.test(message);
    return {
      adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(),
      checks: [{ code: `${agent}_hello_probe_${authentication ? "auth_required" : /timed out/i.test(message) ? "timeout" : "failed"}`, level: "error",
        message: message.slice(0, 2000), hint: "Check the selected account, model access, and native runtime prerequisites, then retry. Legacy runner is available explicitly in Advanced." }],
    };
  }
}
