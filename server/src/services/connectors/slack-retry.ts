import { and, eq, sql, inArray } from "drizzle-orm";
import { chatActions, toolInvocations, type Db } from "@paperclipai/db";
import {
  resolveSlackTaskAuthority,
  type SlackTaskBinding,
} from "./slack-authority.js";

/** Only a definite provider rate-limit rejection can be retried automatically.
 * A fresh policy decision and live authority check precede this atomic claim.
 * Never reopen an uncertain call or reuse approval from another run. */
export async function claimSlackRateLimitRetry(
  db: Db,
  binding: SlackTaskBinding,
  invocationId: string,
) {
  const authority = await resolveSlackTaskAuthority(db, binding);
  return db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.id, invocationId),
          eq(toolInvocations.companyId, binding.companyId),
          eq(toolInvocations.runId, binding.runId),
          eq(toolInvocations.agentId, binding.agentId),
          eq(toolInvocations.issueId, binding.issueId),
          inArray(toolInvocations.status, ["failed", "rate_limited"]),
          eq(toolInvocations.approvalState, "not_required"),
        ),
      )
      .for("update");
    if (!invocation) return "not_retryable" as const;
    const [action] = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, binding.companyId),
          eq(chatActions.endpointId, authority.endpoint.id),
          eq(chatActions.kind, "slack_tool_write"),
          eq(chatActions.status, "failed"),
          sql`${chatActions.payload}->>'invocationId' = ${invocation.id}`,
        ),
      )
      .for("update");
    if (
      !action ||
      action.payload.revision !== authority.revision ||
      action.result?.code !== "slack_rate_limited" ||
      typeof action.result.retryAt !== "string"
    ) return "not_retryable" as const;
    const retryAt = Date.parse(action.result.retryAt);
    if (!Number.isFinite(retryAt)) return "not_retryable" as const;
    if (retryAt > Date.now()) return "deferred" as const;
    await tx
      .update(chatActions)
      .set({ status: "received", updatedAt: new Date() })
      .where(eq(chatActions.id, action.id));
    await tx
      .update(toolInvocations)
      .set({
        status: "executing",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(toolInvocations.id, invocation.id));
    return "claimed" as const;
  });
}
