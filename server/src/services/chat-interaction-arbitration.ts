import { and, eq, exists, inArray, or, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  chatPublications,
  heartbeatRuns,
  issueThreadInteractions,
} from "@paperclipai/db";

type ChatInteractionArbitrationDb = Pick<Db, "select">;

/**
 * Returns whether a run has yielded its provider-visible response slot to a
 * native question or confirmation. A pending interaction authored by this
 * run's agent is authoritative even before its publication row is inserted.
 * System-authored completion reviews cannot be projected to a provider and
 * must not strand its working placeholder. Once resolved, the durable provider
 * prompt proves that the source run's prose remains internal.
 */
export async function hasChatRunOwnedProviderInteraction(
  db: ChatInteractionArbitrationDb,
  input: { companyId: string; issueId: string; runId: string },
): Promise<boolean> {
  const promptPublication = db
    .select({ id: chatPublications.id })
    .from(chatPublications)
    .where(
      and(
        eq(chatPublications.companyId, issueThreadInteractions.companyId),
        eq(chatPublications.issueId, issueThreadInteractions.issueId),
        sql`${chatPublications.payload} ->> 'interactionId' = ${issueThreadInteractions.id}::text`,
        sql`${chatPublications.idempotencyKey} = 'interaction:' || ${issueThreadInteractions.id}::text || ':' || ${chatPublications.endpointId}::text`,
        inArray(chatPublications.state, [
          "pending",
          "streaming",
          "published",
          "retry",
          "delivery_unknown",
        ]),
      ),
    );
  const rows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.sourceRunId, input.runId),
        inArray(issueThreadInteractions.kind, [
          "ask_user_questions",
          "request_confirmation",
        ]),
        or(
          and(
            eq(issueThreadInteractions.status, "pending"),
            exists(
              db
                .select({ id: heartbeatRuns.id })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, input.runId),
                    eq(heartbeatRuns.companyId, input.companyId),
                    eq(
                      heartbeatRuns.agentId,
                      issueThreadInteractions.createdByAgentId,
                    ),
                  ),
                ),
            ),
          ),
          exists(promptPublication),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
