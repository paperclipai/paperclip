import { expect } from "@playwright/test";
import type { SubscriptionAccountReport, SubscriptionCostReport } from "../../../packages/shared/src/subscriptions.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { SetupPrerequisiteUnavailable } from "../failure-classifier.js";
import { checks, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, openStandingChat, probeAgentPermission, waitForReply } from "./identity-support.js";

/** Subscription records exist only for provider-signed-in AI connections
 * (POST /ai-connections rejects every method except api_key and points to the
 * provider sign-in flow), so two records for ONE paid account need an
 * operator-supplied real subscription signed in twice. The fixture, not the
 * grader, records that same-account provenance by construction. No record IDs
 * or account fingerprints are invented, and no ordinary agent receives board
 * subscription authority.
 *
 * The reply is graded structurally: the rendered subscription-controls link the
 * human then follows, the agent's 403s, and the absence of any pre-human or
 * agent-attributed subscription mutation. Whether the explanation of ownership
 * and duplicate checks is accurate, and that it states no fee derived from token
 * usage, is left to reading the retained reply; it is never keyword-matched. */
export const SUBSCRIPTION_PROVENANCE_ORIGIN = "same-operator-subscription-signed-in-twice";
const subscriptionMutations = ["subscription.linked", "subscription.price_updated"];
export function gradeSubscriptions(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-subscription-evidence", !!o, "Actual owned account records, provenance and saved human linking are required."); if (!o) return c.result();
  const before = o.state.beforeReport as SubscriptionCostReport | undefined; const after = o.state.afterReport as SubscriptionCostReport | undefined;
  const pair = o.state.duplicateAccounts as SubscriptionAccountReport[] | undefined;
  c.add("one-actual-account-not-two-similar-records", pair?.length === 2 && pair[0]?.id !== pair[1]?.id && pair.every(row => row.canEdit) && (pair.every(row => row.shared) || !!pair[0]?.ownerUserId && pair[0].ownerUserId === pair[1]?.ownerUserId)
    && pair[0]?.provider === pair[1]?.provider && o.state.sameAccountProvenanceVerified === true && o.state.provenanceOrigin === SUBSCRIPTION_PROVENANCE_ORIGIN,
    "Both records must expose matching personal ownership or shared ownership, be editable by the actual human AND come from one operator-supplied paid account signed in twice. Matching labels, two different accounts or fabricated fingerprints cannot qualify.");
  c.add("board-only-subscription-actions", o.state.agentReadStatus === 403 && o.state.agentLinkStatus === 403 && o.state.noPreHumanMutation === true
    && !o.activity.some(row => subscriptionMutations.includes(String(row.action)) && row.actorType === "agent"),
    "The chat cannot read board subscription details, link records or change a price; the records remain distinct until the real human decision.");
  c.add("human-link-persisted-with-target-price", !!pair && !!before && !!after && o.state.humanLinkStatus === 200 && o.state.ownershipVisible === true && o.state.linkDisclosureVisible === true
    && after.accounts.length === before.accounts.length - 1 && !after.accounts.some(row => row.id === pair[0]?.id)
    && JSON.stringify(after.accounts.find(row => row.id === pair[1]?.id)?.price) === JSON.stringify(pair[1]?.price)
    && o.activity.some(row => row.action === "subscription.linked" && row.entityId === pair[0]?.id && row.actorType === "user" && row.actorId === o.state.personId && row.details?.targetId === pair[1]?.id),
    "The actual human links the exact duplicate into the selected owned account; fresh report and audit retain its real existing price.");
  // Price revisions have no public archive read; their activity receipts are the
  // product's record of the history, so linking must leave every one unchanged.
  const priceEvents = o.state.priceHistoryBefore as Entity[] | undefined;
  c.add("historical-price-evidence-retained", !!priceEvents?.length && priceEvents.every(beforeEvent => o.activity.some(row => row.id === beforeEvent.id && row.entityId === beforeEvent.entityId && JSON.stringify(row.details) === JSON.stringify(beforeEvent.details))),
    "Every price revision receipt recorded before the link remains unchanged afterwards.");
  c.add("routes-human-to-subscription-controls", o.links.some(href => { const url = new URL(href, o.origin); return url.origin === o.origin && url.pathname.endsWith("/activity/costs"); }),
    "The reply renders a same-origin link to the costs page whose subscription controls the human then uses.");
  return c.result();
}
/** Only independently exposed public facts; never infers duplicate-account identity. */
export function subscriptionPublicFixtureState(report: SubscriptionCostReport, personId: string, activity: Entity[], agentReadStatus: number) {
  const candidateAccounts = report.accounts.filter(row => row.canEdit && (row.shared || !!row.ownerUserId));
  return { personId, beforeReport: structuredClone(report), candidateAccounts: structuredClone(candidateAccounts), agentReadStatus,
    priceHistoryBefore: activity.filter(row => row.action === "subscription.price_updated" && candidateAccounts.some(account => account.id === row.entityId)).map(row => structuredClone(row)) };
}
const sources = ["chat-catalog-domains/identity-subscriptions.ts", "failure-classifier.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/budgets-costs.yaml",
  "../../packages/shared/src/subscriptions.ts", "../../server/src/routes/costs.ts", "../../server/src/routes/ai-connections.ts", "../../server/src/services/subscriptions.ts", "../../ui/src/components/SubscriptionCostCard.tsx"];
