import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions, chatPublications } from "@paperclipai/db";
import type { EndpointRow, EndpointRecord } from "../runtime-types.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";
type BoardPreparationOptions = { endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>; runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime> };
export function createTeamsBoardSendPreparation(db: Db, options: BoardPreparationOptions) {
  const { endpointRecord, runtimeFor } = options;
  async function prepareTeamsBoardSend(endpointId: string, conversationId: string, idempotencyKey: string, rejectionActionId: string) {
    const record = await endpointRecord(endpointId);
    if (
      record?.endpoint.provider === "microsoft-teams" &&
      record.endpoint.status === "active"
    ) {
      const [existing] = await db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, record.endpoint.companyId),
            eq(chatPublications.endpointId, endpointId),
            eq(chatPublications.conversationId, conversationId),
            eq(chatPublications.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      // A cold service must not permanently choose the task-link fallback
      // merely because runtime reconciliation has not run yet. Initialize
      // outside all Board/source locks, then recheck the full scope below.
      // A repeated send identity needs only its existing durable receipt.
      const [rejected] = existing
        ? []
        : await db
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.companyId, record.endpoint.companyId),
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.providerActionId, rejectionActionId),
            ),
          )
          .limit(1);
      if (!existing && !rejected) await runtimeFor(record.endpoint);
    }
  }
  return { prepareTeamsBoardSend };
}
