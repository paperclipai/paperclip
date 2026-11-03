import { pollUntil } from "../api.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { remainingIdentityObservationBudget, waitForReply } from "./identity-support.js";

/** Company settings setup and all declared native turns share the original case clock. */
export async function waitForCompanySettingsTurn(ctx: ChatCatalogContext, count = 1): Promise<void> {
  remainingIdentityObservationBudget(ctx);
  const deadlineAt = ctx.observationDeadlineAt!;
  if (count === 1) await waitForReply(ctx, deadlineAt);
  else await pollUntil({
    label: `company settings native turn ${count}`, deadlineAt,
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: value => Date.now() < deadlineAt && value.source?.conversationState === "waiting"
      && value.runs.length === count && value.runs.every(run => run.status === "succeeded"),
    reject: value => value.runs.length > count ? "Company settings exceeded its declared native run bound"
      : value.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Declared company settings turn failed" : undefined,
  });
  remainingIdentityObservationBudget(ctx);
}
