import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { agents, museAgentBindings as bindings, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../services/delivery-work-notifications.js";

export type MuseVerificationScope = {
  companyId?: string;
  bindingId?: string;
  generation?: number;
  operatorId?: string;
  agentId?: string;
};
export type MuseVerificationCandidate = {
  binding: typeof bindings.$inferSelect;
  agent: { status: string; lifecycleState: string };
};
export type MuseVerificationHint = {
  kind: "muse-contact-verification";
  companyId: string;
  bindingId: string;
  generation: number;
};

export async function pendingMuseContactVerifications(
  db: Pick<Db, "select">,
  scope?: MuseVerificationScope,
  after?: string,
  contactWillPersist = false,
): Promise<MuseVerificationCandidate[]> {
  return db.select({ binding: bindings, agent: { status: agents.status, lifecycleState: agents.lifecycleState } })
    .from(bindings)
    .innerJoin(agents, and(eq(agents.id, bindings.agentId), eq(agents.companyId, bindings.companyId)))
    .where(and(
      isNull(bindings.revokedAt), isNotNull(bindings.pairedAt),
      contactWillPersist ? undefined : isNotNull(bindings.receiverContactAt),
      isNull(bindings.verifiedReplyAt), isNull(bindings.challengeHash),
      scope?.companyId ? eq(bindings.companyId, scope.companyId) : undefined,
      scope?.bindingId ? eq(bindings.id, scope.bindingId) : undefined,
      scope?.generation !== undefined ? eq(bindings.generation, scope.generation) : undefined,
      scope?.operatorId ? eq(bindings.operatorId, scope.operatorId) : undefined,
      scope?.agentId ? eq(bindings.agentId, scope.agentId) : undefined,
      after ? gt(bindings.id, after) : undefined,
    )).orderBy(asc(bindings.id)).limit(100);
}

export async function notifyMuseContactVerification(
  tx: Pick<Db, "select">,
  scope?: MuseVerificationScope,
  trigger: "authority" | "contact-persist" = "authority",
): Promise<number> {
  if (trigger === "contact-persist" && (!scope?.bindingId || scope.generation === undefined)) {
    throw new Error("Muse contact intent requires its exact binding generation");
  }
  let after: string | undefined;
  let count = 0;
  while (true) {
    const rows = await pendingMuseContactVerifications(tx, scope, after, trigger === "contact-persist");
    for (const { binding } of rows) {
      const hint: MuseVerificationHint = {
        kind: "muse-contact-verification", companyId: binding.companyId,
        bindingId: binding.id, generation: binding.generation,
      };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance, JSON.stringify(hint));
      count++;
    }
    if (rows.length < 100) return count;
    after = rows.at(-1)!.binding.id;
  }
}

export function parseMuseVerificationHint(raw: string): MuseVerificationHint | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("kind" in value) || value.kind !== "muse-contact-verification"
    || !("companyId" in value) || typeof value.companyId !== "string"
    || !("bindingId" in value) || typeof value.bindingId !== "string"
    || !("generation" in value) || typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation) || value.generation < 1) return;
  return { kind: "muse-contact-verification", companyId: value.companyId,
    bindingId: value.bindingId, generation: value.generation };
}
