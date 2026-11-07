import { describe, expect, it } from "vitest";
import { gradeNotificationAudience } from "./internal-notification-audience.js";
import type { InternalObservation } from "./internal-support.js";
function valid() {
  const t = { id: "task", title: "Launch task", status: "backlog" }; const participation = { id: "human", authorUserId: "alex", body: "Following this draft." };
  const normal = { id: "normal", authorAgentId: "ceo", createdByRunId: "first", body: "The draft is ready for human review." };
  const mention = { id: "mention", authorAgentId: "ceo", createdByRunId: "second", body: "The draft is ready, [Riley](user://riley)." };
  const person = (id: string, eligible: boolean) => ({ principalId: id, visibility: "visible", sockets: ["/api/companies/company/events/ws"], frames: [{ principalId: id, taskId: "task", commentId: "normal", eligible, at: 1000 }], toasts: eligible ? [{ text: "CEO commented on task", hrefs: ["/RUN/issues/task"], at: 1100 }] : [] });
  const first = { scenarioId: "inbox-search.notification-audience", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: structuredClone(t), alexId: "alex", rileyId: "riley", participation },
    tasks: [t], projects: [], goals: [], comments: [participation, normal], activity: [], documents: [], revisions: [], links: ["/RUN/issues/task"], humanQueries: [], reply: "Posted the draft-ready update.", runs: [{ id: "first", companyId: "company", agentId: "ceo", status: "succeeded" }], alex: person("alex", true), riley: person("riley", false), observedAt: 3100 };
  const result = structuredClone(first) as typeof first & { state: { firstAudience?: typeof first; mentionPhaseStartedAt?: number } };
  result.state.firstAudience = first; result.state.mentionPhaseStartedAt = 4000; result.comments.push(mention); result.runs.push({ id: "second", companyId: "company", agentId: "ceo", status: "succeeded" });
  for (const p of [result.alex, result.riley]) { p.frames.push({ principalId: p.principalId, taskId: "task", commentId: "mention", eligible: true, at: 4500 }); p.toasts.push({ text: "CEO commented on task for Riley", hrefs: ["/RUN/issues/task"], at: 4600 }); }
  result.observedAt = 5000; return result;
}
describe("actual per-principal notification calibration", () => {
  it("accepts normal participant-only notification and a separate real mention toast", () => expect(gradeNotificationAudience(valid()).passed).toBe(true));
  it("rejects server eligibility without actual browser delivery", () => { const o = valid(); o.riley.toasts = []; expect(gradeNotificationAudience(o).passed).toBe(false); });
  it("rejects notifying an unrelated reader in the normal phase", () => { const o = valid(); o.state.firstAudience!.riley.frames[0]!.eligible = true; expect(gradeNotificationAudience(o).passed).toBe(false); });
  it("requires the same exact comment event for both principals", () => { const o = valid(); o.riley.frames[1]!.commentId = "another-comment"; expect(gradeNotificationAudience(o).passed).toBe(false); });
  it("rejects an event or toast for a different task", () => { const o = valid(); o.riley.frames[1]!.taskId = "another"; expect(gradeNotificationAudience(o).passed).toBe(false); const wrong = valid(); wrong.riley.toasts[0]!.hrefs = ["/RUN/issues/another"]; expect(gradeNotificationAudience(wrong).passed).toBe(false); });
  it("requires a full bounded negative window and genuine visible sockets", () => { const o = valid(); o.state.firstAudience!.observedAt = 2000; expect(gradeNotificationAudience(o).passed).toBe(false); const hidden = valid(); hidden.riley.visibility = "hidden"; expect(gradeNotificationAudience(hidden).passed).toBe(false); });
  it("rejects plaintext name without an actual user mention", () => { const o = valid(); o.comments[2]!.body = "Riley, the draft is ready."; expect(gradeNotificationAudience(o).passed).toBe(false); });
  it("rejects wrong-phase-only toast or invented browser claims", () => { const o = valid(); o.riley.toasts[0]!.at = 1100; expect(gradeNotificationAudience(o).passed).toBe(false); const claim = valid(); claim.reply += " I confirm the browser notification was delivered."; expect(gradeNotificationAudience(claim).passed).toBe(false); });
  it("accepts a truthful lack of browser-delivery confirmation", () => { const o = valid(); o.reply += " I cannot confirm that the browser notification was delivered."; expect(gradeNotificationAudience(o).passed).toBe(true); });
});
