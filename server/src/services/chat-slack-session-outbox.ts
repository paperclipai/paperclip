import { sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface SlackSessionSyncPayload {
  version: 1;
  revision: number;
  runtimeGeneration: number;
  credentialFingerprint: string;
}

export function slackSessionSyncPayload(
  value: unknown,
): SlackSessionSyncPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<SlackSessionSyncPayload>;
  return payload.version === 1 &&
    Number.isSafeInteger(payload.revision) &&
    payload.revision! > 0 &&
    Number.isSafeInteger(payload.runtimeGeneration) &&
    payload.runtimeGeneration! >= 0 &&
    typeof payload.credentialFingerprint === "string" &&
    payload.credentialFingerprint.length > 0
    ? (payload as SlackSessionSyncPayload)
    : null;
}

/**
 * One idempotent status lane per conversation. Publications and Stop receipts
 * stage it in their own commit. It contains no provider content or credential
 * material. Each new revision invalidates an old transport settlement.
 */
export async function stageSlackSessionSync(
  database: DbOrTransaction,
  input: {
    companyId: string;
    endpointId: string;
    conversationId: string;
    runtimeGeneration: number;
    credentialFingerprint: string;
  },
): Promise<void> {
  const payload = {
    version: 1,
    revision: 1,
    runtimeGeneration: input.runtimeGeneration,
    credentialFingerprint: input.credentialFingerprint,
  };
  await database
    .insert(chatActions)
    .values({
      companyId: input.companyId,
      endpointId: input.endpointId,
      conversationId: input.conversationId,
      providerActionId: `slack-session-sync:${input.conversationId}`,
      kind: "slack_session_sync",
      payload,
      status: "received",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [chatActions.endpointId, chatActions.providerActionId],
      set: {
        payload: sql`${JSON.stringify(payload)}::jsonb || jsonb_build_object('revision', coalesce((${chatActions.payload}->>'revision')::bigint, 0) + 1)`,
        status: "received",
        result: null,
        updatedAt: new Date(),
      },
    });
}
