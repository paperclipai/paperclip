import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  budgetReservations,
  companies,
  companyFastResponses,
  companySecrets,
  costEvents,
  responsibilitySummaryInvocations,
  type Db,
} from "@paperclipai/db";
import {
  aiConnectionCatalogSlug,
  aiConnectionMetadataSchema,
  centsToUnits,
  unitsToCents,
} from "@paperclipai/shared";
import { applyCostCorrectionInTransaction } from "./accounting-corrections.js";
import { withOperationAccountingTransaction } from "./accounting-transaction.js";
import { logActivity } from "./activity-log.js";
import { aiConnectionService } from "./ai-connections.js";
import type { AuthorizationActor } from "./authorization.js";
import { queueBudgetEvaluation } from "./budget-evaluation-work.js";
import { withBudgetSpan } from "./budget-tracing.js";
import { budgetServiceInTransaction } from "./budgets.js";
import { createCostEventInTransaction } from "./costs.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { fastResponseReceipt, runTextGenerationProvider, type FastResponseOutcome } from "./fast-response-provider.js";
import { instanceSettingsService } from "./instance-settings.js";
import type {
  ResponsibilitySummaryFeature,
  ResponsibilitySummaryGenerationRequest,
  ResponsibilitySummaryGenerationResult,
  ResponsibilitySummaryGenerator,
} from "./responsibility-summaries.js";

// ---------------------------------------------------------------------------
// The model behind responsibility summaries: the company's fast-response
// connection and model, with the accounting every server-side model call has
// (see `prompt-injection-prevention.ts`): budget admission with a held
// reservation, a content-free invocation row, and a settled cost event with
// `usage_kind = responsibility_summary`. Stale running invocations are settled
// as interrupted by the cost-accounting recovery.
// ---------------------------------------------------------------------------

type Invocation = typeof responsibilitySummaryInvocations.$inferSelect;
type Unavailable = Extract<ResponsibilitySummaryGenerationResult, { status: "unavailable" }>;

const FEATURE_ROW: Record<ResponsibilitySummaryFeature, Invocation["feature"]> = {
  "responsibilities.where_things_stand": "where_things_stand",
  "responsibilities.what_is_affecting_the_number": "what_is_affecting_the_number",
};

/** Running invocations older than this are settled as interrupted (the call itself is aborted at 30 seconds). */
const INTERRUPTED_AFTER_MS = 120_000;

class SummaryUnavailable extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/**
 * Only a person's own read spends money: the reader is the responsible user,
 * and must be in the connection's audience. Agents and other callers read the
 * text a person's view produced, or the computed paragraph.
 */
function responsibleUser(actor: AuthorizationActor): string | null {
  return actor.type === "board" && actor.userId ? actor.userId : null;
}

