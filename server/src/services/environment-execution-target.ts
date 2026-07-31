import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { adapterSupportsRemoteManagedEnvironments } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { normalizeProviderFamily } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { parseObject } from "../adapters/utils.js";
import { getStartupTracer } from "../instrumentation.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

/** The minimal span surface the provider-exec seam calls. A real injected OTel
 * span satisfies it; the no-op tracer's span satisfies it too. */
type ExecSpan = {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
};

/** The minimal tracer surface the provider-exec seam calls. `getStartupTracer`
 * returns a real or no-op implementation that satisfies it. */
type ExecTracer = { startSpan(name: string): ExecSpan };

/**
 * Set a numeric span attribute only when the value is a finite number. A value
 * that is absent, `NaN`, or `Infinity` yields no attribute — never a misleading
 * `0`. This mirrors the host counter guard below and the `adapter-utils`
 * startup-step guard.
 */
function setFiniteNumberAttr(span: ExecSpan, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    span.setAttribute(key, value);
  }
}

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
  // The startup tracer for the provider-exec span. Defaults to the endpoint-
  // gated server tracer, which is a no-op when tracing is off. Tests inject a
  // recording tracer.
  tracer?: ExecTracer;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    // Keep this gate in lockstep with the shared capability metadata that the
    // environment selector and capabilities API expose; a drift here lets the
    // UI offer environments the runtime then refuses.
    if (!adapterSupportsRemoteManagedEnvironments(input.adapterType)) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand =
      input.leaseMetadata?.shellCommand === "bash" || input.leaseMetadata?.shellCommand === "sh"
        ? input.leaseMetadata.shellCommand
        : null;

    // Per-lease-runner cumulative counters for startup-step attribution (Open
    // Q1). Closed over by the `runner.execute` seam below and read back as
    // deltas by `measureStartupStep`.
    let execCount = 0;
    let providerExecMs = 0;
    let providerGetMs = 0;
    const accumulateProviderDurations = (metadata: Record<string, unknown> | undefined): void => {
      if (!metadata) return;
      const exec = metadata.durationMs;
      const get = metadata.getDurationMs;
      if (typeof exec === "number" && Number.isFinite(exec)) providerExecMs += exec;
      if (typeof get === "number" && Number.isFinite(get)) providerGetMs += get;
    };

    // The low-cardinality public provider family. A plugin-backed / operator-
    // defined key maps to `plugin`, so a raw unbounded key never rides a span.
    const providerFamily = normalizeProviderFamily(parsed.config.provider);
    // The endpoint-gated startup tracer (no-op when tracing is off). Tests inject
    // a recording tracer.
    const tracer = input.tracer ?? getStartupTracer();

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      // Run-log streaming defaults ON for sandbox environments so agent CLI
      // output reaches the UI mid-run; `streamRunLogs: false` is an explicit
      // opt-out back to batch-at-end delivery.
      streamRunLogs: parsed.config.streamRunLogs !== false,
      runner: input.environmentRuntime && input.lease
        ? {
            // Provider-backed sandbox RPCs do not surface bounded mid-stream
            // progress for a single stdin upload, so keep the capability disabled
            // here. The client falls back to the chunked upload path when this is
            // false.
            supportsSingleStreamStdinProgress: false,
            // Round-trip counter + provider-duration accumulators on the single
            // host→sandbox exec seam (Open Q1). `measureStartupStep` reads the
            // per-step delta of each via the `() => number` closures below. The
            // provider durations ride the exec result's free-form `metadata`
            // (set by the Daytona plugin), so no protocol/schema change is
            // needed and providers that omit them simply accumulate nothing.
            execCount: () => execCount,
            providerExecMs: () => providerExecMs,
            providerGetMs: () => providerGetMs,
            execute: async (commandInput) => {
              execCount += 1;
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              accumulateProviderDurations(result.metadata);
              // Emit one span for this host→sandbox exec (opt-in; a no-op tracer
              // when tracing is off). It carries ONLY closed-allowlist,
              // low-cardinality attributes: the normalized provider family, the
              // exit status (a two-value enum), and the host-received provider
              // durations (per field, only when finite). The full command, args,
              // env, stdout, and stderr never ride a span — not as an attribute
              // and not as an event. The span name is the fixed operation label.
              try {
                const span = tracer.startSpan("provider.execute");
                try {
                  span.setAttribute("provider", providerFamily);
                  span.setAttribute("exit", result.exitCode === 0 ? "ok" : "error");
                  setFiniteNumberAttr(span, "provider.exec.duration_ms", result.metadata?.durationMs);
                  setFiniteNumberAttr(span, "provider.get.duration_ms", result.metadata?.getDurationMs);
                } finally {
                  span.end();
                }
              } catch {
                // Observability must not change execution control flow.
              }
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
            // Expose the native file-sync capability only when the provider's
            // worker advertises BOTH sync verbs; otherwise leave syncIn/syncOut
            // undefined so the orchestrator keeps the byte-identical base64 path.
            ...(input.environmentRuntime.supportsSync({
              environment: input.environment as Environment,
              lease: input.lease,
            })
              ? {
                  syncIn: (operations) =>
                    input.environmentRuntime!.syncIn({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      operations,
                    }),
                  syncOut: (operations) =>
                    input.environmentRuntime!.syncOut({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      operations,
                    }),
                }
              : {}),
          }
        : undefined,
    };
  }

  if (
    !adapterSupportsRemoteManagedEnvironments(input.adapterType) ||
    input.environment.driver !== "ssh"
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    id: input.environment.id,
    driver: input.environment.driver as "ssh",
    config: parseObject(input.environment.config),
  });
  if (parsed.driver !== "ssh") {
    return null;
  }

  const remoteCwd =
    typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
      ? input.leaseMetadata.remoteCwd.trim()
      : parsed.config.remoteWorkspacePath;

  return {
    kind: "remote",
    transport: "ssh",
    environmentId: input.environment.id ?? null,
    leaseId: input.leaseId ?? null,
    remoteCwd,
    spec: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      privateKey: parsed.config.privateKey,
      knownHosts: parsed.config.knownHosts,
      strictHostKeyChecking: parsed.config.strictHostKeyChecking,
      remoteCwd,
    },
  };
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
