import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import { probeNativeRunnerEnvironment, resolveSourceCodexHome } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerBinary } from "./native-codex-runner.js";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { resolvePaperclipRunnerTransport } from "@paperclipai/adapter-utils/runner-connectivity";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";


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

/** Remote setup shares task artifacts, PRP, isolated launch home, and process ownership. */
async function probeRemoteNativeCodex(options: {
  context: AdapterEnvironmentTestContext;
  model: string | null;
  reasoningEffort?: string;
  environment: Record<string, string>;
  sourceCodexHome: string;
  credentialRefreshAuthPath?: string;
  timeoutMs: number;
}) {
  const target = options.context.executionTarget;
  if (target?.kind !== "remote") throw new Error("Native setup requires the selected remote execution target.");
  const { createRemoteNativeArtifactPreparation, createRemoteRunnerProcessLauncher, stageRemoteRunnerFile, readRemoteRunnerState } = await import("./native-session-executor.js");
  const runner = target.transport === "ssh" ? createNativeSshCommandRunner({ spec: target.spec, defaultCwd: target.remoteCwd }) : target.runner;
  if (!runner) throw new Error("runner_transport_ineligible: remote process runner is unavailable");
  const id = crypto.randomUUID();
  const runnerInstanceId = `setup-${id}`;
  // Eligibility is checked before writing to the selected host, using the
  // same server-owned public URL and CA configuration as ordinary tasks.
  const ingress = target.transport === "sandbox" && target.effectiveCapabilities?.runnerWebSocketIngress === true;
  // Outbound eligibility is read-only; acquire provider ingress only after the
  // exact daemon has been prepared and its listener capability verified.
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
  const controllerRunnerBinary = explicitRunner || resolvePaperclipRunnerBinary();
  const artifacts = createRemoteNativeArtifactPreparation({ target, runner, remoteBinary, controllerRunnerBinary, remoteRuntimeRoot: remoteRoot, remoteCodexBinary,
    runnerRemoteBinaryPath: explicitRunner, runnerRemoteCodexPath: process.env.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH?.trim(), runnerRemoteCodexNpmSpec: remoteCodexNpmSpec, model: options.model });
  const requireSuccess = (result: { timedOut: boolean; exitCode: number | null }, message: string) => {
    if (result.timedOut || result.exitCode !== 0) throw new Error(message);
  };
  const runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "paperclip-native-setup-")));
  let remoteDirectoryCreated = false;
  let remoteCaBundlePath: string | undefined;
  let signalSpawned!: () => void;
  const spawned = new Promise<void>(resolve => { signalSpawned = resolve; });
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
        requireSuccess(created, "Native setup could not claim a private runtime directory.");
        remoteDirectoryCreated = true;
        await artifacts.prepare(ingress ? "listen_ws" : "dial_wss");
        if (outbound?.mode === "direct_outbound" && outbound.caBundlePath) {
          remoteCaBundlePath = posix.join(remoteRoot, "bin", "runner-ca-bundle.pem");
          await stageRemoteRunnerFile({ target, runner, sourcePath: outbound.caBundlePath, targetPath: remoteCaBundlePath, mode: 0o600 });
        }
        if (outbound?.mode === "direct_outbound") {
          const registration = await registerRunnerPrpAuthority({ companyId: options.context.companyId, runId: id, authority });
          return { connection: { mode: "connect" as const, connectUrl: outbound.connectUrl, ...(remoteCaBundlePath ? { caBundlePath: remoteCaBundlePath } : {}) },
            startupFailureCode: "runner_direct_wss_failed" as const, release: registration.release };
        }
        const transport = await resolvePaperclipRunnerTransport({ target, runId: id, localConnectUrl: "ws://127.0.0.1/unused", runnerIngressAuthorized: true });
        if (transport.mode !== "provider_ingress") throw new Error("runner_transport_ineligible: expected provider ingress");
        let connection: ReturnType<typeof connectRunnerPrpIngress> | undefined;
        let activation: Promise<void> | undefined;
        return {
          connection: { mode: "listen" as const, listenAddress: transport.listenAddress, listenPort: transport.listenPort, listenPath: transport.listenPath },
          activate: () => {
            activation = spawned.then(() => { connection = connectRunnerPrpIngress({ authority, endpoint: transport.ingress }); });
            void activation.catch(() => undefined);
          },
          ready: async () => { await activation; if (!connection) throw new Error("runner_ingress_unavailable"); await connection.ready; },
          get failure() { return connection?.failure; },
          startupFailureCode: "runner_ingress_unavailable" as const,
          release: async () => { if (connection) await connection.close(); else await transport.ingress.close(); },
        };
      },
      runnerProcessLauncher: createRemoteRunnerProcessLauncher({ target, runner, remoteBinary, stateDirectory: remoteStateDirectory,
        onRunnerProcessSpawned: signalSpawned, processIdentityPath: posix.join(remoteStateDirectory, "runner-process.identity"), diagnosticsDirectory: posix.join(remoteRoot, "diagnostics"), runnerInstanceId,
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
    ...(options.credentialRefreshAuthPath ? { onCodexCredentialRefresh: async (filename: string) => {
      if (filename !== posix.join(remoteFilesystemRoot, "codex-home", "auth.json")) throw new Error("The native Codex credential refresh handoff is invalid.");
      await copyBackCodexAuth({ hostAuthPath: options.credentialRefreshAuthPath!, log: () => {}, readSandboxAuth: async () => {
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
        requireSuccess(cleaned, "Native setup cleanup is incomplete; private recovery state was retained.");
      }
      await rm(runtimeDirectory, { recursive: true, force: true });
    },
  });
}

/** Codex readiness uses the same daemon, bound credentials and cleanup as task execution. */
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
  try {
    // Match task execution's closed host projection before the probe replaces
    // HOME. API keys never enter this projection from the ambient process.
    if (provider === "codex") {
      const { buildNativeProviderEnvironment } = await import("./native-session-executor.js");
      sourceCodexHome = context.managedAiCredentialHome ?? resolveSourceCodexHome(buildNativeProviderEnvironment(environment));
    }
    // Preserve refreshes in the authorized source account before deleting the
    // private probe home. API-key probes must never write to a host login.
    let credentialRefreshAuthPath: string | undefined;
    if (sourceCodexHome && !environment.OPENAI_API_KEY?.trim() && !environment.PAPERCLIP_AI_PROVIDER_KEY?.trim()) {
      try {
        credentialRefreshAuthPath = await realpath(join(sourceCodexHome, "auth.json"));
        const source = await stat(credentialRefreshAuthPath);
        if (!source.isFile() || source.uid !== process.getuid?.()) throw new Error("Invalid Codex source credential owner.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let receipt: Awaited<ReturnType<typeof probeNativeRunnerEnvironment>>;
    if (context.executionTarget?.kind === "remote") {
      receipt = await probeRemoteNativeCodex({ context, model, environment, sourceCodexHome: sourceCodexHome ?? "", credentialRefreshAuthPath, timeoutMs,
        ...(typeof effort === "string" && effort ? { reasoningEffort: effort } : {}) });
    } else {
      runtimeDirectory = await realpath(await mkdtemp(join(tmpdir(), "paperclip-native-setup-")));
      receipt = await probeNativeRunnerEnvironment({ runtimeDirectory, provider, model, environment, timeoutMs,
        ...(provider === "codex" && typeof effort === "string" && effort ? { reasoningEffort: effort } : {}),
        onCleanupConfirmed: async () => { await rm(runtimeDirectory!, { recursive: true, force: true }); },
        transportOptions: { runnerBinary: resolvePaperclipRunnerBinary(), sourceCodexHome: sourceCodexHome ?? "" },
        ...(credentialRefreshAuthPath ? { onCodexCredentialRefresh: async (filename: string) => {
          if (filename !== join(runtimeDirectory!, "codex-home", "auth.json")) throw new Error("The native Codex credential refresh handoff is invalid.");
          await copyBackCodexAuth({ hostAuthPath: credentialRefreshAuthPath!, log: () => {}, readSandboxAuth: async () => Buffer.from(await readLocalAiCredentialFile(filename)) });
        } } : {}),
      });
    }
    if (receipt.helloProbePassed !== true || receipt.provider !== provider || typeof receipt.effectiveModel !== "string" || !receipt.effectiveModel.trim() || receipt.effectiveModel === "unknown" || (model !== null && receipt.effectiveModel !== model)
      || receipt.providerDriver !== "codex_app_server") throw new Error("The selected native runtime returned an incompatible account or model verification receipt.");
    return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(), checks: [{ code: `${provider}_hello_probe_passed`, level: "info",
      message: `The native ${provider} runtime verified the selected account and model in ${remote ? "the selected environment" : "the Paperclip host"}.` }] };
  } catch (error) {
    const message = redactNativeProbeMessage(error instanceof Error ? error.message : "The selected native runtime could not verify this account.", environment);
    const authentication = /(?:invalid (?:api[- ]?key|auth(?:entication)? token)|authentication (?:failed|required)|unauthenticated|unauthorized|not authenticated|please (?:log|sign) in|not logged in|\b(?:401|403)\b)/i.test(message);
    return { adapterType: "paperclip_runner", status: "fail", testedAt: new Date().toISOString(), checks: [{ code: `${provider}_hello_probe_${authentication ? "auth_required" : /timed out/i.test(message) ? "timeout" : "failed"}`, level: "error", message,
      hint: "Check the selected account, model access, and native runtime prerequisites, then retry. Legacy runner is available explicitly in Advanced." },
      ...(authentication && provider === "codex" ? [{ code: ADAPTER_AUTH_MISSING_CHECK_CODE, level: "error" as const,
        message: "The selected Codex account needs authentication.",
        hint: "Sign in to Codex or choose an authenticated account, then test again." }] : [])] };
  }
}
