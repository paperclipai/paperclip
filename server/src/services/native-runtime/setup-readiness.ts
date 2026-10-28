import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { CODEX_CHATGPT_MODEL_REJECTION_RE, codexChatGptRetirementHint } from "@paperclipai/adapter-codex-local";
import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { probeNativeRunnerEnvironment, resolveSourceCodexHome } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerBinary, resolveRemotePaperclipRunnerBinary } from "./native-codex-runner.js";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { resolvePaperclipRunnerTransport } from "@paperclipai/adapter-utils/runner-connectivity";
import { createNativeRunnerExecutionDriver } from "./native-runner-execution-driver.js";


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

async function prepareProbeCodexSource(runtimeDirectory: string, sourceCodexHome: string, authJson?: string): Promise<string> {
  if (authJson === undefined) return sourceCodexHome;
  let config: Buffer | undefined;
  const source = await open(join(sourceCodexHome, "config.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ELOOP") return null; throw error; });
  if (source) {
    try {
      const metadata = await source.stat();
      if (metadata.isFile()) {
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        let size = 0;
        while (size < bytes.length) {
          const result = await source.read(bytes, size, bytes.length - size, size);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        if (size > 1024 * 1024) throw new Error("The selected Codex configuration exceeds its size limit.");
        config = bytes.subarray(0, size);
      }
    } finally { await source.close(); }
  }
  const credentialSource = join(runtimeDirectory, "codex-credential-source");
  let created = false;
  try {
    await mkdir(credentialSource, { mode: 0o700 });
    created = true;
    await writeFile(join(credentialSource, "auth.json"), authJson, { mode: 0o600, flag: "wx" });
    if (config) await writeFile(join(credentialSource, "config.toml"), config, { mode: 0o600, flag: "wx" });
    return credentialSource;
  } catch (error) {
    if (created) await rm(credentialSource, { recursive: true, force: true });
    throw error;
  }
}

async function probePreparedNativeRuntime(runtimeDirectory: string, prepare: () => Promise<Parameters<typeof probeNativeRunnerEnvironment>[0]>) {
  let handedOff = false;
  try {
    const options = await prepare();
    handedOff = true;
    return await probeNativeRunnerEnvironment(options);
  } catch (error) {
    if (!handedOff) {
      try { await rm(runtimeDirectory, { recursive: true, force: true }); }
      catch (cleanupError) {
        const message = error instanceof Error ? error.message : "Native setup preparation failed.";
        throw new AggregateError([error, cleanupError], `${message}; Native setup preparation cleanup is incomplete.`, { cause: error });
      }
    }
    throw error;
  }
}

