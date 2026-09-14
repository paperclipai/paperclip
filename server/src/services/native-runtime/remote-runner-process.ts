import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { AdapterProcessSpawnMetadata } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseRemoteProcessLaunchReceipt, type RemoteProcessIdentity } from "@paperclipai/adapter-utils/remote-process-identity";
import { controlRemoteProcess } from "@paperclipai/adapter-utils/remote-process-control";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RunnerProcessLaunchSpec, RunnerProcessHandle } from "../../vendor/paperclip-runner/index.js";
import { redactSensitiveText } from "../../redaction.js";
import type { NativeRunTrace } from "./native-run-trace.js";
import { remoteRunnerLaunchScripts } from "./remote-runner-launch.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function processEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function readRemoteRunnerState(input: {
  runner: CommandManagedRuntimeRunner;
  stateDirectory: string;
}): Promise<Record<string, unknown>> {
  const statePath = posix.join(input.stateDirectory, "runner-state.json");
  const escapedPath = statePath.replaceAll("'", "'\\''");
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", `test -f '${escapedPath}' && base64 < '${escapedPath}'`],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runner_remote_state_unavailable");
  }
  return record(
    JSON.parse(
      Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8"),
    ),
  );
}

const REMOTE_RUNNER_PROCESS_IDENTITY_WAIT_MS = 20_000;
const REMOTE_RUNNER_PROCESS_POLL_MS = 1_000;

/** Host-owned controls for the exact launched process. `pending` only defers
 * observation during a handoff; it grants neither liveness nor signal authority.
 * Supplying this interface disables generic commands for ongoing monitoring. */