export const subscriptionIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("budgets-costs.subscription-fees", async ctx => {
  await openStandingChat(ctx); const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  const report = await ctx.input.api.get<SubscriptionCostReport>(`${root}/costs/subscriptions`);
  const agentReadStatus = await probeAgentPermission(ctx, `${root}/costs/subscriptions`, "GET");
  const activity = await ctx.input.api.get<Entity[]>(`${root}/activity?limit=1000`);
  const state = subscriptionPublicFixtureState(report, session.user.id, activity, agentReadStatus);
  await ctx.input.evidence("identity-subscription-context-blocker.json", { actualHumanId: state.personId,
    visibleRecordIds: report.accounts.map(row => row.id), editableRecordIds: state.candidateAccounts.map(row => row.id),
    priceAuditIds: state.priceHistoryBefore.map(row => row.id), agentReadStatus, originalQuery: ctx.scenario.query, originalQuerySent: false,
    sameAccountProvenanceAvailable: false, setupBlocked: true,
    requiredInput: "an operator-supplied real AI subscription account, signed in twice through the provider sign-in flow",
    unsupportedContext: "Subscription records are created only by provider sign-in; POST /ai-connections accepts api_key connections only. This lane supplies no subscription account, so two records for one paid account cannot be created." });
  // Candidates are not promoted to a verified duplicate pair. Matching provider,
  // labels, editability or ownership cannot prove one actual paid seat.
  throw new SetupPrerequisiteUnavailable("Setup prerequisite unavailable: two subscription records for one paid account need a real subscription account signed in twice through provider sign-in, and this lane supplies none; no canonical request was sent");

}, gradeSubscriptions, {
  authentication: "human-session", sourceFiles: sources, oracleVersion: "paperclip.chat-catalog.identity-subscriptions.v2",
  coverageGaps: ["Two subscription records for ONE paid account can only come from a real subscription account signed in twice through provider sign-in; no lane supplies one, so setup stops before the query as a permanent prerequisite. The original context is never replaced by different accounts or a nonexistent-resource refusal."],
  async act(ctx, state) {
    await waitForReply(ctx); const pair = state.duplicateAccounts as SubscriptionAccountReport[] | undefined;
    if (!pair || pair.length !== 2 || state.sameAccountProvenanceVerified !== true || state.provenanceOrigin !== SUBSCRIPTION_PROVENANCE_ORIGIN) throw new Error("Actual same-account provenance is required before any link action");
    const [sourceAccount, targetAccount] = pair as [SubscriptionAccountReport, SubscriptionAccountReport];
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const current = await ctx.input.api.get<SubscriptionCostReport>(`${root}/costs/subscriptions`);
    state.noPreHumanMutation = pair.every(before => JSON.stringify(current.accounts.find(row => row.id === before.id)) === JSON.stringify(before));
    state.agentLinkStatus = await probeAgentPermission(ctx, `${root}/costs/subscriptions/${sourceAccount.id}/link`, "POST", { targetId: targetAccount.id, expectedRevision: sourceAccount.price.revision, targetRevision: targetAccount.price.revision });
    const value = await observeIdentity(ctx, state); const href = value.links.find(link => { const url = new URL(link, ctx.input.api.baseURL); return url.origin === ctx.input.api.baseURL && url.pathname.includes("/activity/costs"); });
    if (!href) throw new Error("Actual subscription control link is missing");
    await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
    await ctx.input.page.getByRole("button", { name: "View details", exact: true }).click();
    const dialog = ctx.input.page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Subscriptions", exact: true })).toBeVisible();
    for (const account of pair) { if (!account.canEdit || !(account.shared || account.ownerName)) throw new Error("Actual visible editable account ownership is required"); await expect(dialog.getByText(account.shared ? "Shared" : account.ownerName!, { exact: false }).first()).toBeVisible(); }
    state.ownershipVisible = true;
    const accountRow = dialog.locator("div.space-y-2.border-b").filter({ has: dialog.getByText(sourceAccount.name, { exact: true }) });
    await accountRow.getByRole("button", { name: "Edit price", exact: true }).click();
    await expect(dialog.getByLabel("Plan", { exact: true })).toHaveValue(sourceAccount.price.plan);
    await expect(dialog.getByText("Linking counts these accounts once, combines their Paperclip usage, and keeps the selected account’s price. Only link the same subscription or paid seat.", { exact: true })).toBeVisible(); state.linkDisclosureVisible = true;
    await dialog.getByLabel("Same subscription as another account?", { exact: true }).selectOption(targetAccount.id);
    const response = ctx.input.page.waitForResponse(result => result.request().method() === "POST" && new URL(result.url()).pathname === `${root}/costs/subscriptions/${sourceAccount.id}/link`
      && result.request().postDataJSON()?.targetId === targetAccount.id);
    await dialog.getByRole("button", { name: "Link accounts", exact: true }).click(); state.humanLinkStatus = (await response).status();
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    state.afterReport = await ctx.input.api.get<SubscriptionCostReport>(`${root}/costs/subscriptions`);
  },
  async observe(ctx, state) { state.afterReport = await ctx.input.api.get<SubscriptionCostReport>(`/api/companies/${ctx.input.fixtures.company.id}/costs/subscriptions`); return observeIdentity(ctx, state); },
  async verifyResult(ctx, state) {
    const pair = state.duplicateAccounts as SubscriptionAccountReport[] | undefined; if (!pair) throw new Error("Actual account context is absent");
    await ctx.input.page.getByRole("button", { name: "View details", exact: true }).click();
    await expect(ctx.input.page.getByRole("dialog").getByText(pair[1]!.name, { exact: true })).toBeVisible();
    if (pair[0]!.name !== pair[1]!.name) await expect(ctx.input.page.getByRole("dialog").getByText(pair[0]!.name, { exact: true })).toHaveCount(0);
    await ctx.input.evidence("identity-subscription-human-link.json", { sourceId: pair[0]!.id, targetId: pair[1]!.id, actualReloadedSurvivorVisible: true, sourceRemoved: true });
  },
})];
