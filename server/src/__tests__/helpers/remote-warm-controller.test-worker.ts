import { createDb } from "@paperclipai/db";
import { executePaperclipNativeSession } from "../../services/native-runtime/native-session-executor.js";
import { dockerCommandRunner } from "./docker-command-runner.js";

process.once("message", async (input: {
  connectionString: string;
  container: string;
  ingressUrl: string;
  options: Parameters<typeof executePaperclipNativeSession>[0];
}) => {
  const target = input.options.runnerExecutionTarget;
  if (target?.kind !== "remote") throw new Error("Expected remote worker target");
  try {
    const result = await executePaperclipNativeSession({
      ...input.options,
      db: createDb(input.connectionString),
      runnerExecutionTarget: {
        ...target,
        runner: dockerCommandRunner(input.container),
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
    process.send?.({ result });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.stack : String(error) });
  }
});
setInterval(() => undefined, 60_000);
