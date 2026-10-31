import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { companies, statusCards, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { statusCardService } from "./status-cards.js";

/** Feature-owned generation and assignment. Existing issue services retain
 * execution authority, durable wake dedupe and stalled-generation cleanup. */
export function statusCardEvaluationService(db: Db, heartbeat: IssueAssignmentWakeupDeps) {
  const cards = statusCardService(db);
  const issues = issueService(db);
  const settings = instanceSettingsService(db);
  let reconstructReactive = true;
  let allChanges = false;
  const changes = new Set<string>();
  let enabled: boolean | null = null;
  let retryAt: number | null = null;

  return {
    changed(hints?: ReadonlySet<string>) {
      for (const hint of hints ?? ["*"]) {
        if (hint === "*" || hint === "changes:*") { allChanges = true; if (hint === "*") enabled = null; }
        else if (hint.startsWith("changes:")) changes.add(hint.slice("changes:".length));
      }
    },
    async run(signal: AbortSignal) {
      if (enabled === null) enabled = (await settings.getExperimental()).enableStatusCards === true;
      if (!enabled || signal.aborted) return;
      const reconstruct = reconstructReactive;
      const evaluateAllChanges = allChanges;
      const companiesChanged = new Set(changes);
      changes.clear();
      reconstructReactive = false;
      allChanges = false;
      try {
        const result = await cards.tickDueStatusCards(new Date(), evaluateAllChanges ? "changed" : companiesChanged, reconstruct);
        retryAt = result.deferredCompanyIds.size ? Date.now() + 30_000 : null;
        for (const companyId of result.deferredCompanyIds) changes.add(companyId);
        const assignments = await Promise.allSettled(result.enqueued.map(async ({ cardId, generatingIssue }) => {
          // Once generated, dispatch or cancel even if shutdown begins: leaving
          // an unassigned claimed card is not a completed sweep.
          try {
            await queueIssueAssignmentWakeup({
              heartbeat, issue: generatingIssue,
              reason: "status_card_update_assigned",
              mutation: "status_card.scheduler_update_requested",
              contextSource: "status_card_scheduler",
              requestedByActorType: "system", taskKey: `status-card:${cardId}`,
              rethrowOnError: true,
            });
          } catch (error) {
            await issues.update(generatingIssue.id, { status: "cancelled" });
            throw error;
          }
        }));
        const failures = assignments.filter(result => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Status-card assignment failed");
        if (result.evaluated || result.enqueued.length) {
          logger.info({ evaluated: result.evaluated, enqueued: result.enqueued.length }, "status-card evaluation complete");
        }
      } catch (error) {
        reconstructReactive ||= reconstruct;
        allChanges ||= evaluateAllChanges;
        for (const companyId of companiesChanged) changes.add(companyId);
        throw error;
      }
    },
    async next() {
      if (!enabled) return null;
      const [next] = await db.select({ at: statusCards.nextEvalAt }).from(statusCards)
        .innerJoin(companies, eq(companies.id, statusCards.companyId))
        .where(and(eq(companies.status, "active"), isNull(statusCards.archivedAt),
          isNull(statusCards.generatingIssueId), isNotNull(statusCards.nextEvalAt)))
        .orderBy(asc(statusCards.nextEvalAt)).limit(1);
      const deadline = next?.at?.getTime() ?? null;
      return retryAt === null ? deadline : Math.min(deadline ?? Infinity, retryAt);
    },
  };
}

export function registerStatusCardEvaluationWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof statusCardEvaluationService>,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.statusCardEvaluation, {
    run: service.run, next: service.next, onSettled: service.changed, canRun, retryMs: 30_000,
    // Batch source hints for at most one second after reconciliation. Do not
    // use minimumSpacingMs: known policy/retry deadlines must preempt batching.
    // This window alone arms no timer when the feature has no pending work.
    notificationCoalesceMs: 1_000,
  });
}