async function probeRemoteNativeCodex(options: {
  context: AdapterEnvironmentTestContext;
  model: string | null;
  reasoningEffort?: string;
  environment: Record<string, string>;
  sourceCodexHome: string;
  credentialRefreshAuthPath?: string;
  sourceAuthJson?: string;
  timeoutMs: number;
}) {
  const target = options.context.executionTarget;
  if (target?.kind !== "remote") throw new Error("Native setup requires the selected remote execution target.");
  const { createRemoteNativeArtifactPreparation, createRemoteRunnerProcessLauncher, stageRemoteRunnerFile, readRemoteRunnerState } = await import("./native-session-executor.js");
  const runner = target.transport === "ssh" ? createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd }) : target.runner;
  if (!runner) throw new Error("runner_transport_ineligible: remote process runner is unavailable");
  const id = crypto.randomUUID();
  const runnerInstanceId = `setup-${id}`;
  const ingress = target.transport === "sandbox" && target.effectiveCapabilities?.runnerWebSocketIngress === true;
  const outbound = !ingress ? await resolvePaperclipRunnerTransport({ target, runId: id, localConnectUrl: "ws://127.0.0.1/unused",
    runnerPublicUrl: process.env.PAPERCLIP_RUNNER_PUBLIC_URL?.trim() || null,
    runnerCaBundlePath: process.env.PAPERCLIP_RUNNER_CA_BUNDLE_PATH?.trim() || null, runnerIngressAuthorized: true }) : null;
  if (outbound && outbound.mode !== "direct_outbound") throw new Error("runner_transport_ineligible: expected outbound native transport");
  if (outbound?.mode === "direct_outbound" && outbound.caBundlePath) await stat(outbound.caBundlePath).catch(() => { throw new Error("runner_direct_wss_failed: configured runner CA bundle is unavailable"); });
  const remoteRoot = posix.join(target.remoteCwd, ".paperclip-runtime", `paperclip-native-setup-${id}`);
  const remoteBinary = posix.join(remoteRoot, "bin", "paperclip-runnerd");
  const remoteStateDirectory = posix.join(remoteRoot, "runner");
  const remoteFilesystemRoot = posix.join(remoteRoot, "filesystem");
  const remoteWorkspace = posix.join(remoteFilesystemRoot, "workspace");
  const remoteCodexNpmSpec = process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC?.trim() || null;
  const remoteCodexBinary = remoteCodexNpmSpec ? posix.join(remoteRoot, "harnesses", "codex", "node_modules", ".bin", "codex") : posix.join(remoteRoot, "bin", "codex");
  const explicitRunner = process.env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH?.trim() || null;
  const controllerRunnerBinary = await resolveRemotePaperclipRunnerBinary({ runner, remoteCwd: target.remoteCwd, configuredPath: explicitRunner });
  const artifacts = createRemoteNativeArtifactPreparation({ target, runner, remoteBinary, controllerRunnerBinary, remoteRuntimeRoot: remoteRoot, remoteCodexBinary,
    targetPlatformArtifactVerified: true,
    runnerRemoteBinaryPath: explicitRunner, runnerRemoteCodexPath: process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH?.trim(), runnerRemoteCodexNpmSpec: remoteCodexNpmSpec, model: options.model });
  const requireSuccess = (result: { timedOut: boolean; exitCode: number | null }, message: string) => {
    if (result.timedOut || result.exitCode !== 0) throw new Error(message);
  };
  const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "paperclip-native-setup-")));
  return probePreparedNativeRuntime(runtimeDirectory, async () => {
    const sourceCodexHome = await prepareProbeCodexSource(runtimeDirectory, options.sourceCodexHome, options.sourceAuthJson);
    let remoteDirectoryCreated = false;
    let signalSpawned!: () => void;
    const spawned = new Promise<void>(resolve => { signalSpawned = resolve; });
    return { runtimeDirectory: runtimeDirectory, provider: "codex", model: options.model, reasoningEffort: options.reasoningEffort,
      workingDirectory: remoteWorkspace, environment: options.environment, timeoutMs: options.timeoutMs,
      transportOptions: {
        externallySandboxed: target.transport === "sandbox",
        runnerBinary: controllerRunnerBinary, codexCommand: remoteCodexBinary, sourceCodexHome,
        runnerFilesystemRoot: remoteFilesystemRoot,
        prpIdentity: { runnerInstanceId, runId: id, environmentLeaseId: `setup-${id}`, normalizedSessionId: `setup-${id}`, turnId: `turn-${id}`, itemId: `item-${id}` },
        ...createNativeRunnerExecutionDriver({
          target, binding: { companyId: options.context.companyId, runId: id },
          runnerIngressAuthorized: true,
          runnerPublicUrl: process.env.PAPERCLIP_RUNNER_PUBLIC_URL?.trim() || null,
          runnerCaBundlePath: process.env.PAPERCLIP_RUNNER_CA_BUNDLE_PATH?.trim() || null,
          processStarted: spawned,
          prepareRemote: async mode => {
            const created = await runner.execute({ command: "sh", args: ["-c", 'set -eu; umask 077; mkdir -p -- "$1"; test -d "$1" && test ! -L "$1"; mkdir -- "$2"; install -d -m 0700 "$3" "$4" "$5"',
              "paperclip-native-setup", posix.dirname(remoteRoot), remoteRoot, remoteFilesystemRoot, remoteWorkspace, posix.join(remoteFilesystemRoot, "probe-home")], cwd: target.remoteCwd, bypassSession: true, timeoutMs: 10_000 });
            requireSuccess(created, "Native setup could not claim a private runtime directory.");
            remoteDirectoryCreated = true;
            await artifacts.prepare(mode);
          },
          mapCaBundle: async sourcePath => {
            const targetPath = posix.join(remoteRoot, "bin", "runner-ca-bundle.pem");
            await stageRemoteRunnerFile({ target, runner, sourcePath, targetPath, mode: 0o600 });
            return targetPath;
          },
          process: {
            runnerStateDirectory: remoteStateDirectory,
            readRunnerState: () => readRemoteRunnerState({ runner, stateDirectory: remoteStateDirectory }),
            runnerProcessLauncher: createRemoteRunnerProcessLauncher({ target, runner, remoteBinary, stateDirectory: remoteStateDirectory,
              onRunnerProcessSpawned: signalSpawned, processIdentityPath: posix.join(remoteStateDirectory, "runner-process.identity"), diagnosticsDirectory: posix.join(remoteRoot, "diagnostics"), runnerInstanceId,
              ensureArtifact: async () => {
                for (const name of ["auth.json", "config.toml"] as const) {
                  const sourcePath = join(runtimeDirectory, "codex-home", name);
                  try { await stat(sourcePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
                  await stageRemoteRunnerFile({ target, runner, sourcePath, targetPath: posix.join(remoteFilesystemRoot, "codex-home", name), mode: 0o600 });
                }
              } }),
          },
        }),
      },
      ...(options.credentialRefreshAuthPath ? { onCodexCredentialRefresh: async (filename: string) => {
        if (filename !== posix.join(remoteFilesystemRoot, "codex-home", "auth.json")) throw new Error("The native Codex credential refresh handoff is invalid.");
        await copyBackCodexAuth({ hostAuthPath: options.credentialRefreshAuthPath!, log: () => {}, readSandboxAuth: async () => {
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
          requireSuccess(cleaned, "Native setup cleanup is incomplete; private recovery state was retained.");
        }
        await rm(runtimeDirectory, { recursive: true, force: true });
      },
    };
  });
}

export async function testNativeRunnerAuthentication(context: AdapterEnvironmentTestContext, provider: "codex", model: string | null): Promise<AdapterEnvironmentTestResult> {
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
  let sourceAuthJson: string | undefined;
  try {
    if (provider === "codex") {
      const { buildNativeProviderEnvironment } = await import("./native-session-executor.js");
      sourceCodexHome = context.managedAiCredentialHome ?? resolveSourceCodexHome(buildNativeProviderEnvironment(environment));
    }
    let credentialRefreshAuthPath: string | undefined;
    if (sourceCodexHome && !environment.CODEX_API_KEY?.trim() && !environment.OPENAI_API_KEY?.trim() && !environment.PAPERCLIP_AI_PROVIDER_KEY?.trim()) {
      let linked = false;
      try {
        const authPath = join(sourceCodexHome, "auth.json");
        linked = (await lstat(authPath)).isSymbolicLink();
        if (linked && !context.managedAiCredentialHome?.trim()) {
          const field = environment.CODEX_HOME?.trim() ? "env.CODEX_HOME" : "operator CODEX_HOME";
          throw new Error(`${field} uses a linked auth.json that Paperclip Runner tasks cannot read. Choose Legacy runner in Advanced or use a managed Codex Connection.`);
        }
        const resolvedAuthPath = await realpath(authPath);
        const source = await stat(resolvedAuthPath);
        if (!source.isFile() || source.uid !== process.getuid?.()) throw new Error("Invalid Codex source credential owner.");
        if (linked) sourceAuthJson = await readLocalAiCredentialFile(resolvedAuthPath);
        credentialRefreshAuthPath = resolvedAuthPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (linked) throw new Error("Codex authentication required: the selected credential link is unavailable.");
      }
    }
    let receipt: Awaited<ReturnType<typeof probeNativeRunnerEnvironment>>;
    if (context.executionTarget?.kind === "remote") {
      receipt = await probeRemoteNativeCodex({ context, model, environment, sourceCodexHome: sourceCodexHome ?? "", credentialRefreshAuthPath, sourceAuthJson, timeoutMs,
        ...(typeof effort === "string" && effort ? { reasoningEffort: effort } : {}) });
    } else {
      const runnerBinary = resolvePaperclipRunnerBinary();
      runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "paperclip-native-setup-")));
      receipt = await probePreparedNativeRuntime(runtimeDirectory, async () => {
        const probeSourceCodexHome = await prepareProbeCodexSource(runtimeDirectory!, sourceCodexHome ?? "", sourceAuthJson);
        return { runtimeDirectory: runtimeDirectory!, provider, model, environment, timeoutMs,
          ...(provider === "codex" && typeof effort === "string" && effort ? { reasoningEffort: effort } : {}),
          onCleanupConfirmed: async () => { await rm(runtimeDirectory!, { recursive: true, force: true }); },
          transportOptions: { runnerBinary, sourceCodexHome: probeSourceCodexHome, externallySandboxed: false },
          ...(credentialRefreshAuthPath ? { onCodexCredentialRefresh: async (filename: string) => {
            if (filename !== join(runtimeDirectory!, "codex-home", "auth.json")) throw new Error("The native Codex credential refresh handoff is invalid.");
            await copyBackCodexAuth({ hostAuthPath: credentialRefreshAuthPath!, log: () => {}, readSandboxAuth: async () => Buffer.from(await readLocalAiCredentialFile(filename)) });
          } } : {}),
        };
      });
    }
    if (receipt.helloProbePassed !== true || receipt.provider !== provider || typeof receipt.effectiveModel !== "string" || !receipt.effectiveModel.trim() || receipt.effectiveModel === "unknown" || (model !== null && receipt.effectiveModel !== model)
      || receipt.providerDriver !== "codex_app_server") throw new Error("The selected native runtime returned an incompatible account or model verification receipt.");
    return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(), checks: [{ code: `${provider}_hello_probe_passed`, level: "info",
      message: `The native ${provider} runtime verified the selected account and model in ${remote ? "the selected environment" : "the Paperclip host"}.` }] };
  } catch (error) {
    const message = redactNativeProbeMessage(error instanceof Error ? error.message : "The selected native runtime could not verify this account.", { ...environment, ...(sourceAuthJson ? { [authKey]: sourceAuthJson } : {}) });
    const authentication = /(?:invalid (?:api[- ]?key|auth(?:entication)? token)|authentication (?:failed|required)|unauthenticated|unauthorized|not authenticated|please (?:log|sign) in|not logged in|\b(?:401|403)\b)/i.test(message);
    const rejectedModel = provider === "codex" ? CODEX_CHATGPT_MODEL_REJECTION_RE.exec(message)?.[1] : undefined;
    const retirementHint = rejectedModel ? codexChatGptRetirementHint(rejectedModel) : null;
    return { adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: `${provider}_hello_probe_${authentication ? "auth_required" : /timed out/i.test(message) ? "timeout" : "failed"}`, level: "error", message,
      hint: retirementHint ?? "Check the selected account, model access, and native runtime prerequisites, then retry. Legacy runner is available explicitly in Advanced." },
      ...(authentication && provider === "codex" ? [{ code: ADAPTER_AUTH_MISSING_CHECK_CODE, level: "error" as const,
        message: "The selected Codex account needs authentication.",
        hint: "Sign in to Codex or choose an authenticated account, then test again." }] : [])] };
  }
}
