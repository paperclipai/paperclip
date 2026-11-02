import { createDb } from "@paperclipai/db";
import { closeIdleWarmNativeSessionsForRestart, executePaperclipNativeSession } from "../../services/native-runtime/native-session-executor.js";
import { dockerCommandRunner } from "./docker-command-runner.js";

// Separate TypeScript fixture import time from actual controller admission.
process.send?.({ ready: true });

process.once("message", async (input: {
  connectionString: string;
  container: string;
  ingressUrl: string;
  suspendAfterTurn?: boolean;
  transientBackpressureInspection?: boolean;
  options: Parameters<typeof executePaperclipNativeSession>[0];
}) => {
  const target = input.options.runnerExecutionTarget;
  if (target?.kind !== "remote") throw new Error("Expected remote worker target");
  try {
    const runner = dockerCommandRunner(input.container);
    let inspectionOverridden = false;
    const execute = runner.execute.bind(runner);
    runner.execute = async request => {
      const result = await execute(request);
      if (input.transientBackpressureInspection && !inspectionOverridden && result.exitCode === 0
        && request.args?.some(arg => arg.includes("base64 <") && arg.includes("runner-state.json"))) {
        // Only the preliminary read reports transient pressure. The subsequent
        // live-adoption owner must still inspect the actual Runner state.
        const state = JSON.parse(Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8"));
        inspectionOverridden = true;
        return { ...result, stdout: Buffer.from(JSON.stringify({ ...state, lifecycle: "backpressure" })).toString("base64") };
      }
      return result;
    };
    const result = await executePaperclipNativeSession({
      ...input.options,
      db: createDb(input.connectionString),
      runnerExecutionTarget: {
        ...target,
        runner,
        getRunnerIngressEndpoint: async ({ path }) => {
          const endpoint = {
            kind: "authenticated_websocket" as const,
            websocketUrl: `${input.ingressUrl}${path}`, secretHeaders: [], generation: input.container,
            refresh: async () => endpoint, close: async () => undefined,
          };
          return endpoint;
        },
      },
      onLog: async (stream, text) => { process.send?.({ log: { stream, text } }); },
    });
    if (input.suspendAfterTurn) {
      const closed = await closeIdleWarmNativeSessionsForRestart();
      if (closed.closed !== 1 || closed.busy || closed.failed) throw new Error("Warm fixture failed to suspend");
    }
    process.send?.({ result: { ...result, inspectionOverridden } });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.stack : String(error) });
  }
});
setInterval(() => undefined, 60_000);
