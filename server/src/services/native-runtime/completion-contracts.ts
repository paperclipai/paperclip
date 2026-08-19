import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { completionContracts } from "@paperclipai/db";
import type { StrictCompletionContractInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

export const NATIVE_COMPLETION_CONTRACT_SCHEMA = "paperclip.completion-contract.v1";
export const NATIVE_COMPLETION_POLICY_VERSION = "phase6-v1";

export async function ensureNativeCompletionContract(input: {
  db: Db;
  companyId: string;
  issue: { id: string; title: string; description: string | null };
  actorId: string;
}) {
  const contract: StrictCompletionContractInput = {
    revision: "1",
    objective: input.issue.title,
    criteria: [{
      id: "objective",
      requirement: input.issue.description?.trim() || `Complete: ${input.issue.title}`,
    }],
  };
  const canonicalSha256 = nativeSha256({
    schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
    policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
    contract,
  });
  const existing = await input.db
    .select()
    .from(completionContracts)
    .where(and(
      eq(completionContracts.companyId, input.companyId),
      eq(completionContracts.issueId, input.issue.id),
      eq(completionContracts.canonicalSha256, canonicalSha256),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return { row: existing, contract };

  const latest = await input.db
    .select({ revision: completionContracts.revision, id: completionContracts.id })
    .from(completionContracts)
    .where(and(
      eq(completionContracts.companyId, input.companyId),
      eq(completionContracts.issueId, input.issue.id),
    ))
    .orderBy(desc(completionContracts.revision))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const [row] = await input.db.insert(completionContracts).values({
    companyId: input.companyId,
    issueId: input.issue.id,
    revision: (latest?.revision ?? 0) + 1,
    schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
    policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
    risk: "standard",
    completionAuthority: "server_arbiter",
    incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: contract as unknown as Record<string, unknown>,
    canonicalSha256,
    createdByActorType: "system",
    createdByActorId: input.actorId,
    supersedesContractId: latest?.id ?? null,
  }).returning();
  if (!row) throw new Error("native_completion_contract_not_persisted");
  return { row, contract };
}
