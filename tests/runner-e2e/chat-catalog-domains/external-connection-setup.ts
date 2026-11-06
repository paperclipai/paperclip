import { expect } from "@playwright/test";
import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
import { definition, externalObservation, observeExternal, root, checks } from "./external-support.js";
import { pollUntil } from "../api.js";

export function addressedNotionRequest(card: ConnectionIntentInteraction, target: {
  companyId: string; issueId: string; agentId: string; personId: string;
}) {
  return card.kind === "connection_intent" && card.companyId === target.companyId
    && card.issueId === target.issueId && card.payload.serviceSlug === "notion"
    && card.payload.serviceName === "Notion" && card.payload.requestingAgentId === target.agentId
    && card.createdByAgentId === target.agentId && card.addresseeUserId === target.personId
    && typeof card.sourceRunId === "string" && !!card.sourceRunId;
}

export function gradeConnectionDecline(value: unknown) {
  const c = checks(); const o = externalObservation(value);
  c.add("complete-declined-connection-evidence", !!o, "The actual addressed connection request and persisted decline are required."); if (!o) return c.result();
  const cards = o.interactions.filter(row => row.kind === "connection_intent" && row.payload?.serviceSlug === "notion");
  const card = cards[0] as unknown as ConnectionIntentInteraction | undefined;
  c.add("single-addressed-human-decline", cards.length === 1 && !!card && card.id === o.state.intentId && card.status !== "pending"
    && card.result?.outcome === "declined" && !!card.resolvedByUserId && card.resolvedByUserId === card.addresseeUserId && !card.resolvedByAgentId
    && o.state.cardVisibleBeforeDecline === true && o.state.declineRequestMatched === true
    && addressedNotionRequest(card, { companyId: o.companyId, issueId: String(o.state.sourceIssueId), agentId: o.leadId, personId: String(o.state.personId) }), "The intended person visibly declines one Notion request; no replacement request is created.");
  c.add("no-connected-account-or-provider-read", o.connections.length === 0 && o.state.connectedBeforeDecline === 0
    && o.state.providerInvocations === 0, "There is no credential-bearing connection and no provider invocation after a decline.");
  c.add("post-decline-response-bound", typeof o.state.initialRunId === "string" && o.phaseReplies.some(row => row.runId !== o.state.initialRunId && o.runs.some(run => run.id === row.runId && run.status === "succeeded")), "The incomplete research explanation belongs to the actual decline continuation run.");
  const continuationReply = o.phaseReplies.filter(row => row.runId !== o.state.initialRunId).map(row => row.body).join("\n");
  c.add("honest-incomplete-research", /(?:not|couldn.t|cannot|can.t|unable|declin|without).*(?:read|connect|access|notion)|(?:notion|access).*(?:declin|not connected)/is.test(continuationReply)
    && /paste|excerpt|share|provide|copy/i.test(continuationReply), "The reply explains unavailable research and offers supplied content as an alternative.");
  return c.result();
}
export const connectionSetupExternalCases = [definition("connection-setup.notion-declined", async ctx => {
  const current = await ctx.input.api.get<{ connections: unknown[] }>(`${root(ctx)}/tools/connections`);
  if (current.connections.length) throw new Error("No-connection prerequisite violated in disposable company");
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  if (!session.user?.id) throw new Error("Notion decline requires the actual signed-in person");
  return { connectedBeforeDecline: current.connections.length, personId: session.user.id };
}, gradeConnectionDecline, {
  authentication: "human-session", expectedRunCount: 2, minimumRunCount: 1, attemptTimeoutMs: 420_000,
  sourceFiles: ["chat-catalog-domains/external-connection-setup.ts", "chat-catalog-domains/external-support.ts", "chat-catalog-domains/internal-support.ts", "../../ui/src/features/connections/ConnectionIntentInteractionBody.tsx", "../../ui/src/api/connection-intents.ts", "chat-scenarios/connection-setup.yaml"],
  async act(ctx, state) {
    const cards = await pollUntil({ label: "addressed Notion connection request", deadlineAt: Date.now() + 150_000,
      load: async () => { await ctx.refreshIssue(); return ctx.issue() ? ctx.input.api.get<ConnectionIntentInteraction[]>(`/api/issues/${ctx.issue()!.id}/interactions`) : []; },
      accept: rows => rows.some(row => row.kind === "connection_intent" && row.payload.serviceSlug === "notion" && row.status === "pending") });
    const pending = cards.filter(row => row.kind === "connection_intent" && row.payload.serviceSlug === "notion" && row.status === "pending");
    if (pending.length !== 1) throw new Error("Expected exactly one Notion connection request");
    const card = pending[0]!;
    if (!ctx.issue() || !addressedNotionRequest(card, { companyId: ctx.input.fixtures.company.id, issueId: ctx.issue()!.id, agentId: ctx.input.fixtures.agent.id, personId: String(state.personId) })
      || !(await ctx.allRuns()).some(run => run.id === card.sourceRunId)) throw new Error("Notion card does not belong to this person's actual canonical run");
    state.intentId = card.id; state.initialRunId = card.sourceRunId; state.sourceIssueId = card.issueId;
    const view = ctx.input.page.locator(`[id=${JSON.stringify(`connection-intent-focus-target-${card.id}`)}]`);
    await expect(view.getByText(`${card.payload.requestingAgentName} needs Notion`, { exact: true })).toBeVisible();
    const button = view.getByRole("button", { name: "Not now", exact: true });
    await expect(button).toBeVisible(); state.cardVisibleBeforeDecline = true;
    const declined = ctx.input.page.waitForResponse(response => new URL(response.url()).origin === ctx.input.api.baseURL && new URL(response.url()).pathname === `/api/connection-intents/${card.id}/decline` && response.request().method() === "POST");
    await button.click();
    const response = await declined;
    if (!response.ok()) throw new Error(`Actual addressed Notion decline returned HTTP ${response.status()}`);
    const saved = await response.json() as ConnectionIntentInteraction;
    state.declineRequestMatched = saved.id === card.id && saved.status === "rejected" && saved.result?.outcome === "declined" && saved.resolvedByUserId === state.personId;
    if (!state.declineRequestMatched) throw new Error("Visible Not now did not retain this person's exact decline");
    await expect(view.getByText("Connection declined", { exact: true })).toBeVisible();
  },
  async observe(ctx, state) {
    // A public connection activity read is only available for real connections.
    // With zero connections there is no credential-bearing provider path. Also
    // count persisted tool gateway events to reject attempted alternate calls.
    const o = await observeExternal(ctx, state);
    const activity = await ctx.input.api.get<Array<{ action?: string }>>(`${root(ctx)}/activity?limit=1000`);
    state.providerInvocations = activity.filter(row => /tool.*(?:invoked|called|executed)/.test(row.action ?? "")).length;
    return { ...o, state };
  },
  async verifyResult(ctx, state) {
    const card = ctx.input.page.locator(`[id=${JSON.stringify(`connection-intent-focus-target-${state.intentId}`)}]`);
    await expect(card.getByText("Connection declined", { exact: true })).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
})];
