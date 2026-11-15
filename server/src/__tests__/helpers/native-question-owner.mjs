// Separate process: only the provider command sink is simulated.
import { createDb } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.ts";
import { deploymentNotifications } from "../../services/deployment-notifications.ts";
import { questionResponseDeliveryService, registerQuestionResponseDeliveryWork } from "../../services/question-response-delivery.ts";
import { deliverNativeQuestionResponse, registerNativeQuestionCommandTarget } from "../../services/native-runtime/native-question-bridge.ts";
let db,
  coordinator,
  bridge,
  worker,
  release,
  sweeps = 0,
  inspections = 0;
process.on("message", async message => {
  try {
    if (message.type === "init") {
      db = createDb(message.url);
      coordinator = createDeliveryWorkCoordinator({
        owner: db,
        canRun: () => true,
        onError: () => process.send({
          type: "error"
        })
      });
      bridge = deploymentNotifications(db, coordinator, {
        directDatabaseUrl: message.url
      });
      await bridge.ready();
      release = registerNativeQuestionCommandTarget({
        binding: message.binding,
        queueCommand: (type, payload, commandId) => {
          process.send({
            type: "command",
            commandType: type,
            requestId: commandId,
            payload,
            commandId
          });
          return {
            commandId,
            controllerSeq: 1
          };
        }
      });
      process.send({
        type: "ready"
      });
    } else if (message.type === "start-worker") {
      const service = questionResponseDeliveryService(db, {
        heartbeat: {
          wakeup: async () => {
            throw new Error("unexpected fallback");
          }
        },
        resolveNativeQuestion: interaction => deliverNativeQuestionResponse(db, interaction)
      });
      worker = registerQuestionResponseDeliveryWork(coordinator, {
        sweepPending: () => {
          sweeps++;
          return service.sweepPending();
        },
        hasPending: () => {
          inspections++;
          return service.hasPending();
        }
      });
      await worker.ready;
      process.send({
        type: "worker-ready"
      });
    } else if (message.type === "snapshot") {
      process.send({
        type: "snapshot",
        requestId: message.requestId,
        sweeps,
        inspections
      });
    } else if (message.type === "stop") {
      release?.();
      await worker?.stop();
      await bridge?.stop();
      await coordinator?.stop();
      await db?.$client.end({
        timeout: 1
      });
      process.exit(0);
    }
  } catch {
    process.send({
      type: "error"
    });
  }
});
