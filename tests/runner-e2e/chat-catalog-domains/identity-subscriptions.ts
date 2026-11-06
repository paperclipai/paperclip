import { expect } from "@playwright/test";
import type { SubscriptionAccountReport, SubscriptionCostReport } from "../../../packages/shared/src/subscriptions.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { checks, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, openStandingChat, probeAgentPermission, waitForReply } from "./identity-support.js";

/** Intentionally partial. Provider/name/owner equality does not establish that
 * two records represent ONE paid account. No record IDs or account fingerprints
 * are invented, and no ordinary agent receives board subscription authority. */
export function gradeSubscriptions(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-subscription-evidence", !!o, "Actual owned account records, provenance and saved human linking are required."); if (!o) return c.result();
  const before = o.state.beforeReport as SubscriptionCostReport | undefined; const after = o.state.afterReport as SubscriptionCostReport | undefined;
  const pair = o.state.duplicateAccounts as SubscriptionAccountReport[] | undefined;
  c.add("one-actual-account-not-two-similar-records", pair?.length === 2 && pair[0]?.id !== pair[1]?.id && pair.every(row => row.canEdit) && (pair.every(row => row.shared) || !!pair[0]?.ownerUserId && pair[0].ownerUserId === pair[1]?.ownerUserId)
    && pair[0]?.provider === pair[1]?.provider && o.state.sameAccountProvenanceVerified === true && o.state.provenanceOrigin === "genuine-owned-provider-history",
    "Both records must expose matching personal ownership or shared ownership, be editable by the actual human AND be independently proven to describe one real provider account. Matching labels, two different accounts or fabricated fingerprints cannot qualify.");
  c.add("board-only-subscription-actions", o.state.agentReadStatus === 403 && o.state.agentLinkStatus === 403 && o.state.noPreHumanMutation === true,
    "The chat cannot read board subscription details or silently merge them, and the records remain distinct until the real human decision.");
  c.add("human-link-persisted-with-target-price", !!pair && !!before && !!after && o.state.humanLinkStatus === 200 && o.state.ownershipVisible === true && o.state.linkDisclosureVisible === true
    && after.accounts.length === before.accounts.length - 1 && !after.accounts.some(row => row.id === pair[0]?.id)
    && JSON.stringify(after.accounts.find(row => row.id === pair[1]?.id)?.price) === JSON.stringify(pair[1]?.price)
    && o.activity.some(row => row.action === "subscription.linked" && row.entityId === pair[0]?.id && row.actorType === "user" && row.actorId === o.state.personId && row.details?.targetId === pair[1]?.id),
    "The actual human links the exact verified duplicate into the selected owned account; fresh report and audit retain its real existing price.");
  const priceEvents = o.state.priceHistoryBefore as Entity[] | undefined;
  c.add("historical-price-evidence-retained", !!priceEvents?.length && priceEvents.every(beforeEvent => o.activity.some(row => row.id === beforeEvent.id && row.entityId === beforeEvent.entityId && JSON.stringify(row.details) === JSON.stringify(beforeEvent.details)))
    && o.state.archivedPriceHistoryVerified === true,
    "Original price revision receipts remain unchanged AND archived historical prices require independent supported readback; a current price alone cannot prove the full history.");
  c.add("routes-human-without-fabricated-fees", /subscription/i.test(o.reply) && /owner|ownership|same account|same.*seat/i.test(o.reply) && /link|duplicate/i.test(o.reply)
    && /human|person|board|you can|open/i.test(o.reply) && !/\bI(?:'ve| have)?\s+(?:merged|linked|deduplicated)\b/i.test(o.reply)
    && !/tokens?[^.\n]{0,50}(?:means? (?:a |the )?(?:fee|subscription)|subscription costs?)/i.test(o.reply)
    && o.links.some(href => { const url = new URL(href, o.origin); return url.origin === o.origin && url.pathname.includes("/activity/costs"); }),
    "The response routes the person to actual subscription controls, explains ownership and duplicate checks, and never fabricates a fee from token usage or claims an agent merge.");
  return c.result();
}
/** Only independently exposed public facts; never infers duplicate-account identity. */
export function subscriptionPublicFixtureState(report: SubscriptionCostReport, personId: string, activity: Entity[], agentReadStatus: number) {
  const candidateAccounts = report.accounts.filter(row => row.canEdit && (row.shared || !!row.ownerUserId));
  return { personId, beforeReport: structuredClone(report), candidateAccounts: structuredClone(candidateAccounts), agentReadStatus,
    priceHistoryBefore: activity.filter(row => row.action === "subscription.price_updated" && candidateAccounts.some(account => account.id === row.entityId)).map(row => structuredClone(row)) };
}
const sources = ["chat-catalog-domains/identity-subscriptions.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/budgets-costs.yaml",
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
    sameAccountProvenanceAvailable: false, archivedPriceReadbackAvailable: false, setupBlocked: true,
    unsupportedContext: "Public reports establish editability, ownership and current price only, not same-account provider identity or archived price revisions. No genuine selected duplicate-account fixture/provenance was supplied." });
  // Candidates are not promoted to a verified duplicate pair. Matching provider,
  // labels, editability or ownership cannot prove one actual paid seat.
  throw new Error("Setup blocker: actual public subscription facts were retained, but same-account provider provenance and archived-price readback remain unavailable; no canonical request was sent");

}, gradeSubscriptions, {
  authentication: "human-session", sourceFiles: sources,
  coverageGaps: ["No supported admitted fixture establishes two subscription records with independently verified provenance for ONE actual account. Public current-price reports also omit archived price revisions; complete historical-price preservation cannot yet be independently verified. The original context remains blocked, never replaced by different accounts or a nonexistent-resource refusal."],
  async act(ctx, state) {
    await waitForReply(ctx); const pair = state.duplicateAccounts as SubscriptionAccountReport[] | undefined;
    if (!pair || pair.length !== 2 || state.sameAccountProvenanceVerified !== true || state.provenanceOrigin !== "genuine-owned-provider-history") throw new Error("Actual same-account provenance is required before any link action");
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
