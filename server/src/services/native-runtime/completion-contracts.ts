import { and, desc, eq, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { completionContracts } from "@paperclipai/db";
import type { StrictCompletionContractInput } from "../../vendor/paperclip-runner/index.js";

import { nativeSha256 } from "./canonical.js";

export const NATIVE_COMPLETION_CONTRACT_SCHEMA = "paperclip.completion-contract.v1";
export const NATIVE_COMPLETION_POLICY_VERSION = "phase6-v3";

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
  } = {},
): StrictCompletionContractInput {
  const followUp = options.immediateRequest?.trim();
  return {
    revision: String(options.revision ?? 1),
    objective: followUp
      ? `Respond to the latest comment on ${issue.title}`
      : issue.title,
    criteria: [{
      id: "objective",
      requirement:
        followUp || issue.description?.trim() || `Complete: ${issue.title}`,
    }],
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
