/**
 * Event-waker plugin worker.
 *
 * Subscribes to `issue.updated` and wakes the assignee whenever an issue
 * transitions to an actionable state, or is reassigned while in one of those
 * states. Replaces the external bash poller (paperclip-event-waker.sh).
 */
import { definePlugin } from "@paperclipai/plugin-sdk";

type WakerConfig = {
  wakeOnTransitions?: string[];
  debounceMs?: number;
  optOutAgentIds?: string[];
};

const DEFAULT_TRANSITIONS = [
  "*:todo",
  "*:in_progress",
  "*:in_review",
  "*:blocked",
  "blocked:todo",
  "blocked:in_progress",
];

const ACTIONABLE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

/**
 * Pattern is "prev:curr" with "*" matching any side.
 */
function transitionMatches(pattern: string, prev: string, curr: string): boolean {
  const [pPrev, pCurr] = pattern.split(":");
  if (pPrev === undefined || pCurr === undefined) return false;
  if (pPrev !== "*" && pPrev !== prev) return false;
  if (pCurr !== "*" && pCurr !== curr) return false;
  return true;
}

export default definePlugin({
  async setup(ctx) {
    ctx.logger.info("event-waker starting");

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Schedule a debounced wake for `issueId` (the host wakes its current
     * assignee). If another change for the same issue lands within `debounceMs`,
     * the prior timer is cancelled and a new one starts. The bash poller did not
     * debounce; the plugin does because event-driven delivery means small bursts
     * are common (e.g. a PATCH that changes both status AND assignee fires twice).
     */
    function scheduleWake(
      issueId: string,
      companyId: string,
      reason: string,
      debounceMs: number,
    ) {
      const existing = debounceTimers.get(issueId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(async () => {
        debounceTimers.delete(issueId);
        try {
          await ctx.issues.requestWakeup(issueId, companyId, {
            reason,
            contextSource: "plugin.event-waker",
          });
          ctx.logger.info("waker fired", { issueId, reason });
        } catch (err) {
          ctx.logger.error("waker wakeup failed", {
            issueId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, debounceMs);
      debounceTimers.set(issueId, timer);
    }

    ctx.events.on("issue.updated", async (event) => {
      const config = ((await ctx.config.get()) ?? {}) as WakerConfig;
      const transitions = config.wakeOnTransitions ?? DEFAULT_TRANSITIONS;
      const debounceMs = typeof config.debounceMs === "number" ? config.debounceMs : 500;
      const optOut = new Set(config.optOutAgentIds ?? []);

      // Event payload shape: { id, companyId, before: { status, assigneeAgentId }, after: { status, assigneeAgentId } }
      const payload = ((event as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>;
      const issueId = String(payload.id ?? payload.issueId ?? "");
      const companyId = String(payload.companyId ?? "");
      if (!issueId || !companyId) return;

      const before = (payload.before ?? {}) as Record<string, unknown>;
      const after = (payload.after ?? {}) as Record<string, unknown>;

      const prevStatus = String(before.status ?? "");
      const currStatus = String(after.status ?? "");
      const prevAssignee = String(before.assigneeAgentId ?? "");
      const currAssignee = String(after.assigneeAgentId ?? "");

      // Status transition path: wake if matched + actionable + not opted out.
      if (prevStatus !== currStatus && currAssignee && !optOut.has(currAssignee)) {
        const wakeOnStatus = transitions.some((p) =>
          transitionMatches(p, prevStatus || "*", currStatus),
        );
        if (wakeOnStatus) {
          scheduleWake(
            issueId,
            companyId,
            `event-waker: status ${prevStatus || "NEW"} → ${currStatus}`,
            debounceMs,
          );
        }
      }

      // Reassignment with no status change but actionable status: wake the new owner.
      if (
        prevAssignee !== currAssignee &&
        currAssignee &&
        !optOut.has(currAssignee) &&
        ACTIONABLE_STATUSES.has(currStatus)
      ) {
        scheduleWake(
          issueId,
          companyId,
          `event-waker: reassigned to ${currAssignee.slice(0, 8)} (status=${currStatus})`,
          debounceMs,
        );
      }
    });

    ctx.logger.info("event-waker subscribed to issue.updated");
  },
});
