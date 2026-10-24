import type { Db } from "@paperclipai/db";
import { secretOperationPayloadSchema, type SecretOperationPayload } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";

/**
 * Result of executing a `secret_operation` approval. Never carries a secret
 * value or a secret name — only the operation and the target id, both of which
 * survive payload redaction.
 */
export interface SecretOperationResult {
  ok: boolean;
  op: SecretOperationPayload["op"] | null;
  targetId: string | null;
  error: string | null;
}

export interface ExecuteApprovedSecretOperationInput {
  companyId: string;
  approvalId: string;
  payload: Record<string, unknown>;
}

/**
 * Zod messages can echo received values. A `secret_operation` payload should
 * never contain one (the schema is strict), but an invalid payload is exactly
 * the case where that guarantee did not hold — so report shape, not content.
 */
function describeIssues(error: { issues: Array<{ path: PropertyKey[]; code: string }> }): string {
  const parts = error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
  return parts.slice(0, 5).join("; ");
}

async function notifyLinkedIssues(db: Db, approvalId: string, body: string): Promise<void> {
  // Never let the notification path hide the operation's own outcome, and never
  // let one unwritable issue swallow the notice for the others.
  let linked: Array<{ id: string }>;
  try {
    linked = await issueApprovalService(db).listIssuesForApproval(approvalId);
  } catch (err) {
    logger.error({ err, approvalId }, "secret operation hook: failed to list linked issues");
    return;
  }
  const issues = issueService(db);
  for (const issue of linked) {
    try {
      await issues.addComment(issue.id, body, {});
    } catch (err) {
      logger.error(
        { err, approvalId, issueId: issue.id },
        "secret operation hook: failed to comment on linked issue",
      );
    }
  }
}

/**
 * `secretService.update/remove` look secrets up by id alone; the board secret
 * routes add the tenant check in front of them. This path has no route in
 * front, so it must do the same: only a company-scoped secret owned by the
 * approval's own company may be touched. Returns an error string, or null.
 */
export async function checkSecretOperationTarget(
  db: Db,
  companyId: string,
  targetId: string,
): Promise<string | null> {
  const secret = await secretService(db).getById(targetId);
  // Same message for "missing" and "other company": do not confirm that a
  // foreign id exists.
  if (!secret || secret.companyId !== companyId || secret.status === "deleted") {
    return "secret not found";
  }
  if (secret.scope !== "company") return "secret operations require a company-scoped secret";
  return null;
}

/**
 * Applies a board-approved secret operation.
 *
 * The approved approval row *is* the authorization: this runs inside the server
 * with no actor credentials, which is what lets `assertBoard` stay board-only
 * while approved maintenance still gets executed. Mirrors the `hire_agent`
 * branch in {@link approvalService.approve}.
 *
 * Callers must only invoke this when `resolveApproval` reported `applied === true`,
 * which is what makes a second approve a no-op instead of a second delete.
 *
 * Never throws: a failure is recorded in the activity log and on every linked
 * issue, and returned so the caller can surface it on the HTTP response.
 */
export async function executeApprovedSecretOperation(
  db: Db,
  input: ExecuteApprovedSecretOperationInput,
): Promise<SecretOperationResult> {
  const { companyId, approvalId } = input;

  const parsed = secretOperationPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return fail(db, {
      companyId,
      approvalId,
      op: null,
      targetId: null,
      error: `invalid secret_operation payload (${describeIssues(parsed.error)})`,
    });
  }

  const payload = parsed.data;
  const secrets = secretService(db);

  try {
    const targetError = await checkSecretOperationTarget(db, companyId, payload.targetId);
    if (targetError) {
      return fail(db, {
        companyId,
        approvalId,
        op: payload.op,
        targetId: payload.targetId,
        error: targetError,
      });
    }

    if (payload.op === "rename") {
      // Name only. Rotation/rekeying is deliberately out of scope for this type,
      // so an approved rename can never touch the stored value.
      const updated = await secrets.update(payload.targetId, { name: payload.newName });
      if (!updated) {
        return fail(db, {
          companyId,
          approvalId,
          op: payload.op,
          targetId: payload.targetId,
          error: "secret not found",
        });
      }
    } else {
      const removed = await secrets.remove(payload.targetId);
      if (!removed) {
        return fail(db, {
          companyId,
          approvalId,
          op: payload.op,
          targetId: payload.targetId,
          error: "secret not found",
        });
      }
    }
  } catch (err) {
    return fail(db, {
      companyId,
      approvalId,
      op: payload.op,
      targetId: payload.targetId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "secret_operation_hook",
    action: "approval.secret_operation.applied",
    entityType: "approval",
    entityId: approvalId,
    // No name, no value: for some rows the name *is* the credential.
    details: { op: payload.op, targetId: payload.targetId },
  });

  await notifyLinkedIssues(
    db,
    approvalId,
    [
      `Approved secret operation applied: \`${payload.op}\` on secret \`${payload.targetId}\`.`,
      "",
      "Executed server-side from the approved approval row; no agent held board credentials.",
    ].join("\n"),
  );

  return { ok: true, op: payload.op, targetId: payload.targetId, error: null };
}

async function fail(
  db: Db,
  input: {
    companyId: string;
    approvalId: string;
    op: SecretOperationPayload["op"] | null;
    targetId: string | null;
    error: string;
  },
): Promise<SecretOperationResult> {
  const { companyId, approvalId, op, targetId, error } = input;
  logger.error({ approvalId, companyId, op, targetId, error }, "approved secret operation failed");

  await logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "secret_operation_hook",
    action: "approval.secret_operation.failed",
    entityType: "approval",
    entityId: approvalId,
    details: { op, targetId, error },
  });

  await notifyLinkedIssues(
    db,
    approvalId,
    [
      `**Approved secret operation failed.**`,
      "",
      `- Operation: \`${op ?? "unknown"}\``,
      `- Target: \`${targetId ?? "unknown"}\``,
      `- Error: ${error}`,
      "",
      "The approval stays `approved` and is **not** retried by approving again — approving twice is a no-op by design. Fix the cause and submit a new approval.",
    ].join("\n"),
  );

  return { ok: false, op, targetId, error };
}
