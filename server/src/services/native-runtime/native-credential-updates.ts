import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { validatePrpEvent, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

export async function appendNativeCredentialUpdate(db: Db, input: {
  companyId: string;
  agentId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  event: PrpEvent;
}): Promise<void> {
  const parsed = validatePrpEvent(input.event);
  if (!parsed.ok || parsed.event.eventType !== "auth.credentials.updated"
    || parsed.event.sourceKind !== "runner"
    || parsed.event.sourceInstanceId !== input.runnerInstanceId
    || parsed.event.normalizedSessionId !== input.normalizedSessionId) {
    throw new Error("native_credential_update_binding_mismatch");
  }
  const event = parsed.event;
  await db.transaction(async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, event.runId), eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
        eq(heartbeatRuns.runnerInstanceId, input.runnerInstanceId)))
      .for("update").limit(1);
    if (!run) throw new Error("native_credential_update_binding_mismatch");
    await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: input.companyId,
      agentId: input.agentId,
      runId: event.runId,
      eventType: event.eventType,
      stream: "system",
      level: "info",
      payload: { prpEvent: event as unknown as Record<string, unknown> },
      nativeSource: {
        sourceInstanceId: `${event.sourceInstanceId}:credentials`,
        sourceEventId: `credentials:${event.sourceEventId}`,
        sourceSeq: event.sourceSeq,
        protocolSchemaVersion: event.schemaVersion,
        canonicalPayload: event as unknown as Record<string, unknown>,
      },
    });
  });
}
