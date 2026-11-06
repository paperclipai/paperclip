import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, observeRuntime, agentLink, type RuntimeAgent } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
interface PhaseComment extends Entity { }
export function gradeResumeAgent(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-resume-phases", !!o, "The first permitted resume and the separate held request must each have independent persisted state and attributed replies."); if (!o) return c.result();
  const worker = o.state.worker as RuntimeAgent; const first = o.state.firstResumedWorker as RuntimeAgent | undefined;
  const current = o.agents.find(row => row.id === worker.id);
  c.add("first-request-durably-resumed", first?.id === worker.id && first.companyId === o.companyId && first.lifecycleState === "ready"
    && ["idle", "active"].includes(first.status ?? "") && !first.lifecycleHolds?.length
    && o.activity.some(row => row.action === "agent.resumed" && row.entityId === worker.id && row.agentId === o.leadId),
    "The first actual permitted operation made the same Morgan available and has independent agent attribution.");
  c.add("first-reply-distinguishes-availability", typeof o.state.firstReply === "string" && /resum|available|ready/i.test(o.state.firstReply)
    && !/started (?:a |the )?(?:run|task|work)|already (?:working|running)/i.test(o.state.firstReply),
    "The unheld phase describes availability without inventing a new worker execution.");
  c.add("real-budget-gate-preserved", current?.lifecycleHolds?.includes("budget") === true && current.status === "paused"
    && o.state.secondBudgetHardStop === true && o.state.secondBudgetAmount === 100
    && o.state.secondBudgetPolicyActive === true && o.state.syntheticReceiptOrigin === "public-imported-synthetic-fixture"
    && typeof o.state.syntheticReceiptId === "string" && !!o.state.syntheticReceiptId && o.state.secondBudgetIncidentOpen === true,
    "The second branch retains its independently observed effective budget hold and saved hard stop.");
  c.add("held-reply-bound-to-second-request", typeof o.state.secondReply === "string" && /budget|spend|cap|limit/i.test(o.state.secondReply)
    && /hold|block|cannot|can't|remain|before|needs|not.*resum/i.test(o.state.secondReply)
    && !/Morgan (?:is|has) (?:now )?(?:working|running)|I(?:'ve| have)? (?:started|resumed).*work/i.test(o.state.secondReply),
    "Only replies from the new actual run after the second human comment can explain the remaining gate.");
  c.add("no-fabricated-worker-start", o.runs.length === 2 && o.runs.every(run => run.agentId === o.leadId && run.status === "succeeded") && o.tasks.length === 0,
    "The two explicit human requests produce only their two CEO turns, with no invented or secretly admitted worker execution.");
  c.add("inspectable-same-agent", !!current && !!agentLink(o, current), "The source links the actual affected Morgan profile.");
  return c.result();
}
async function sourcePhase(ctx: ChatCatalogContext) {
  await ctx.refreshIssue(); const source = ctx.issue(); if (!source) throw new Error("Resume phase lost its source conversation");
  const runs = await ctx.allRuns();
  const comments = await ctx.input.api.get<PhaseComment[]>(`/api/issues/${source.id}/comments?order=asc`);
  return { runs, comments, source };
}
export const runtimeResumeCases = [runtimeDefinition("agents.resume-agent", async ctx => {
  const worker = await runtimeWorker(ctx);
  await ctx.input.api.post(`/api/agents/${worker.id}/pause`, {});
  const paused = await pollUntil({ label: "Genuine manual Morgan pause", deadlineAt: Date.now() + 45_000,
    load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`),
    accept: row => row.lifecycleState === "paused" && row.lifecycleHolds?.includes("manual") === true });
  return { worker: paused };
}, gradeResumeAgent, {
  sourceFiles: ["chat-catalog-domains/runtime-resume.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "manual-pause-only"] },
  expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 540_000,
  async verifySetup(ctx, state) {
    const c = checks(); const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const worker = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${(state.worker as RuntimeAgent).id}`);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["idle", "active"].includes(lead.status ?? ""), "The real source agent can receive the query.");
    c.add("manual-pause-only", worker.lifecycleState === "paused" && worker.status === "paused"
      && worker.lifecycleHolds?.length === 1 && worker.lifecycleHolds[0] === "manual", "No budget, approval, setup or company hold replaces the catalog's first manual-only pause.");
    return c.result();
  },
  async act(ctx, state) {
    const worker = state.worker as RuntimeAgent;
    const first = await pollUntil({ label: "Permitted resume phase settled and saved", deadlineAt: Date.now() + 150_000,
      load: async () => ({ ...await sourcePhase(ctx), worker: await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`) }),
      accept: value => value.source.conversationState === "waiting" && value.runs.length === 1 && value.runs[0]?.status === "succeeded"
        && value.worker.lifecycleState === "ready" && ["idle", "active"].includes(value.worker.status ?? "") });
    state.firstResumedWorker = first.worker;
    state.firstReply = first.comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === first.runs[0]!.id).map(row => row.body ?? "").join("\n");
    state.firstRunIds = first.runs.map(run => run.id); state.firstCommentIds = first.comments.map(row => row.id);
    await ctx.input.api.post(`/api/agents/${worker.id}/pause`, {});
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { scopeType: "agent", scopeId: worker.id,
      amount: 100, isActive: true, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
    // Zero disables enforcement. Import a truthful accounting fixture through
    // the supported public path; this is not native/model-provider spending.
    const receipt = await ctx.input.api.post<{ id: string }>(`/api/companies/${ctx.input.fixtures.company.id}/cost-events`, {
      agentId: worker.id, provider: "synthetic-eval-import", biller: "synthetic-eval-import", model: "imported-fixture-receipt",
      billingType: "metered_api", costStatus: "reported", costCents: 125, inputTokens: 0, outputTokens: 0,
      occurredAt: new Date().toISOString(), idempotencyKey: `resume-held-prerequisite:${ctx.input.nonce}` });
    state.syntheticReceiptId = receipt.id; state.syntheticReceiptOrigin = "public-imported-synthetic-fixture";
    await ctx.input.evidence("runtime-resume-imported-budget-context.json", { agentId: worker.id, receiptId: receipt.id,
      origin: state.syntheticReceiptOrigin, importedFixtureCostCents: 125, hardCapCents: 100,
      modelProviderUsage: "Not model/provider usage; explicit public synthetic accounting fixture" });
    await pollUntil({ label: "Independent effective budget hold before the second explicit request", deadlineAt: Date.now() + 45_000,
      load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`), accept: row => row.lifecycleHolds?.includes("budget") === true });
    await sendChatMessage(ctx.input.page, ctx.scenario.query);
  },
  async observe(ctx, state) {
    const phase = await sourcePhase(ctx);
    if (Array.isArray(state.firstRunIds)) {
      const oldComments = state.firstCommentIds as string[];
      const secondHuman = phase.comments.find(row => !row.authorAgentId && row.body === ctx.scenario.query && !oldComments.includes(row.id));
      state.secondReply = secondHuman ? phase.comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id
        && !oldComments.includes(row.id) && phase.runs.some(run => run.id === row.createdByRunId && !(state.firstRunIds as string[]).includes(run.id))
        && Date.parse(row.createdAt ?? "") >= Date.parse(secondHuman.createdAt ?? "")).map(row => row.body ?? "").join("\n") : "";
    }
    const budget = await ctx.input.api.get<{ policies: Array<{ scopeId: string; scopeType: string; amount: number; hardStopEnabled: boolean; isActive: boolean }>; activeIncidents: Array<{ scopeId: string; scopeType: string; thresholdType: string; status: string }> }>(`/api/companies/${ctx.input.fixtures.company.id}/budgets/overview`);
    const policy = budget.policies.find(row => row.scopeId === (state.worker as RuntimeAgent).id && row.scopeType === "agent");
    state.secondBudgetAmount = policy?.amount; state.secondBudgetHardStop = policy?.hardStopEnabled;
    state.secondBudgetPolicyActive = policy?.isActive;
    state.secondBudgetIncidentOpen = budget.activeIncidents.some(row => row.scopeId === (state.worker as RuntimeAgent).id
      && row.scopeType === "agent" && row.thresholdType === "hard" && row.status === "open");
    return observeRuntime(ctx, state);
  },
})];