export interface RemoteRunnerProcessControls {
  inspect(owner: RemoteProcessIdentity): Promise<"running" | "exited" | "pending" | "unverified" | "mismatch">;
  signal(owner: RemoteProcessIdentity, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<"signalled" | "exited" | "unverified" | "mismatch">;
  readState(owner: RemoteProcessIdentity): Promise<Record<string, unknown>>;
  readDiagnostics?(owner: RemoteProcessIdentity): Promise<string>;
}

const REMOTE_RUNNER_IDENTITY_CHECK_SCRIPT =
  'set -eu; identity_path=$1; expected_nonce=$2; expected_runner_id=$3; expected_pid=$4; test -f "$identity_path" && test ! -L "$identity_path" || exit 3; { IFS= read -r nonce; IFS= read -r pid; IFS= read -r started_at; IFS= read -r runner_id; } < "$identity_path"; test "$nonce" = "$expected_nonce" && test "$runner_id" = "$expected_runner_id" && test "$pid" = "$expected_pid" && test -n "$started_at" || exit 4; kill -0 "$pid" 2>/dev/null || exit 3; if test -r "/proc/$pid/cmdline"; then command_line=$(tr "\\000" "\\n" < "/proc/$pid/cmdline"); printf "%s\\n" "$command_line" | grep -Fqx -- "--runner-id" || exit 4; printf "%s\\n" "$command_line" | grep -Fqx -- "$expected_runner_id" || exit 4; fi';

const REMOTE_RUNNER_FAILED_IDENTITY_CLEANUP_SCRIPT =
  'set -eu; identity_path=$1; expected_nonce=$2; expected_runner_id=$3; marker_wait=0; while { test ! -f "$identity_path" || test -L "$identity_path"; } && test "$marker_wait" -lt 50; do marker_wait=$((marker_wait + 1)); sleep 0.1; done; test -f "$identity_path" && test ! -L "$identity_path" || exit 3; { IFS= read -r nonce; IFS= read -r pid; IFS= read -r started_at; IFS= read -r runner_id; } < "$identity_path"; test "$nonce" = "$expected_nonce" && test "$runner_id" = "$expected_runner_id" && test -n "$started_at" || exit 4; case "$pid" in ""|*[!0-9]*) exit 4 ;; esac; test "$pid" -gt 0 || exit 4; if kill -0 "$pid" 2>/dev/null; then if test -r "/proc/$pid/cmdline"; then command_line=$(tr "\\000" "\\n" < "/proc/$pid/cmdline"); printf "%s\\n" "$command_line" | grep -Fqx -- "--runner-id" || exit 4; printf "%s\\n" "$command_line" | grep -Fqx -- "$expected_runner_id" || exit 4; fi; signal_target=$pid; if command -v ps >/dev/null 2>&1; then session_id=$(ps -o sid= -p "$pid" 2>/dev/null | tr -d " ") || true; if test "$session_id" = "$pid"; then signal_target="-$pid"; fi; fi; kill -TERM -- "$signal_target" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; term_wait=0; while kill -0 "$pid" 2>/dev/null && test "$term_wait" -lt 50; do term_wait=$((term_wait + 1)); sleep 0.1; done; if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "$signal_target" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; kill_wait=0; while kill -0 "$pid" 2>/dev/null && test "$kill_wait" -lt 50; do kill_wait=$((kill_wait + 1)); sleep 0.1; done; fi; kill -0 "$pid" 2>/dev/null && exit 5; fi; test -f "$identity_path" && test ! -L "$identity_path" || exit 4; { IFS= read -r final_nonce; IFS= read -r final_pid; IFS= read -r final_started_at; IFS= read -r final_runner_id; } < "$identity_path"; test "$final_nonce" = "$nonce" && test "$final_pid" = "$pid" && test "$final_started_at" = "$started_at" && test "$final_runner_id" = "$runner_id" || exit 4; rm -f -- "$identity_path"';

export function parseRemoteRunnerProcessIdentity(
  value: string,
  expected: { nonce: string; runnerInstanceId: string },
): { pid: number; startedAt: string } | null {
  const [nonce, rawPid, startedAt, runnerInstanceId, ...remainder] = value
    .trim()
    .split("\n");
  const pid = Number(rawPid);
  if (
    remainder.length > 0 ||
    nonce !== expected.nonce ||
    runnerInstanceId !== expected.runnerInstanceId ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !startedAt ||
    Number.isNaN(new Date(startedAt).getTime())
  ) {
    return null;
  }
  return { pid, startedAt };
}

async function waitForRemoteRunnerProcessIdentity(input: {
  runner: CommandManagedRuntimeRunner;
  identityPath: string;
  nonce: string;
  runnerInstanceId: string;
}): Promise<{ pid: number; startedAt: string }> {
  const deadline = Date.now() + REMOTE_RUNNER_PROCESS_IDENTITY_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await input.runner
      .execute({
        command: "sh",
        args: [
          "-c",
          'test -f "$1" && test ! -L "$1" && cat -- "$1"',
          "paperclip-runner-process-identity",
          input.identityPath,
        ],
        bypassSession: true,
        timeoutMs: 2_000,
      })
      .catch(() => null);
    const identity =
      result && result.exitCode === 0 && !result.timedOut
        ? parseRemoteRunnerProcessIdentity(result.stdout, input)
        : null;
    if (identity) return identity;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("runner_remote_process_identity_unavailable");
}

async function cleanupRemoteRunnerAfterIdentityFailure(input: {
  runner: CommandManagedRuntimeRunner;
  identityPath: string;
  nonce: string;
  runnerInstanceId: string;
}): Promise<boolean> {
  const result = await input.runner
    .execute({
      command: "sh",
      args: [
        "-c",
        REMOTE_RUNNER_FAILED_IDENTITY_CLEANUP_SCRIPT,
        "paperclip-runner-identity-failure-cleanup",
        input.identityPath,
        input.nonce,
        input.runnerInstanceId,
      ],
      bypassSession: true,
      timeoutMs: 20_000,
    })
    .catch(() => null);
  return result?.exitCode === 0 && result.timedOut === false;
}

export function createRemoteRunnerProcessLauncher(input: {
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  runner: CommandManagedRuntimeRunner;
  /** May follow the same verified live process across run leases. Launch,
   * artifact preparation and failed-launch cleanup retain the original runner. */
  processRunner?: Pick<CommandManagedRuntimeRunner, "execute">;
  /** Requires a kernel launch receipt. It is never used for launch or failed
   * launch cleanup, and missing/denied methods never fall back to execute. */
  processControls?: RemoteRunnerProcessControls;
  remoteBinary: string;
  processIdentityPath: string;
  stateDirectory: string;
  diagnosticsDirectory: string;
  runnerInstanceId: string;
  ensureArtifact?: () => Promise<void>;
  onSpawn?: (meta: AdapterProcessSpawnMetadata) => Promise<void>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  trace?: NativeRunTrace;
  onRunnerProcessSpawned?: () => void;
}): (spec: RunnerProcessLaunchSpec) => RunnerProcessHandle {
  const runner = input.runner;
  const processRunner = input.processRunner ?? runner;
  const processControls = input.processControls;
  const requiresKernelReceipt = input.target.transport === "sandbox" && input.target.providerKey === "daytona";
  if (processControls && !requiresKernelReceipt) throw new Error("runner_remote_process_controls_require_kernel_receipt");
  return (spec) => {
    let spawnedMetadata: AdapterProcessSpawnMetadata | undefined;
    let remoteProcessIdentity: RemoteProcessIdentity | null = null;
    let signalFailure = false;
    let acceptsSignals = true;
    const signalRequests = new Set<Promise<void>>();
    let launchedIdentity: {
      nonce: string;
      pid: number;
      startedAt: string;
    } | null = null;
    const child: RunnerProcessHandle["child"] = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: (requestedSignal) => {
        const identity = launchedIdentity;
        if (!identity || !acceptsSignals) return false;
        const signal =
          requestedSignal === "SIGKILL" || requestedSignal === 9
            ? "KILL"
            : requestedSignal === "SIGINT" || requestedSignal === 2
              ? "INT"
              : "TERM";
        if (requiresKernelReceipt) {
          if (!remoteProcessIdentity) return false;
          const requested = `SIG${signal}` as "SIGKILL" | "SIGINT" | "SIGTERM";
          const owner = { ...remoteProcessIdentity };
          // Invoke immediately to bind the capability at child.kill time. The
          // async boundary still catches a synchronous rejection without
          // deferring the operation into a newer run's authority.
          const request = (async () => {
            const state = await (processControls
              ? processControls.signal(owner, requested)
              : controlRemoteProcess(processRunner, owner, { action: "signal", signal: requested }));
            if (state === "signalled" || state === "exited") return;
            signalFailure = true;
            await input.onLog?.("stderr", "[paperclip] Remote runner cancellation could not be verified.\n").catch(() => undefined);
          })().catch(() => { signalFailure = true; });
          signalRequests.add(request);
          void request.finally(() => signalRequests.delete(request));
          return true;
        }
        // Other providers retain their legacy marker-based control path.
        const request = processRunner.execute({
          command: "sh",
          args: [
            "-c",
            `${REMOTE_RUNNER_IDENTITY_CHECK_SCRIPT}; kill -${signal} "$expected_pid"`,
            "paperclip-runner-signal",
            input.processIdentityPath,
            identity.nonce,
            input.runnerInstanceId,
            String(identity.pid),
          ],
          bypassSession: true,
          timeoutMs: 10_000,
        }).then(result => {
          if (result.exitCode !== 0 || result.timedOut) signalFailure = true;
        }).catch(() => { signalFailure = true; });
        signalRequests.add(request);
        void request.finally(() => signalRequests.delete(request));
        return true;
      },
    };
    const completion = (async () => {
      if (input.ensureArtifact) {
        if (input.trace) {
          await input.trace.measure(
            "runner.runtime.stage",
            input.ensureArtifact,
            { parentName: "runner.session.startup" },
          );
        } else {
          await input.ensureArtifact();
        }
      }
      const launchStartedAtMs = Date.now();
      // The provider's onSpawn callback is optional and some sandbox command
      // runners cannot report a remote pid until after the command has begun
      // streaming. Signal as soon as staging is complete and the launch RPC is
      // dispatched; this is late enough to avoid preview retries during staging
      // and early enough to avoid a callback-dependent deadlock.
      input.onRunnerProcessSpawned?.();
      await input.trace?.record({
        name: "runner.process.dispatch",
        parentName: "runner.session.startup",
        startedAtMs: launchStartedAtMs,
        endedAtMs: Date.now(),
        attributes: { target: "remote" },
      });
      const identityNonce = randomUUID();
      const launchScripts = remoteRunnerLaunchScripts(requiresKernelReceipt);
      const remoteArgs = [...spec.args];
      const diagnosticsArgumentIndex = remoteArgs.indexOf(
        "--diagnostics-directory",
      );
      if (diagnosticsArgumentIndex >= 0) {
        remoteArgs[diagnosticsArgumentIndex + 1] = input.diagnosticsDirectory;
      } else {
        remoteArgs.push("--diagnostics-directory", input.diagnosticsDirectory);
      }
      // Do not keep runnerd as the foreground command of a provider RPC. Some
      // sandbox command/session transports impose a provider-side lifetime on
      // that RPC even when Paperclip requests a longer timeout. Detach runnerd
      // into its own session instead; its own bounded diagnostics directory and
      // durable PRP state remain the authorities, and the controller monitors
      // the exact persisted process identity below.
      const launchResult = await runner.execute({
        command: "sh",
        args: [
          "-c",
          launchScripts.launch,
          "paperclip-runner-launch",
          input.processIdentityPath,
          identityNonce,
          input.runnerInstanceId,
          launchScripts.child,
          input.diagnosticsDirectory,
          input.remoteBinary,
          ...remoteArgs,
        ],
        cwd: input.target.remoteCwd,
        env: processEnvironment(spec.environment),
        timeoutMs: 20_000,
        bypassSession: true,
        onLog: requiresKernelReceipt ? undefined : input.onLog,
      });
      if (requiresKernelReceipt) {
        const receipt = parseRemoteProcessLaunchReceipt(launchResult.stdout, identityNonce);
        // Native runnerd must lead the dedicated session created by setsid.
        if (receipt && receipt.pid === receipt.processGroupId) remoteProcessIdentity = receipt;
      }
      if (launchResult.exitCode !== 0 || launchResult.timedOut) {
        const cleaned = requiresKernelReceipt && remoteProcessIdentity
          ? await controlRemoteProcess(runner, remoteProcessIdentity, { action: "stop_group" }) === "stopped"
          : false;
        throw new Error(
          (launchResult.timedOut
            ? "runner_remote_process_launch_timed_out"
            : "runner_remote_process_launch_failed") + (requiresKernelReceipt && !cleaned ? "_cleanup_unverified" : ""),
        );
      }
      let identity: { pid: number; startedAt: string };
      try {
        if (requiresKernelReceipt && !remoteProcessIdentity) throw new Error("runner_remote_process_identity_unavailable");
        // Wall time is display metadata; the kernel start ticks authorize
        // control. Daytona never reads an agent-writable identity marker.
        identity = remoteProcessIdentity ? { pid: remoteProcessIdentity.pid, startedAt: new Date(launchStartedAtMs).toISOString() }
          : await waitForRemoteRunnerProcessIdentity({
          runner,
          identityPath: input.processIdentityPath,
          nonce: identityNonce,
          runnerInstanceId: input.runnerInstanceId,
        });
        // Keep cancellation available while the host awaits durable persistence.
        launchedIdentity = { nonce: identityNonce, ...identity };
        child.pid = identity.pid;
        spawnedMetadata = {
          pid: identity.pid, processGroupId: null, startedAt: identity.startedAt,
          processLocation: "remote", ...(remoteProcessIdentity ? { remoteProcessIdentity } : {}),
        };
        await input.onSpawn?.(structuredClone(spawnedMetadata));
      } catch {
        const cleanupStartedAtMs = Date.now();
        const cleaned = requiresKernelReceipt
          ? Boolean(remoteProcessIdentity && await controlRemoteProcess(runner, remoteProcessIdentity, { action: "stop_group" }) === "stopped")
          : await cleanupRemoteRunnerAfterIdentityFailure({
          runner,
          identityPath: input.processIdentityPath,
          nonce: identityNonce,
          runnerInstanceId: input.runnerInstanceId,
        });
        await input.trace?.record({
          name: "runner.process.identity_failure_cleanup",
          parentName: "runner.session.startup",
          startedAtMs: cleanupStartedAtMs,
          endedAtMs: Date.now(),
          attributes: { cleaned },
        });
        if (!cleaned) {
          throw new Error(
            "runner_remote_process_identity_unavailable_cleanup_failed",
          );
        }
        throw new Error("runner_remote_process_identity_unavailable");
      }
      await input.trace?.record({
        name: "runner.process.launch",
        parentName: "runner.session.startup",
        startedAtMs: launchStartedAtMs,
        endedAtMs: Date.now(),
        attributes: { identitySource: requiresKernelReceipt ? "kernel_receipt" : "remote_marker", detached: true },
      });

      while (true) {
        await Promise.all(signalRequests);
        if (signalFailure) throw new Error("runner_remote_process_signal_unverified");
        const kernelState = remoteProcessIdentity ? processControls
          ? await processControls.inspect({ ...remoteProcessIdentity })
          : await controlRemoteProcess(processRunner, remoteProcessIdentity, { action: "inspect" }) : null;
        // A signal issued while inspection was awaiting must settle before an
        // exit observation can complete the handle and discard its failure.
        await Promise.all(signalRequests);
        if (signalFailure) throw new Error("runner_remote_process_signal_unverified");
        if (kernelState === "pending") {
          await new Promise<void>(resolve => setTimeout(resolve, REMOTE_RUNNER_PROCESS_POLL_MS));
          continue;
        }
        if (processControls && kernelState !== "running" && kernelState !== "exited") {
          throw new Error("runner_remote_process_verification_unavailable");
        }
        if (kernelState === "unverified") throw new Error("runner_remote_process_verification_unavailable");
        const observed = kernelState ? { exitCode: kernelState === "running" ? 0 : kernelState === "mismatch" ? 4 : 3, timedOut: false }
          : await processRunner.execute({
          command: "sh",
          args: [
            "-c",
            REMOTE_RUNNER_IDENTITY_CHECK_SCRIPT,
            "paperclip-runner-monitor",
            input.processIdentityPath,
            identityNonce,
            input.runnerInstanceId,
            String(identity.pid),
          ],
          bypassSession: true,
          timeoutMs: 10_000,
        });
        if (observed.exitCode === 0 && !observed.timedOut) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, REMOTE_RUNNER_PROCESS_POLL_MS),
          );
          continue;
        }
        // Once exit is observed, diagnostics must not reopen signal authority.
        // Drain a signal that raced the observation before reporting completion.
        acceptsSignals = false;
        await Promise.all(signalRequests);
        if (signalFailure) throw new Error("runner_remote_process_signal_unverified");
        child.exitCode = null;
        const identityMismatch = observed.exitCode === 4;
        const diagnostic = processControls ? await Promise.resolve().then(async () => ({
          stdout: await processControls.readDiagnostics?.({ ...remoteProcessIdentity! }) ?? "",
          exitCode: 0, timedOut: false,
        })).catch(() => null) : await processRunner
          .execute({
            command: "sh",
            args: [
              "-c",
              'set -eu; directory=$1; file="$directory/runnerd.stderr.log"; test -d "$directory" && test ! -L "$directory" && test -f "$file" && test ! -L "$file"; tail -c 65536 -- "$file"',
              "paperclip-runner-diagnostics",
              input.diagnosticsDirectory,
            ],
            bypassSession: true,
            timeoutMs: 10_000,
          })
          .catch(() => null);
        const diagnosticTail =
          diagnostic && diagnostic.exitCode === 0 && !diagnostic.timedOut
            ? redactSensitiveText(diagnostic.stdout).slice(-16_384).trim()
            : "";
        const durableState = await Promise.resolve().then(() => processControls
          ? processControls.readState({ ...remoteProcessIdentity! })
          : readRemoteRunnerState({ runner: processRunner, stateDirectory: input.stateDirectory })
        ).catch(() => null);
        const lifecycle =
          typeof durableState?.lifecycle === "string"
            ? durableState.lifecycle
            : "unavailable";
        const recoverableFailure =
          typeof durableState?.recoverableFailure === "string"
            ? durableState.recoverableFailure
            : typeof durableState?.recoverable_failure === "string"
              ? durableState.recoverable_failure
              : null;
        const stateDiagnostics = Array.isArray(durableState?.diagnostics)
          ? durableState.diagnostics
              .filter((value): value is string => typeof value === "string")
              .slice(-4)
              .map((value) => redactSensitiveText(value).slice(-1_000))
          : [];
        const stateSummary = `runner_remote_process_exited lifecycle=${lifecycle}${recoverableFailure ? ` recoverableFailure=${redactSensitiveText(recoverableFailure).slice(-1_000)}` : ""}${stateDiagnostics.length > 0 ? ` diagnostics=${JSON.stringify(stateDiagnostics)}` : ""}`;
        return {
          code: null,
          signal: null,
          stdout: "",
          stderr: identityMismatch
            ? "runner_remote_process_identity_mismatch"
            : diagnosticTail || stateSummary,
        };
      }
    })();
    return { child, completion, processLocation: "remote", processGroupId: null,
      get startedAt() { return spawnedMetadata?.startedAt; },
      get remoteProcessIdentity() { return spawnedMetadata?.remoteProcessIdentity ? { ...spawnedMetadata.remoteProcessIdentity } : undefined; },
    };
  };
}
