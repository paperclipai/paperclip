import { existsSync } from "node:fs";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipRunnerTransport, type PaperclipRunnerTransport } from "@paperclipai/adapter-utils/runner-connectivity";
import type { RunnerExecutionDriver } from "../../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";
import type { NativeRunTrace } from "./native-run-trace.js";

type ConnectionRegistration = NonNullable<RunnerExecutionDriver["controlPlaneRegistration"]>;
type RunnerIdentity = Parameters<ConnectionRegistration>[1];

export interface NativeRunnerExecutionDriverInput {
  target: AdapterExecutionTarget;
  binding: Omit<Parameters<typeof registerRunnerPrpAuthority>[0], "authority">;
  runnerIngressAuthorized?: boolean;
  runnerPublicUrl?: string | null;
  runnerCaBundlePath?: string | null;
  /** Validate and stage environment resources before process dispatch. */
  prepareRemote?: (mode: "listen_ws" | "dial_wss") => Promise<void>;
  mapCaBundle?: (sourcePath: string) => string | Promise<string>;
  processStarted?: Promise<void>;
  processIdentityReady?: Promise<void>;
  beforeConnect?: (identity?: RunnerIdentity) => Promise<void>;
  checkpoint?: Awaited<ReturnType<ConnectionRegistration>>["checkpoint"];
  process?: Omit<RunnerExecutionDriver, "controlPlaneRegistration">;
  trace?: NativeRunTrace;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

async function measureNativeRunnerSpan<T>(
  trace: NativeRunTrace | undefined,
  name: string,
  fn: () => Promise<T>,
  options: { parentName?: string } = {},
): Promise<T> {
  return trace ? trace.measure(name, fn, options) : fn();
}

/**
 * Select the remote runner transport before any artifact is staged or provider
 * endpoint is acquired. Sandbox ingress is available only to a run already
 * authorized by native runtime selection.
 */
export function resolveRemoteRunnerTransportMode(input: {
  target: AdapterExecutionTarget;
  runnerIngressAuthorized: boolean;
}): "listen_ws" | "dial_wss" {
  if (input.target.kind !== "remote") {
    throw new Error("runner_transport_ineligible: remote target is required");
  }
  const requiredMode =
    input.target.transport === "sandbox" &&
    input.target.effectiveCapabilities?.runnerWebSocketIngress === true
      ? "listen_ws"
      : "dial_wss";
  if (requiredMode === "listen_ws" && !input.runnerIngressAuthorized) {
    throw new Error("runner_ingress_unavailable");
  }
  return requiredMode;
}

type RemotePreparation = Pick<NativeRunnerExecutionDriverInput,
  "target" | "runnerIngressAuthorized" | "runnerPublicUrl" | "runnerCaBundlePath" | "prepareRemote"> & { runId: string };

async function resolveOutboundTransport(input: RemotePreparation): Promise<PaperclipRunnerTransport> {
  const transport = await resolvePaperclipRunnerTransport({ target: input.target, runId: input.runId,
    localConnectUrl: "ws://127.0.0.1/unused", runnerPublicUrl: input.runnerPublicUrl,
    runnerCaBundlePath: input.runnerCaBundlePath, runnerIngressAuthorized: input.runnerIngressAuthorized === true });
  if (transport.mode === "direct_outbound" && transport.caBundlePath && !existsSync(transport.caBundlePath)) {
    throw new Error("runner_direct_wss_failed: configured runner CA bundle is unavailable");
  }
  return transport;
}

/** Resolve artifacts before provider-profile binding. Endpoint acquisition stays
 * in connection registration; outbound eligibility is checked before staging.
 */
export async function prepareNativeRemoteRunner(input: RemotePreparation) {
  const mode = resolveRemoteRunnerTransportMode({ target: input.target,
    runnerIngressAuthorized: input.runnerIngressAuthorized === true });
  if (mode === "dial_wss") await resolveOutboundTransport(input);
  if (!input.prepareRemote) throw new Error("runner_remote_preparation_unavailable");
  await input.prepareRemote(mode);
}

/** Built-in environment lifecycle. PRP commands and authentication are shared;
 * only environment preparation, process ownership, and connection routing vary.
 */
export function createNativeRunnerExecutionDriver(input: NativeRunnerExecutionDriverInput): RunnerExecutionDriver {
  return {
    ...input.process,
    controlPlaneRegistration: async (authority, attachmentIdentity) => {
      await input.beforeConnect?.(attachmentIdentity);
      return measureNativeRunnerSpan(
        input.trace,
        "runner.transport.connect",
        async () => {
          if (input.target.kind === "local") {
            const selectedAtMs = Date.now();
            await input.trace?.record({
              name: "runner.transport.selected",
              parentName: "runner.transport.connect",
              startedAtMs: selectedAtMs,
              endedAtMs: selectedAtMs,
              attributes: {
                mode: "local_loopback",
                connectionOwner: "runnerd",
              },
            });
            await input.onLog?.(
              "stderr",
              "[paperclip-runner] transport mode=local_loopback state=connecting\n",
            );
            const registration = await measureNativeRunnerSpan(
              input.trace,
              "runner.prp.route.register",
              () =>
                registerRunnerPrpAuthority({
                  ...input.binding,
                  runId:
                    attachmentIdentity?.runId ??
                    input.binding.runId,
                  authority,
                }),
            );
            return {
              ...registration,
              startupFailureCode: "runner_local_connect_failed" as const,
            };
          }

          if (!input.prepareRemote) throw new Error("runner_remote_preparation_unavailable");
          const requiredMode = resolveRemoteRunnerTransportMode({
            target: input.target,
            runnerIngressAuthorized: input.runnerIngressAuthorized === true,
          });
          let transport: PaperclipRunnerTransport;
          if (requiredMode === "dial_wss") {
            // Validate eligibility before staging any artifact.
            transport = await measureNativeRunnerSpan(
              input.trace,
              "runner.transport.resolve",
              () => resolveOutboundTransport({ ...input, runId: attachmentIdentity?.runId ?? input.binding.runId }),
            );
            await measureNativeRunnerSpan(
              input.trace,
              "runner.artifact.prepare",
              () => input.prepareRemote!(requiredMode),
            );
          } else {
            await measureNativeRunnerSpan(
              input.trace,
              "runner.artifact.prepare",
              () => input.prepareRemote!(requiredMode),
            );
            // Provider endpoint acquisition happens only after runnerd is staged
            // and its listener capability has been verified.
            transport = await measureNativeRunnerSpan(
              input.trace,
              "runner.ingress.acquire",
              () =>
                resolvePaperclipRunnerTransport({
                  target: input.target,
                  runId:
                    attachmentIdentity?.runId ??
                    input.binding.runId,
                  localConnectUrl: "ws://127.0.0.1/unused",
                  runnerPublicUrl: input.runnerPublicUrl,
                  runnerCaBundlePath: input.runnerCaBundlePath,
                  runnerIngressAuthorized: true,
                }),
            );
          }

          const selectedAtMs = Date.now();
          await input.trace?.record({
            name: "runner.transport.selected",
            parentName: "runner.transport.connect",
            startedAtMs: selectedAtMs,
            endedAtMs: selectedAtMs,
            attributes: {
              mode: transport.mode,
              connectionOwner:
                transport.mode === "provider_ingress"
                  ? "paperclip"
                  : "runnerd",
            },
          });

          await input.onLog?.(
            "stderr",
            `[paperclip-runner] transport mode=${transport.mode} state=connecting\n`,
          );

          if (transport.mode === "direct_outbound") {
            const caBundlePath = transport.caBundlePath && input.mapCaBundle
              ? await input.mapCaBundle(transport.caBundlePath)
              : transport.caBundlePath;
            const inbound = await measureNativeRunnerSpan(
              input.trace,
              "runner.prp.route.register",
              () =>
                registerRunnerPrpAuthority({
                  ...input.binding,
                  runId:
                    attachmentIdentity?.runId ??
                    input.binding.runId,
                  authority,
                }),
              { parentName: "runner.transport.connect" },
            );
            return {
              connection: {
                mode: "connect" as const,
                connectUrl: transport.connectUrl,
                ...(caBundlePath ? { caBundlePath } : {}),
              },
              startupFailureCode: "runner_direct_wss_failed" as const,
              checkpoint: input.checkpoint,
              ready: input.processIdentityReady ? async () => { await input.processIdentityReady; } : undefined,
              release: () => inbound.release(),
            };
          }

          if (transport.mode !== "provider_ingress") {
            throw new Error("runner_transport_mode_changed_after_dispatch");
          }
          if (!input.processStarted) {
            await transport.ingress.close();
            throw new Error("runner_process_start_barrier_unavailable");
          }
          let outbound: ReturnType<typeof connectRunnerPrpIngress> | null =
            null;
          let activation: Promise<void> | null = null;
          return {
            connection: {
              mode: "listen" as const,
              listenAddress: transport.listenAddress,
              listenPort: transport.listenPort,
              listenPath: transport.listenPath,
            },
            activate: () => {
              activation = measureNativeRunnerSpan(
                input.trace,
                "runner.transport.activation",
                async () => {
                  await measureNativeRunnerSpan(
                    input.trace,
                    "runner.ingress.wait_for_process",
                    () => input.processStarted!,
                  );
                  outbound = connectRunnerPrpIngress({
                    authority,
                    endpoint: transport.ingress,
                    onStateChange: (state, failureCode) => {
                      void input.onLog?.(
                        "stderr",
                        `[paperclip-runner] transport mode=provider_ingress state=${state}${failureCode ? ` failure=${failureCode}` : ""}\n`,
                      );
                    },
                  });
                },
                { parentName: "runner.session.startup" },
              );
              // Cancellation can release the sandbox while activation is
              // still waiting for the remote runner process. Attach a
              // rejection observer immediately; `ready()` still awaits the
              // original promise and reports the same startup failure, but
              // an early teardown can no longer crash the controller with
              // an unhandled plugin RPC rejection.
              void activation.catch(() => undefined);
            },
            ready: async () => {
              await measureNativeRunnerSpan(
                input.trace,
                "runner.transport.ready",
                async () => {
                  await activation;
                  if (!outbound)
                    throw new Error("runner_ingress_unavailable");
                  await measureNativeRunnerSpan(
                    input.trace,
                    "runner.prp.authenticate",
                    () => outbound!.ready,
                  );
                  await input.processIdentityReady;
                },
                { parentName: "runner.session.startup" },
              );
            },
            get failure() {
              return outbound?.failure;
            },
            startupFailureCode: "runner_ingress_unavailable" as const,
            checkpoint: input.checkpoint,
            release: async () => {
              if (outbound) await outbound.close();
              else await transport.ingress.close();
            },
          };
        },
      );
    },
  };
}
