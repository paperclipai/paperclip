import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
interface HireApproval { id: string; companyId: string; type: string; status: string; requestedByAgentId: string | null;
  decidedByUserId: string | null; payload: { agentId?: string; name?: string; role?: string; title?: string; reportsTo?: string; adapterType?: string; adapterConfig?: unknown } }
async function pendingHire(ctx: ChatCatalogContext, name: string) {
  return pollUntil({ label: `Actual governed ${name} proposal`, deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(),
      approvals: await ctx.input.api.get<HireApproval[]>(`/api/companies/${ctx.input.fixtures.company.id}/approvals`),
      agents: await ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${ctx.input.fixtures.company.id}/agents`) }; },
    accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.approvals.filter(row => row.type === "hire_agent" && row.status === "pending" && row.payload.name === name).length === 1
      && value.agents.some(row => row.name === name && row.status === "pending_approval")
      && value.runs.every(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded"),
    reject: value => value.runs.length > 4 || value.runs.some(run => run.agentId !== ctx.input.fixtures.agent.id || ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Governed hire admitted unexpected work or failed" : undefined });
}
export function pendingHireGuidance(reply: string, name: "Morgan" | "Jules") {
  if (!/pending|approv(?:al|e)|propos|await|board/i.test(reply) || /successfully hired/i.test(reply)) return false;
  // A hire request can be ready for the board while its intended employee
  // remains pending. Do not turn that into a general exemption for ready.
  const employeeClaim = new RegExp(`\\b(?:${name}|(?:the )?(?:QA engineer|employee|agent|hire)|they|he|she)\\s+(?:is|are|has|have)\\s+(?:now |already )?(?:been )?(?:ready(?! for (?:board )?(?:approval|review))|working|started|active|running)\\b`, "i");
  return !employeeClaim.test(reply);
}
export function gradeGovernedHire(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-governed-hire-evidence", !!o, "Actual pending proposals, human decisions, preserved intended identity and no premature worker execution are required."); if (!o) return c.result();
  const rejected = o.state.firstProposal as HireApproval | undefined; const accepted = o.state.secondProposal as HireApproval | undefined;
  const approvals = o.state.approvalsAfter as HireApproval[] | undefined;
  const first = approvals?.find(row => row.id === rejected?.id); const second = approvals?.find(row => row.id === accepted?.id);
  c.add("one-proposal-per-explicit-request", !!rejected && !!accepted && rejected.id !== accepted.id && approvals?.length === 2
    && rejected.companyId === o.companyId && accepted.companyId === o.companyId
    && [rejected, accepted].every(row => row.type === "hire_agent" && row.status === "pending" && row.requestedByAgentId === o.leadId
      && row.payload.role === "qa" && !!row.payload.adapterType && row.payload.adapterConfig != null)
    && rejected.payload.name === "Morgan" && accepted.payload.name === "Jules" && o.state.secondRequestAttributed === true,
  "The canonical Morgan proposal and separately changed human Jules request each produce one inspectable QA proposal with real configuration.");
  c.add("rejected-hire-stays-inactive", first?.status === "rejected" && !!first.decidedByUserId && o.state.rejectedBeforeChangedRequest === true
    && !o.agents.some(row => row.id === rejected?.payload.agentId && row.lifecycleState === "ready")
    && o.state.noRepeatedProposalBeforeChangedRequest === true,
  "The genuine human rejection leaves no working Morgan or repeated proposal before the person explicitly changes their request.");
  const before = o.state.acceptedBefore as RuntimeAgent | undefined; const current = o.agents.find(row => row.id === accepted?.payload.agentId);
  c.add("accepted-same-intended-hire", second?.status === "approved" && !!second.decidedByUserId && !!before && !!current
    && current.name === "Jules" && current.companyId === o.companyId && current.lifecycleState === "ready"
    && ["active", "idle"].includes(current.status ?? "") && unchangedAgent(before, current),
  "Human acceptance activates the exact proposed Jules identity and admitted configuration, rather than a replacement employee.");
  c.add("no-worker-before-or-after-decision", o.state.noWorkerBeforeFirstDecision === true && o.state.noWorkerBeforeSecondDecision === true
    && o.runs.length >= 2 && o.runs.length <= 4 && o.runs.every(run => run.agentId === o.leadId && run.status === "succeeded") && o.tasks.length === 0,
  "Neither proposed employee executes before approval, and no unrequested task or employee work is created by either decision.");
  const extra = o.runs.filter(run => !(o.state.requestRunIds as string[]).includes(run.id));
  c.add("bounded-authoritative-decision-notifications", extra.every(run => ["approval.approved", "approval.rejected"].includes(String(run.contextSnapshot?.source))
    && [rejected?.id, accepted?.id].includes(String(run.contextSnapshot?.approvalId))),
  "Any extra provider turn is independently tied to one of these exact real human approval decisions.");
  c.add("honest-pending-phase-guidance", pendingHireGuidance(String(o.state.firstReply), "Morgan")
    && pendingHireGuidance(String(o.state.secondReply), "Jules"),
  "Each actual reply describes an approvable proposal, without claiming that its employee is ready or working before approval.");
  return c.result();
}
export const runtimeHiringCases = [runtimeDefinition("agents.hire-needs-approval", async ctx => {
  await ctx.input.api.patch(`/api/companies/${ctx.input.fixtures.company.id}`, { requireBoardApprovalForNewAgents: true });
  const company = await ctx.input.api.get<{ requireBoardApprovalForNewAgents: boolean }>(`/api/companies/${ctx.input.fixtures.company.id}`);
  if (!company.requireBoardApprovalForNewAgents) throw new Error("Actual company hire approval policy did not persist");
  return { companyRequiresApproval: true };
}, gradeGovernedHire, {
  sourceFiles: ["chat-catalog-domains/runtime-hiring.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  expectedHumanMessageCount: 2, expectedRunCount: 4, minimumRunCount: 2, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    const root = `/api/companies/${ctx.input.fixtures.company.id}`; const source = ctx.input.page.url();
    const initial = await pendingHire(ctx, "Morgan"); const first = initial.approvals.find(row => row.payload.name === "Morgan" && row.status === "pending")!;
    state.firstProposal = first; state.noWorkerBeforeFirstDecision = initial.runs.every(run => run.agentId === ctx.input.fixtures.agent.id);
    state.firstReply = (await observeRuntime(ctx, state)).reply;
    const firstRequestRuns = initial.runs.filter(run => run.contextSnapshot?.source !== "approval.approved" && run.contextSnapshot?.source !== "approval.rejected").map(run => run.id);
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/approvals/${first.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("Morgan", { exact: true }).first()).toBeVisible();
    await ctx.input.page.getByRole("button", { name: "Reject", exact: true }).click();
    const rejected = await pollUntil({ label: "Rejected Morgan stays inactive without a repeated proposal", deadlineAt: Date.now() + 60_000,
      load: async () => ({ approvals: await ctx.input.api.get<HireApproval[]>(`${root}/approvals`), agent: await ctx.input.api.get<RuntimeAgent>(`/api/agents/${first.payload.agentId}`) }),
      accept: value => value.approvals.find(row => row.id === first.id)?.status === "rejected" && value.agent.lifecycleState === "rejected" });
    state.rejectedBeforeChangedRequest = true; state.noRepeatedProposalBeforeChangedRequest = rejected.approvals.length === 1;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const prior = (await ctx.allRuns()).map(run => run.id);
    const changed = "I rejected Morgan. I am changing the request: propose a separate QA engineer named Jules using our currently admitted coding account and runtime. Do not create a task or start employee work. Keep the required board approval pending so I can inspect and accept that one intended hire.";
    await sendChatMessage(ctx.input.page, changed);
    const secondPhase = await pendingHire(ctx, "Jules"); const second = secondPhase.approvals.find(row => row.payload.name === "Jules" && row.status === "pending")!;
    state.secondProposal = second; state.noWorkerBeforeSecondDecision = secondPhase.runs.every(run => run.agentId === ctx.input.fixtures.agent.id);
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    const human = comments.filter(row => row.body === changed && !row.authorAgentId);
    const next = secondPhase.runs.filter(run => !prior.includes(run.id) && !["approval.approved", "approval.rejected"].includes(String(run.contextSnapshot?.source)));
    const profiles = await Promise.all(next.map(run => ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`)));
    state.secondRequestAttributed = human.length === 1 && next.length === 1 && profiles.some(run => run.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id));
    state.requestRunIds = [...firstRequestRuns, ...next.map(run => run.id)];
    state.secondReply = comments.filter(row => next.some(run => run.id === row.createdByRunId) && row.authorAgentId === ctx.input.fixtures.agent.id).map(row => row.body ?? "").join("\n");
    state.acceptedBefore = secondPhase.agents.find(row => row.id === second.payload.agentId);
    state.worker = state.acceptedBefore;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/approvals/${second.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("Jules", { exact: true }).first()).toBeVisible();
    await ctx.input.page.getByRole("button", { name: "Approve", exact: true }).click();
    await pollUntil({ label: "Accepted exact QA hire becomes genuinely admitted", deadlineAt: Date.now() + 90_000,
      load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${second.payload.agentId}`),
      accept: row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status ?? ""),
      reject: row => row.lifecycleState === "error" ? "Approved runtime did not qualify; no fake ready state is permitted" : undefined });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("approved", { exact: true }).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    state.approvalsAfter = await ctx.input.api.get<HireApproval[]>(`/api/companies/${ctx.input.fixtures.company.id}/approvals`);
    return observeRuntime(ctx, state);
  },
})];