export function responsibilitySummaryModelGenerator(db: Db, options: { provider?: typeof runTextGenerationProvider } = {}) {
  const providerCall = options.provider ?? runTextGenerationProvider;

  /** The fast-response configuration and the reader's use of its connection, or a closed reason. */
  async function resolve(executor: Db, companyId: string, userId: string, lock = false) {
    if (!(await instanceSettingsService(executor).getExperimental()).enableFastResponses) throw new SummaryUnavailable("disabled");
    const query = executor.select().from(companyFastResponses).where(eq(companyFastResponses.companyId, companyId));
    const [config] = await (lock ? query.for("share") : query);
    if (!config?.enabled || !config.connectionId || !config.grantId || !config.model) throw new SummaryUnavailable("not_configured");
    try {
      const connection = await aiConnectionService(executor).selectFastResponse({
        companyId, connectionId: config.connectionId, grantId: config.grantId, userId, agentId: null, sponsoredBackground: false,
      });
      return { config: { ...config, model: config.model }, connection };
    } catch {
      throw new SummaryUnavailable("connection_unavailable");
    }
  }

  async function settle(invocation: Invocation, outcome: FastResponseOutcome) {
    await withBudgetSpan("budget.accounting.settlement", () => withOperationAccountingTransaction(db, invocation.companyId, async (tx, publications) => {
      const receipt = outcome.receipt;
      const [current] = await tx.select().from(responsibilitySummaryInvocations).where(and(
        eq(responsibilitySummaryInvocations.companyId, invocation.companyId), eq(responsibilitySummaryInvocations.id, invocation.id),
      )).for("update");
      if (!current) return;
      const [existing] = current.costEventId ? await tx.select({ id: costEvents.id, costStatus: costEvents.costStatus,
        inputTokens: costEvents.inputTokens, cachedInputTokens: costEvents.cachedInputTokens, outputTokens: costEvents.outputTokens,
        providerRequestId: costEvents.providerRequestId, pricingProvenance: costEvents.pricingProvenance,
        costCents: sql<string>`${costEvents.costCents}::text` }).from(costEvents).where(and(
        eq(costEvents.companyId, invocation.companyId), eq(costEvents.id, current.costEventId),
      )).for("update") : [];
      if (current.status !== "running") {
        // Settled already; only a late receipt for interrupted, unpriced accounting may correct it.
        if (!existing || outcome.errorCode === "interrupted") return;
        if (current.errorCode !== "interrupted" && (existing.costStatus !== "unpriced" || receipt.costStatus === "unpriced")) return;
      }
      let event: { id: string };
      if (existing) {
        const receiptUsage = { inputTokens: receipt.inputTokens ?? current.inputTokens ?? 0, cachedInputTokens: 0,
          outputTokens: receipt.outputTokens ?? current.outputTokens ?? 0, providerRequestId: receipt.providerRequestId ?? current.providerRequestId };
        if (existing.costStatus === "unpriced" && receipt.costStatus !== "unpriced") await applyCostCorrectionInTransaction(tx, publications, {
          companyId: invocation.companyId, eventId: existing.id,
          idempotencyKey: `responsibility-summary:${invocation.id}:late-receipt`, expectedCents: existing.costCents,
          correctedCents: receipt.costCents ?? "0", reason: "Provider receipt arrived after interrupted accounting recovery",
          costStatus: receipt.costStatus, receiptUsage,
          pricing: { ...receipt.pricingProvenance, evidence: JSON.stringify({ providerRequestId: receipt.providerRequestId,
            inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, evidence: receipt.pricingProvenance.evidence }) },
          actorId: "cost_accounting" });
        else {
          if (Object.entries(receiptUsage).some(([key, value]) => existing[key as keyof typeof existing] !== value))
            await applyCostCorrectionInTransaction(tx, publications, { companyId: invocation.companyId, eventId: existing.id,
              idempotencyKey: `responsibility-summary:${invocation.id}:late-usage`, expectedCents: existing.costCents, correctedCents: existing.costCents,
              costStatus: existing.costStatus === "unpriced" ? "unpriced" : existing.costStatus === "estimated" ? "estimated" : "reported", receiptUsage,
              reason: "Provider usage arrived after interrupted accounting recovery",
              pricing: existing.pricingProvenance ?? { source: "unknown" }, actorId: "cost_accounting" });
          if (existing.costStatus !== "unpriced") await logActivity(tx, { companyId: invocation.companyId,
            actorType: "system", actorId: "cost_accounting", responsibleUserIdOverride: invocation.responsibleUserId,
            action: "accounting.late_receipt_observed", entityType: "cost_event", entityId: existing.id,
            details: { effectiveCostCents: existing.costCents, ...receipt },
          }, publications);
        }
        event = existing;
      } else event = await createCostEventInTransaction(tx, invocation.companyId, {
        usageKind: "responsibility_summary", responsibleUserId: invocation.responsibleUserId,
        agentId: null, issueId: null, projectId: null, heartbeatRunId: null,
        idempotencyKey: `responsibility-summary:${invocation.id}`,
        provider: invocation.provider, biller: invocation.provider, billingType: "metered_api",
        costStatus: receipt.costStatus, model: invocation.model,
        inputTokens: receipt.inputTokens ?? 0, outputTokens: receipt.outputTokens ?? 0, costCents: receipt.costCents ?? "0",
        providerRequestId: receipt.providerRequestId, pricingProvenance: receipt.pricingProvenance, occurredAt: invocation.startedAt,
      }, publications, { actorType: "user", actorId: invocation.actorId });
      const finishedAt = new Date();
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, invocation.companyId);
      await tx.update(responsibilitySummaryInvocations).set({
        status: outcome.text ? "succeeded" : receipt.costStatus === "unpriced" ? "unknown" : "failed",
        errorCode: outcome.errorCode ?? null, costEventId: event.id,
        providerRequestId: receipt.providerRequestId ?? current.providerRequestId,
        inputTokens: receipt.inputTokens ?? current.inputTokens, outputTokens: receipt.outputTokens ?? current.outputTokens,
        finishedAt, durationMs: Math.max(0, finishedAt.getTime() - invocation.startedAt.getTime()),
      }).where(and(eq(responsibilitySummaryInvocations.companyId, invocation.companyId), eq(responsibilitySummaryInvocations.id, invocation.id)));
      // An unknown charge keeps its hold until billing correction resolves it.
      if (receipt.costStatus !== "unpriced") await tx.update(budgetReservations).set({
        state: outcome.noProviderWork ? "released" : "settled", settledAt: finishedAt,
      }).where(and(
        eq(budgetReservations.companyId, invocation.companyId),
        eq(budgetReservations.responsibilitySummaryInvocationId, invocation.id),
        eq(budgetReservations.state, "held"),
      ));
    }), { "budget.accounting.owner": "responsibility_summary" });
  }

  const generator: ResponsibilitySummaryGenerator = {
    /** Configuration and permission only: no credential is decrypted and no provider is contacted. */
    async availability({ companyId, actor }) {
      const userId = responsibleUser(actor);
      if (!userId) return false;
      try {
        await resolve(db, companyId, userId);
        return true;
      } catch {
        return false;
      }
    },

    async generate(request: ResponsibilitySummaryGenerationRequest): Promise<ResponsibilitySummaryGenerationResult> {
      const userId = responsibleUser(request.actor);
      if (!userId) return { status: "unavailable", reason: "responsible_user_missing" };
      const { companyId } = request;
      let selected: Awaited<ReturnType<typeof resolve>>;
      let credential: string;
      let secret: { id: string; version: number } | undefined;
      try {
        selected = await resolve(db, companyId, userId);
        const secretId = selected.connection.grant.credentialSecretRefs.find((ref) => ref.configPath === "ai.credential")?.secretId;
        const [snapshot] = secretId ? await db.select({ id: companySecrets.id, status: companySecrets.status, version: companySecrets.latestVersion })
          .from(companySecrets).where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId))) : [];
        if (!snapshot || snapshot.status !== "active") return { status: "unavailable", reason: "connection_unavailable" };
        secret = { id: snapshot.id, version: snapshot.version };
        credential = await aiConnectionService(db).credential(selected.connection, 0, {
          responsibleUserId: userId, actorType: "user", actorId: userId,
        });
      } catch (error) {
        return { status: "unavailable", reason: error instanceof SummaryUnavailable ? error.reason : "connection_unavailable" };
      }
      const metadata = aiConnectionMetadataSchema.parse(selected.connection.connection.config.ai);

      const admission = await withOperationAccountingTransaction(db, companyId, async (tx): Promise<{ invocation: Invocation } | Unavailable> => {
        const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId)).for("share");
        if (!company || company.status !== "active") return { status: "unavailable", reason: "budget_blocked" };
        let current: Awaited<ReturnType<typeof resolve>>;
        try {
          current = await resolve(tx, companyId, userId, true);
        } catch (error) {
          return { status: "unavailable", reason: error instanceof SummaryUnavailable ? error.reason : "connection_unavailable" };
        }
        // A changed setting, connection, grant or secret needs a fresh credential.
        if (current.config.updatedAt.getTime() !== selected.config.updatedAt.getTime()
          || current.config.connectionId !== selected.config.connectionId || current.config.grantId !== selected.config.grantId
          || current.config.model !== selected.config.model
          || current.connection.grant.credentialSecretRefs.find((ref) => ref.configPath === "ai.credential")?.secretId !== secret!.id
          || current.connection.grant.updatedAt.getTime() !== selected.connection.grant.updatedAt.getTime()
          || current.connection.connection.updatedAt.getTime() !== selected.connection.connection.updatedAt.getTime()) {
          return { status: "unavailable", reason: "connection_unavailable" };
        }
        const [currentSecret] = await tx.select({ status: companySecrets.status, version: companySecrets.latestVersion }).from(companySecrets)
          .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secret!.id))).for("share");
        if (!currentSecret || currentSecret.status !== "active" || currentSecret.version !== secret!.version) {
          return { status: "unavailable", reason: "connection_unavailable" };
        }
        // Company budgets only: the call has no agent or project.
        const { block, policies, observations } = await budgetServiceInTransaction(tx, []).evaluateAdmission(companyId, null, {});
        if (block) return { status: "unavailable", reason: "budget_blocked" };
        const amount = policies.reduce((max, policy) => {
          const units = centsToUnits(policy.reservationCents);
          return units > max ? units : max;
        }, 0n);
        for (const [index, policy] of policies.entries()) {
          const committed = centsToUnits(observations[index]!.ledgerCents) + centsToUnits(observations[index]!.effectiveHeldCents);
          if (committed >= centsToUnits(policy.amount) || committed + amount > centsToUnits(policy.amount)) {
            return { status: "unavailable", reason: "budget_blocked" };
          }
        }
        if (request.signal.aborted) return { status: "unavailable", reason: "timeout" };
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, companyId);
        const [invocation] = await tx.insert(responsibilitySummaryInvocations).values({
          id: randomUUID(),
          companyId,
          feature: FEATURE_ROW[request.feature],
          responsibilityId: request.subject.responsibilityId ?? null,
          ownerUserId: request.subject.ownerUserId ?? null,
          actorType: "user",
          actorId: userId,
          responsibleUserId: userId,
          connectionId: current.connection.connection.id,
          grantId: current.connection.grant.id,
          provider: aiConnectionCatalogSlug(current.connection.provider, metadata.routing),
          model: current.config.model,
          promptVersion: request.promptVersion,
        }).returning();
        await tx.insert(budgetReservations).values({
          companyId, responsibilitySummaryInvocationId: invocation!.id, agentId: null, projectId: null,
          amountCents: unitsToCents(amount), providerStartedAt: invocation!.startedAt,
        });
        await queueBudgetEvaluation(tx, { companyId, agentId: null, projectId: null });
        return { invocation: invocation! };
      });
      if ("status" in admission) return admission;
      const { invocation } = admission;

      let outcome: FastResponseOutcome;
      try {
        outcome = await providerCall({
          metadata, credential, model: invocation.model,
          system: request.system, prompt: request.prompt, maxOutputTokens: request.maxOutputTokens, signal: request.signal,
          // A paragraph cut off at the token limit is not usable; the summaries module checks the rest.
          accept: (_text, finishReason) => finishReason !== "length",
        });
      } catch {
        // The provider maps its failures to codes; anything else leaves the charge unknown.
        outcome = { errorCode: "provider_failed", receipt: fastResponseReceipt() };
      }
      await settle(invocation, outcome);
      return outcome.text
        ? { status: "succeeded", text: outcome.text }
        : { status: "failed", errorCode: outcome.errorCode ?? "provider_failed" };
    },
  };

  /** Settle running invocations a crash or restart left behind, without calling the provider again. */
  async function recoverInterrupted() {
    const stale = await db.select().from(responsibilitySummaryInvocations).where(and(
      eq(responsibilitySummaryInvocations.status, "running"),
      lt(responsibilitySummaryInvocations.startedAt, new Date(Date.now() - INTERRUPTED_AFTER_MS)),
    )).limit(100);
    for (const invocation of stale) await settle(invocation, { errorCode: "interrupted", receipt: fastResponseReceipt() });
    return stale.length;
  }

  return { ...generator, recoverInterrupted };
}
