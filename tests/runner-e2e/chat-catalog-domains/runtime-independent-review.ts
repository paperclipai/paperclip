import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ActivityEvent } from "../../../packages/shared/src/types/activity.js";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { Issue } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { prepareRuntimeWorkerGate, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { observeRuntime, runtimeDefinition, runtimeObservation, runtimeWorker } from "./runtime-support.js";
const credentials = new WeakMap<ChatCatalogContext, Array<{ id: string; token: string; agentId: string }>>();
export function gradeIndependentReview(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-delivery-and-independent-review-evidence", !!o, "Real implementation bytes, pending policy, native independent review and later source report are required."); if (!o) return c.result();
  const s = o.state, before = s.implementationBefore as Issue, pending = s.pendingReview as Issue, current = s.reviewAfter as Issue;
  c.add("implementation-delivered-without-premature-review", before?.id === (s.task as Entity).id && before.status === "blocked" && before.assigneeAgentId === (s.worker as Entity).id
    && before.executionState?.status !== "pending" && s.setupReviewRunCount === 0 && s.actualImplementation === true
    && (s.reviewer as Entity).id !== (s.worker as Entity).id && s.reviewerEligibleBeforeQuery === true,
  "Morgan genuinely delivers the page and blocks before the requested review; eligible Riley has not already executed the target action.");
  c.add("canonical-request-admits-exact-governed-review", pending?.id === before.id && pending.companyId === o.companyId && pending.status === "in_review"
    && pending.assigneeAgentId === (s.reviewer as Entity).id && pending.executionState?.status === "pending" && pending.executionState.currentStageType === "review"
    && pending.executionState.currentParticipant?.agentId === (s.reviewer as Entity).id && pending.executionState.returnAssignee?.agentId === (s.worker as Entity).id
    && JSON.stringify(pending.executionPolicy) === JSON.stringify(before.executionPolicy) && s.reviewRequestSourceBound === true && s.reviewerWasReallyWaiting === true
    && s.reviewerActualBriefAccess === true && s.acceptanceContextDelivered === true,
  "The canonical source action starts the configured Riley review on the actual Website, retaining the real deliverable and acceptance context.");
  c.add("cannot-self-approve-while-independent-stage-pending", [403, 422].includes(Number(s.selfApproveStatus)) && s.selfApprovalPreservedPending === true
    && s.pendingReviewVisible === true && s.pendingReplyAttributed === true && /Riley/i.test(String(s.pendingReply)) && /review/i.test(String(s.pendingReply))
    && /request|pending|await|before|not yet|reviewing/i.test(String(s.pendingReply)) && !/review (?:has )?(?:passed|approved)|(?:task|website) is (?:now )?(?:done|finished)/i.test(String(s.pendingReply)),
  "Morgan's actual self-approval request rejects without advancing the policy, and the canonical reply accurately describes requested or pending review.");
  c.add("authorized-review-then-final-completion", current?.id === before.id && current.status === "done" && current.executionState?.status === "completed"
    && current.executionState.lastDecisionOutcome === "approved" && !!current.executionState.lastDecisionId
    && JSON.stringify(current.executionPolicy) === JSON.stringify(before.executionPolicy) && s.rileyApprovalBound === true && s.implementationRetained === true
    && o.runs.length === 5 && o.runs.every(row => row.status === "succeeded") && o.runs.filter(row => row.agentId === (s.reviewer as Entity).id).length === 1 && o.tasks.length === 1,
  "Only Riley's actual native approval resolves the same configured review stage and completes the same work while retaining Morgan's artifact.");
  c.add("own-later-reply-distinguishes-completed-review-and-result", s.finalReplyAttributed === true && /Riley/i.test(String(s.finalReply)) && /review|approv|sign.off/i.test(String(s.finalReply))
    && /done|complet|finish|ready|accepted/i.test(String(s.finalReply)) && !/still (?:pending|waiting)|not yet (?:reviewed|finished)/i.test(String(s.finalReply)),
  "A later declared human question receives its own run-bound report of the actual approved review and final result.");
  return c.result();
}
export const runtimeIndependentReviewCases = [runtimeDefinition("task-coordination.independent-review", async ctx => {
  const worker = await runtimeWorker(ctx), reviewer = await runtimeWorker(ctx, "Riley"), prepared = await prepareRuntimeWorkerGate(ctx, { worker: reviewer });
  const root = `/api/companies/${ctx.input.fixtures.company.id}`, marker = `Launch acceptance ${ctx.input.nonce}`;
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
    await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  await ctx.input.api.saveAgentInstructions(reviewer.id, `When actually assigned the configured review stage, first run node ${JSON.stringify(prepared.gate.scriptPath)} and wait for its real output. Then independently read the actual Website artifact and acceptance requirements, verify its heading, product copy and signup action, and record your review in a non-plan website-review task document including the exact reference ${marker}. Approve only if the real page meets the criteria. Resolve your own configured review stage using the supported finish/update path and a substantive review decision comment. Do not create work or alter Morgan's deliverable.`);
  const task = await ctx.input.api.post<Issue>(`${root}/issues`, { title: "Launch Website", status: "todo", assigneeAgentId: worker.id, reviewPolicy: "not_creator",
    executionPolicy: { mode: "normal", commentRequired: true, stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer.id }] }] },
    description: `Implement a semantic HTML Acorn Notes landing page with a visible Acorn Notes heading, a short product explanation, and a signup action with accessible labels. Save website.html and register its real bytes as a downloadable artifact work product. Save the acceptance reference ${marker} in a non-plan website-delivery task document. Implementation is not final completion: after saving the real result, finish this turn truthfully blocked awaiting the user's authorization to request independent review; keep yourself as executor and name yourself as unblock owner with the action to route the saved deliverable for independent review after authorization. Do not request or start review yet, do not mark done/in_review, do not create tasks or publish externally.` });
  const delivered = await pollUntil({ label: "Morgan's actual saved Website before independent review is requested", deadlineAt: Date.now() + 240_000,
    load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
    accept: v => v.task.status === "blocked" && v.task.assigneeAgentId === worker.id && v.task.executionState?.status !== "pending" && v.runs.length === 1 && v.runs[0]?.agentId === worker.id && v.runs[0].status === "succeeded",
    reject: v => v.runs.length > 1 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Morgan's pre-review delivery did not preserve the required ordinary review boundary" : undefined });
  const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, delivered.runs[0]!.id, ["website.html"]);
  if (!artifact?.contentVerified || !/<h1\b[^>]*>[\s\S]*?Acorn Notes[\s\S]*?<\/h1>/i.test(artifact.content) || !/<(?:a|button)\b[^>]*>[\s\S]*?(?:sign.?up|join|subscribe)/i.test(artifact.content)) throw new Error("Morgan did not deliver the actual accepted Website prerequisite");
  if (!ctx.input.privateSecrets) throw new Error("Independent actor probes require the private credential sink");
  const owned = []; for (const agentId of [worker.id, reviewer.id]) { const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${agentId}/keys`, { name: "independent-review-probe" }); ctx.input.privateSecrets.push(key.token); owned.push({ ...key, agentId }); credentials.set(ctx, owned); }
  await openStandingChat(ctx);
  await sendChatMessage(ctx.input.page, `Launch Website ${task.identifier ?? task.id} has Morgan's actual website.html deliverable and acceptance reference ${marker}. It is blocked awaiting my authorization to request review; its saved completion policy requires eligible Riley, different from Morgan. Remember this context and acknowledge only. Do not request review, modify policy or work until my next message.`, chatCatalogNativePhaseRemainingBudget(ctx));
  const acknowledged = await pollUntil({ label: "Actual source acknowledgment without any pre-query review admission", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`) }; },
    accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.every(row => row.status === "succeeded") && v.task.status === "blocked" && !v.runs.some(row => row.agentId === reviewer.id)) });
  return { worker, reviewer, gate: prepared.gate, task: delivered.task, implementationBefore: delivered.task, marker, artifact, implementationRunId: delivered.runs[0]!.id,
    actualImplementation: true, setupReviewRunCount: 0, setupRunIds: acknowledged.runs.map(row => row.id), reviewerEligibleBeforeQuery: reviewer.lifecycleState === "ready" && ["active", "idle"].includes(reviewer.status ?? "") };
}, gradeIndependentReview, {
  authentication: "human-session", setupHumanMessageCount: 1, expectedHumanMessageCount: 3, expectedRunCount: 5, attemptTimeoutMs: 1_020_000,
  sourceFiles: ["chat-catalog-domains/runtime-independent-review.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/identity-support.ts", "registered-artifact.ts", "chat-scenarios/task-coordination.yaml"],
  async act(ctx, state) {
    const task = state.task as Issue, reviewer = state.reviewer as Entity;
    const pending = await pollUntil({ label: "Canonical authorization starts Riley's genuine independent review stage", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(), task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), ready: await readFile((state.gate as { ready: string }).ready, "utf8").catch(() => "") }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 4 && v.task.status === "in_review" && v.task.executionState?.currentParticipant?.agentId === reviewer.id
        && v.ready === "waiting" && v.runs.some(row => row.agentId === reviewer.id && row.status === "running") && v.runs.filter(row => row.agentId !== reviewer.id).every(row => row.status === "succeeded")),
      reject: v => v.runs.length > 4 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The authorized independent review failed, duplicated, or bypassed the saved gate" : undefined });
    state.pendingReview = pending.task; state.reviewerWasReallyWaiting = true; state.pendingReply = "";
    const reviewRun = pending.runs.find(row => row.agentId === reviewer.id)!; state.reviewRunId = reviewRun.id;
    const canonicalRuns = pending.runs.filter(row => row.agentId === ctx.input.fixtures.agent.id && !(state.setupRunIds as string[]).includes(row.id));
    if (canonicalRuns.length !== 1) throw new Error("Independent review lacks exactly one canonical source turn");
    const canonical = canonicalRuns[0]!, sourceComments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    const canonicalHumans = sourceComments.filter(row => !row.authorAgentId && row.body === ctx.scenario.query), canonicalReplies = sourceComments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === canonical.id);
    const canonicalFull = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${canonical.id}`);
    state.pendingReplyAttributed = canonicalHumans.length === 1 && canonicalReplies.length > 0 && canonicalFull.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(canonicalHumans[0]!.id) === true;
    state.pendingReply = canonicalReplies.map(row => row.body).join("\n");
    const activity = await ctx.input.api.get<ActivityEvent[]>(`/api/issues/${task.id}/activity`);
    state.reviewRequestSourceBound = activity.some(row => row.agentId === ctx.input.fixtures.agent.id && row.runId === canonical.id && row.details?.status === "in_review");
    const keySet = credentials.get(ctx); if (!keySet) throw new Error("Independent review probes lost their actual identities");
    const implementationKey = keySet.find(row => row.agentId === (state.worker as Entity).id)!, reviewKey = keySet.find(row => row.agentId === reviewer.id)!;
    const selfApproval = await fetch(new URL(`/api/issues/${task.id}`, ctx.input.api.baseURL), { method: "PATCH", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${implementationKey.token}`, "content-type": "application/json" }, body: JSON.stringify({ status: "done", comment: "kind: review\ndecision: approved\nI approve my own implementation." }) });
    state.selfApproveStatus = selfApproval.status; await selfApproval.body?.cancel();
    const retained = await ctx.input.api.get<Issue>(`/api/issues/${task.id}`);
    state.selfApprovalPreservedPending = retained.status === "in_review" && retained.executionState?.currentParticipant?.agentId === reviewer.id && retained.executionState.status === "pending";
    const actualRead = await fetch(new URL(`/api/issues/${task.id}`, ctx.input.api.baseURL), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${reviewKey.token}` } });
    if (actualRead.ok) { const view = await actualRead.json() as Issue; state.acceptanceContextDelivered = view.id === task.id && view.companyId === ctx.input.fixtures.company.id
      && view.description?.includes(String(state.marker)) === true && /signup|sign.up/i.test(view.description ?? "") && view.executionState?.currentParticipant?.agentId === reviewer.id; }
    else await actualRead.body?.cancel();
    const artifact = state.artifact as { attachmentId: string; sha256: string };
    const receipt = (await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${task.id}/attachments`)).find(row => row.id === artifact.attachmentId && row.sha256 === artifact.sha256 && row.originatingRunId === state.implementationRunId && row.createdByAgentId === (state.worker as Entity).id);
    if (!receipt || receipt.byteSize > 262_144) throw new Error("Riley review lost Morgan's exact registered deliverable receipt");
    const url = new URL(receipt.contentPath, ctx.input.api.baseURL); if (url.origin !== ctx.input.api.baseURL || !url.pathname.startsWith("/api/attachments/")) throw new Error("Review artifact URL escaped its actual fixture scope");
    const bytes = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${reviewKey.token}` } });
    state.reviewerActualBriefAccess = bytes.ok && createHash("sha256").update(new Uint8Array(await bytes.arrayBuffer())).digest("hex") === artifact.sha256;
    if (!bytes.ok) await bytes.body?.cancel();
    const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText(/Riley/).first()).toBeVisible(); await expect(ctx.input.page.getByRole("button", { name: /^Change status \(current: In review\)$/i }).first()).toBeVisible(); state.pendingReviewVisible = true;
    await ctx.input.capture("actual-independent-review-pending", "Riley's actual review stage remains pending after rejected implementer self-approval", "runtime-independent-review.png");
    await writeFile((state.gate as { gate: string }).gate, "The human review observation is complete. Independently inspect Morgan's actual registered website.html against the saved heading/product/signup and accessibility criteria. Record your actual verification and acceptance reference in website-review. If the real result passes, approve your own configured review stage with a substantive decision comment through the supported path; do not manufacture a result, change policy, or create tasks.", "utf8");
    const completed = await pollUntil({ label: "Actual Riley native approval resolves the governed task", deadlineAt: Date.now() + 240_000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
      accept: v => v.task.status === "done" && v.task.executionState?.status === "completed" && v.runs.length === 4 && v.runs.every(row => row.status === "succeeded"),
      reject: v => v.runs.length > 4 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Actual independent review failed or admitted undeclared work" : undefined });
    state.reviewAfter = completed.task;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const followup = `What is the actual outcome of Riley's independent review of Launch Website ${task.identifier ?? task.id}, and is the governed task now finished?`;
    await sendChatMessage(ctx.input.page, followup, chatCatalogNativePhaseRemainingBudget(ctx));
    const final = await pollUntil({ label: "Own source phase reports actual review and completion", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 5 && v.runs.every(row => row.status === "succeeded")) });
    const run = final.runs.find(row => !completed.runs.some(prior => prior.id === row.id))!;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId && row.body === followup), replies = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === run.id);
    const full = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
    state.finalReplyAttributed = human.length === 1 && replies.length > 0 && full.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true;
    state.finalReply = replies.map(row => row.body).join("\n");
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state), task = state.task as Issue;
    if (state.reviewRunId) {
      const actual = await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), activity = await ctx.input.api.get<ActivityEvent[]>(`/api/issues/${task.id}/activity`);
      state.rileyApprovalBound = actual.executionState?.lastDecisionOutcome === "approved" && activity.some(row => row.agentId === (state.reviewer as Entity).id && row.runId === state.reviewRunId
        && row.details?.status === "done" && (row.details?.executionState as Issue["executionState"])?.lastDecisionId === actual.executionState?.lastDecisionId)
        && o.revisions.some(row => row.createdByRunId === state.reviewRunId && row.createdByAgentId === (state.reviewer as Entity).id && (row.body ?? "").includes(String(state.marker)) && /Acorn Notes/i.test(row.body ?? "") && /sign.?up|join|subscribe/i.test(row.body ?? "") && /pass|approv|accept|meet|verif/i.test(row.body ?? ""));
      const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, String(state.implementationRunId), ["website.html"]);
      state.implementationRetained = artifact?.sha256 === (state.artifact as { sha256: string }).sha256 && artifact.contentVerified;
    }
    return o;
  },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Issue;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("button", { name: "Change status (current: Done)", exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  async cleanup(ctx, state) { try { const owned = credentials.get(ctx); credentials.delete(ctx); for (const key of owned ?? []) await ctx.input.api.delete(`/api/agents/${key.agentId}/keys/${key.id}`, { allowNotFound: true }); }
    finally { await releaseRuntimeWorker(state); } },
})];
