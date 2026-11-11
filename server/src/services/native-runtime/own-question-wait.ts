import { and, eq, isNull } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";
import { ordinaryQuestionCondition } from "../issue-question-context.js";

const PROVIDER_MESSAGE_REF = /^provider:[a-z0-9_-]+:agent-message$/i;

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

export function reportsOnlyProviderMessage(result: unknown): boolean {
  const refs = [
    ...list(field(result, "evidence")).map((entry) => field(entry, "ref")),
    ...list(field(field(result, "completionClaim"), "criteria")).flatMap((criterion) => list(field(criterion, "evidenceRefs"))),
  ];
  return refs.length > 0 && refs.every((ref) => typeof ref === "string" && PROVIDER_MESSAGE_REF.test(ref))
    && list(field(result, "artifacts")).length === 0 && list(field(result, "verification")).length === 0;
}

export async function pendingOwnQuestionId(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string;
}): Promise<string | null> {
  const [row] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.createdByAgentId, input.agentId),
    eq(issueThreadInteractions.status, "pending"),
    isNull(issueThreadInteractions.dismissedAt),
    ordinaryQuestionCondition(),
  )).limit(1);
  return row?.id ?? null;
}
