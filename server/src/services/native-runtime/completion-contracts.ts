import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { completionContracts } from "@paperclipai/db";
import type { StrictCompletionContractInput } from "../../vendor/paperclip-runner/index.js";

import { nativeSha256 } from "./canonical.js";

export const NATIVE_COMPLETION_CONTRACT_SCHEMA = "paperclip.completion-contract.v1";
export const NATIVE_COMPLETION_POLICY_VERSION = "phase6-v4";

export function nativeCompletionRequestsForComments(
  comments: readonly {
    body: string;
    attachments?: readonly unknown[];
  }[],
  options: { requiredFullWakeCommentCount?: number } = {},
): string[] {
  if (
    Number.isSafeInteger(options.requiredFullWakeCommentCount) &&
    (options.requiredFullWakeCommentCount ?? 0) > 0
  ) {
    return [
      `Read every server-bound pending external-chat comment with read_current_wake_comments until complete=true, then answer all ${options.requiredFullWakeCommentCount} accepted comments in order without omitting a request. Report any unavailable attachment honestly; metadata alone is not its content.`,
    ];
  }
  return comments.flatMap((comment, index) => {
    const body = comment.body.trim();
    if (body) return [body];
    // A file-only message is still the current request. Never fall back to an
    // older imperative title or treat a user-controlled filename as policy.
    return comment.attachments?.length
      ? [`Inspect and respond to the attached file(s) on pending comment ${index + 1}.`]
      : [];
  });
}

export function resolveNativeCompletionPolicy(issue: {
  reviewPolicy?: string | null;
}) {
  const externalReviewRequired =
    issue.reviewPolicy === "human_only" || issue.reviewPolicy === "not_creator";
  return externalReviewRequired
    ? { risk: "standard", completionAuthority: "server_arbiter" } as const
    : { risk: "low", completionAuthority: "agent_claim_policy" } as const;
}

export function buildNativeCompletionContract(
  issue: { title: string; description: string | null },
  options: {
    readonly revision?: number;
    readonly immediateRequest?: string | null;
    readonly immediateRequests?: readonly string[] | null;
    /** ID of this wake's server-verified humanResponses entry; its content is already in task context. */
    readonly humanResponseId?: string | null;
  } = {},
): StrictCompletionContractInput {
  const immediateRequests = (
    options.immediateRequests ??
    (options.immediateRequest == null ? [] : [options.immediateRequest])
  )
    .map((request) => request.trim())
    .filter((request) => request.length > 0);
  const humanResponseId = options.humanResponseId?.trim();
  const hasFollowUp = immediateRequests.length > 0 || Boolean(humanResponseId);
  // Reference existing context rather than copying the brief/history into every
  // follow-up contract. Keep this guidance stable across comments and resumes.
  const followUpObjective = "Complete the current authorized stage using the task brief and current user direction in the supplied context. Later human direction replaces conflicting scope; preserve other requirements, assigned-skill instructions, and approval gates. Apply authenticated humanResponses only to their question or decision. Clarification is not approval. If acceptance is required, propose or save the requested plan and wait before executing.";
  return {
    revision: String(options.revision ?? 1),
    objective: hasFollowUp
      ? followUpObjective
      : issue.title,
    criteria: hasFollowUp
      ? [
          ...immediateRequests.map((request, index) => ({
            id: immediateRequests.length === 1 ? "objective" : `pending_comment_${index + 1}`,
            requirement: request,
          })),
          ...(humanResponseId ? [{
            id: "human_response",
            requirement: `Apply the server-verified humanResponses entry with id ${JSON.stringify(humanResponseId)} in the supplied current request context, within its question or decision scope and subject to later user direction.`,
          }] : []),
        ]
      : [
          {
            id: "objective",
            requirement:
              issue.description?.trim() || `Complete: ${issue.title}`,
          },
        ],
  };
}

export async function ensureNativeCompletionContract(input: {
  db: Db;
  companyId: string;
  issue: {
    id: string;
    title: string;
    description: string | null;
    reviewPolicy?: string | null;
  };
  actorId: string;
  immediateRequest?: string | null;
  immediateRequests?: readonly string[] | null;
  humanResponseId?: string | null;
}) {
  return input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${[
      "paperclip:native-completion-contract",
      input.companyId,
      input.issue.id,
    ].join(":")}, 0))`);
    const policy = resolveNativeCompletionPolicy(input.issue);
    const latest = await tx
      .select()
      .from(completionContracts)
      .where(and(
        eq(completionContracts.companyId, input.companyId),
        eq(completionContracts.issueId, input.issue.id),
      ))
      .orderBy(desc(completionContracts.revision))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const latestRevision = latest?.revision ?? 1;
    const latestCandidate = buildNativeCompletionContract(input.issue, {
      revision: latestRevision,
      immediateRequest: input.immediateRequest,
      immediateRequests: input.immediateRequests,
      humanResponseId: input.humanResponseId,
    });
    const latestCandidateSha256 = nativeSha256({
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy,
      contract: latestCandidate,
    });
    if (latest?.canonicalSha256 === latestCandidateSha256) {
      return { row: latest, contract: latestCandidate };
    }

    const nextRevision = latest ? latest.revision + 1 : 1;
    const contract = buildNativeCompletionContract(input.issue, {
      revision: nextRevision,
      immediateRequest: input.immediateRequest,
      immediateRequests: input.immediateRequests,
      humanResponseId: input.humanResponseId,
    });
    const canonicalSha256 = nativeSha256({
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy,
      contract,
    });
    const [row] = await tx.insert(completionContracts).values({
      companyId: input.companyId,
      issueId: input.issue.id,
      revision: nextRevision,
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy,
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: contract as unknown as Record<string, unknown>,
      canonicalSha256,
      createdByActorType: "system",
      createdByActorId: input.actorId,
      supersedesContractId: latest?.id ?? null,
    }).returning();
    if (!row) throw new Error("native_completion_contract_not_persisted");
    return { row, contract };
  });
}
