import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { validatePrpEvent, type PrpEvent, type NativeSession } from "../../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

export async function appendNativeCredentialUpdate(db: Db, input: {
  companyId: string;
  agentId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  event: PrpEvent;
  synchronizeCredentials?: () => Promise<unknown>;
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
  await input.synchronizeCredentials?.();
}

type CredentialUpdateOwner = { handle: (event: PrpEvent) => Promise<void>; detached: boolean; closing: boolean };
const credentialUpdateOwners = new WeakMap<NativeSession, CredentialUpdateOwner>();

/** The transport keeps its owner while each warm invocation rebinds the exporter. */
export function createNativeCredentialUpdateOwner(handle: CredentialUpdateOwner["handle"]) {
  const owner: CredentialUpdateOwner = { handle, detached: false, closing: false };
  return {
    onCredentialsUpdated: async (event: PrpEvent) => {
      if (owner.detached) throw new Error("native_credential_update_owner_detached");
      await owner.handle(event);
    },
    bindSession: (session: NativeSession) => {
      const previous = credentialUpdateOwners.get(session);
      if (previous) {
        if (previous.detached || previous.closing) throw new Error("native_credential_update_owner_retired");
        previous.handle = handle;
        return;
      }
      credentialUpdateOwners.set(session, owner);
      const close = session.close.bind(session);
      session.close = async options => { owner.closing = true; await close(options); };
      const detach = session.detachControllerForRestart?.bind(session);
      if (detach) session.detachControllerForRestart = async () => { owner.detached = true; await detach(); };
    },
  };
}
