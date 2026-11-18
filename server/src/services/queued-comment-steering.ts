import type { Db } from "@paperclipai/db";
import { reconcileSteeredIdentity, storedSteeringAcknowledgement, type RunIdentityContext } from "./run-identity.js";
import { NativeSessionSteeringError, steerNativeSession } from "./native-runtime/native-session-executor.js";

export function steeringDeliveryIsUncertain(error: unknown, attempted: boolean): boolean {
  return attempted && (!(error instanceof NativeSessionSteeringError) || error.code === "steering_timeout");
}

export async function deliverSteeredMessage(db: Db, input: {
  executor?: Pick<Db, "select">;
  companyId: string;
  runId: string;
  messageId: string;
  message: string;
  identity: RunIdentityContext | null;
  onAcknowledged?: () => Promise<void>;
}) {
  return await storedSteeringAcknowledgement(input.executor ?? db, input.identity ?? {
    companyId: input.companyId, runId: input.runId, messageId: input.messageId,
  }) ?? await steerNativeSession({
    runId: input.runId, correlationId: input.messageId, message: input.message,
    onAcknowledged: input.onAcknowledged ?? (input.identity ? () => reconcileSteeredIdentity(db, input.identity!) : undefined),
  });
}
