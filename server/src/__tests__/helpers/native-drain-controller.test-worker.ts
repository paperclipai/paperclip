import { createServer } from "node:http";
import { closeRegisteredClients, createDb, heartbeatRunEvents } from "@paperclipai/db";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { setStartupRecoveryPhase } from "../../startup-recovery-state.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { executePaperclipNativeSession } from "../../services/native-runtime/native-session-executor.js";

process.send?.({ ready: true });
process.once("message", async (input: {
  connectionString: string;
  options: Omit<Parameters<typeof executePaperclipNativeSession>[0], "db">;
  providerEvidence?: boolean;
}) => {
  const api = createServer((_request, response) => response.writeHead(404).end());
  registerLocalRuntimeApiServer(api);
  let commands = 0;
  let errorName: string | undefined;
  let errorMessage: string | undefined;
  try {
    await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
    const db = createDb(input.connectionString);
    try {
      await executePaperclipNativeSession({ ...input.options, db,
        runnerExecutionTarget: { ...input.options.runnerExecutionTarget!,
          runner: { execute: async () => { commands++; throw new Error("Drained controller launched remote work"); } },
        } as never,
        onEvent: async event => {
          if (event.payload?.span !== "native.coordinator.claim") return;
          if (input.providerEvidence) await db.insert(heartbeatRunEvents).values({
            companyId: input.options.execution.binding.companyId, agentId: input.options.execution.binding.agentId,
            runId: input.options.execution.binding.runId, seq: 1_000_000, eventType: "turn.started",
            sourceEventId: "controlled-provider-evidence" });
          setStartupRecoveryPhase("draining");
          await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
        },
      });
    } catch (error) {
      errorName = error instanceof Error ? error.name : String(error);
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date(), [input.options.execution.binding.runId]);
    } finally { await heartbeat.drainActiveRunExecutions(); }
    await closeRegisteredClients(input.connectionString, { scope: "database" });
    process.send?.({ done: true, commands, errorName, errorMessage }, () => process.exit(0));
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.stack : String(error) }, () => process.exit(1));
  }
});
