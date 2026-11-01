import { resolve } from "node:path";
import { createDb } from "@paperclipai/db";
import { DurablePrpControlPlane, decodeDurablePrpCheckpoint, type DurablePrpCheckpoint } from "../../../vendor/paperclip-runner/index.js";
import { createNativeUsageDelivery } from "../native-usage-delivery.js";

type Start = {
  kind: "start"; requestId: number; connectionString: string; directory: string; port?: number;
  identity: ConstructorParameters<typeof DurablePrpControlPlane>[0]["identity"];
  input: Parameters<typeof createNativeUsageDelivery>[1];
  checkpoint?: [string, string][];
};
let core: DurablePrpControlPlane | undefined;
let checkpoint: DurablePrpCheckpoint | undefined;
process.on("message", async (message: Start | { kind: "command"; requestId: number; type: string; commandId: string } | { kind: "stop"; requestId: number }) => {
  try {
    if (message.kind === "start") {
      const delivery = await createNativeUsageDelivery(createDb(message.connectionString), message.input);
      if (message.checkpoint) decodeDurablePrpCheckpoint(new Map(message.checkpoint)).restoreSessionDirectory(message.directory);
      core = new DurablePrpControlPlane({ stateDirectory: resolve(message.directory, "control-plane"), identity: message.identity,
        expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"c".repeat(64)}`,
        onCommittedEvent: async event => {
          try { await delivery.capture(event); }
          catch (error) { process.send?.({ kind: "capture-failed", cause: error instanceof Error ? error.message : String(error) }); throw error; }
        },
      });
      core.setCheckpointPersistence(async saved => { checkpoint = saved; });
      await core.start(message.port);
      const ticket = message.checkpoint ? undefined : core.issueBootstrapTicket();
      await core.flushCheckpoint();
      process.send?.({ requestId: message.requestId, connectUrl: core.connectUrl, ticket });
    } else if (message.kind === "command") {
      core!.queueCommand(message.type, {}, message.commandId, true);
      process.send?.({ requestId: message.requestId });
    } else {
      await core?.stop();
      await core?.drainPendingConnectionProcessing();
      await core?.flushCheckpoint();
      process.send?.({ requestId: message.requestId, checkpoint: [...checkpoint!.records] }, () => process.exit(0));
    }
  } catch (error) {
    process.send?.({ requestId: message.requestId, error: error instanceof Error ? error.message : String(error) });
  }
});

process.send?.({ kind: "ready" });
