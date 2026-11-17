import { and, eq, exists, gte, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { aiSubscriptions, aiSubscriptionPrices, aiSubscriptionConnections, connectionGrants, connectionGrantMembers, agents, authUsers, companyMemberships, costEvents, type Db } from "@paperclipai/db";
import { addCents, monthlySubscriptionCents, type SubscriptionCostReport, type SubscriptionPrice, type SubscriptionUsage } from "@paperclipai/shared";
import { withAccountingReadSnapshot } from "./accounting-transaction.js";
import { ordinaryInputTokens } from "./costs.js";
import { resolveCostDateRange, type CostDateRange } from "./cost-date-range.js";
import { canEditSubscription, canonicalSubscriptionId, type SubscriptionActor } from "./subscriptions.js";

export function emptySubscriptionUsage(): SubscriptionUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: "0.0000000", eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0 };
}

function addUsage(target: SubscriptionUsage, source: SubscriptionUsage) {
  target.costCents = addCents(target.costCents, source.costCents);
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "eventCount", "estimatedEventCount", "unpricedEventCount"] as const) target[key] += Number(source[key]);
}

function priceDto(price: typeof aiSubscriptionPrices.$inferSelect): SubscriptionPrice {
  return { revision: price.revision, plan: price.plan, amountCents: price.amountCents,
    monthlyCents: price.amountCents == null ? null : monthlySubscriptionCents(price.amountCents, price.cadence),
    currency: price.currency, cadence: price.cadence, status: price.status, source: price.source,
    sourceUrl: price.sourceUrl, effectiveAt: price.effectiveAt.toISOString() };
}

export async function subscriptionCostReport(db: Db, companyId: string, actor: SubscriptionActor, range?: CostDateRange): Promise<SubscriptionCostReport> {
  return withAccountingReadSnapshot(db, companyId, async tx => {
    const period = resolveCostDateRange(range);
    const conditions = [eq(costEvents.companyId, companyId)];
    if (period?.from) conditions.push(gte(costEvents.occurredAt, period.from));
    if (period?.to) conditions.push(lte(costEvents.occurredAt, period.to));
    // Company cost-read permission covers aggregate run usage, not another
    // member's private subscription fee. Billing editors retain visibility
    // after disconnection; other readers need an authorized shared audience.
    const audience = and(eq(connectionGrantMembers.companyId, companyId), eq(connectionGrantMembers.grantId, connectionGrants.id));
    const visible = or(
      sql`${actor.userId} = any(${aiSubscriptions.ownerUserIds})`,
      actor.canManage ? eq(aiSubscriptions.shared, true) : undefined,
      exists(tx.select({ id: aiSubscriptionConnections.id }).from(aiSubscriptionConnections)
        .innerJoin(connectionGrants, and(eq(connectionGrants.id, aiSubscriptionConnections.grantId), eq(connectionGrants.companyId, companyId)))
        .where(and(eq(aiSubscriptionConnections.companyId, companyId), eq(aiSubscriptionConnections.subscriptionId, aiSubscriptions.id),
          eq(connectionGrants.kind, "organization"), eq(connectionGrants.status, "active"), or(
            notExists(tx.select({ id: connectionGrantMembers.id }).from(connectionGrantMembers).where(audience)),
            exists(tx.select({ id: connectionGrantMembers.id }).from(connectionGrantMembers).where(and(audience,
              eq(connectionGrantMembers.subjectType, "user"), eq(connectionGrantMembers.subjectId, actor.userId)))),
          )))),
    );
    const visibleCurrent = and(eq(aiSubscriptions.companyId, companyId), isNull(aiSubscriptions.mergedIntoId), visible);
    const [accounts, links, prices, owners, groups] = await Promise.all([
      tx.select().from(aiSubscriptions).where(visibleCurrent),
      // Historical aliases are needed to distinguish hidden accounts from
      // truly unattributed runs. Do not load their private metadata or prices.
      tx.select({ id: aiSubscriptions.id, mergedIntoId: aiSubscriptions.mergedIntoId }).from(aiSubscriptions).where(eq(aiSubscriptions.companyId, companyId)),
      tx.select({ price: aiSubscriptionPrices }).from(aiSubscriptions).innerJoin(aiSubscriptionPrices, and(
        eq(aiSubscriptionPrices.companyId, aiSubscriptions.companyId), eq(aiSubscriptionPrices.subscriptionId, aiSubscriptions.id),
        eq(aiSubscriptionPrices.revision, aiSubscriptions.revision),
      )).where(visibleCurrent),
      tx.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).innerJoin(companyMemberships, and(
        eq(companyMemberships.principalId, authUsers.id), eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"))),
      tx.select({ subscriptionId: costEvents.subscriptionId, billingType: costEvents.billingType,
        agentId: costEvents.agentId, agentName: agents.name,
        inputTokens: sql<number>`coalesce(sum(${ordinaryInputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
        costCents: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        eventCount: sql<number>`count(*)::int`,
        estimatedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'estimated')::int`,
        unpricedEventCount: sql<number>`count(*) filter (where ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included')::int`,
      }).from(costEvents).leftJoin(agents, and(eq(agents.id, costEvents.agentId), eq(agents.companyId, companyId)))
        .where(and(...conditions)).groupBy(costEvents.subscriptionId, costEvents.billingType, costEvents.agentId, agents.name),
    ]);
    const report: SubscriptionCostReport = { canRefresh: !actor.readOnly, asOf: new Date().toISOString(), accounts: [], monthlyTotals: [],
      activeCount: 0, unknownPriceCount: 0, unidentifiedAccountCount: 0,
      api: emptySubscriptionUsage(), subscription: emptySubscriptionUsage(), unknown: emptySubscriptionUsage(), unattributedSubscription: emptySubscriptionUsage() };
    const currentPrices = new Map(prices.map(({ price }) => [price.subscriptionId, priceDto(price)]));
    const ownerNames = new Map(owners.map(owner => [owner.id, owner.name]));
    for (const account of accounts) {
      const price = currentPrices.get(account.id);
      if (!price) throw new Error("Subscription price history is incomplete");
      const ownerUserId = !account.shared && account.ownerUserIds.length === 1 ? account.ownerUserIds[0] : null;
      report.accounts.push({ id: account.id, provider: account.provider,
        name: account.ownerUserIds.length > 0 && (account.shared || !account.ownerUserIds.includes(actor.userId)) ? `${account.provider} subscription` : account.name,
        ownerUserId, ownerName: ownerNames.get(ownerUserId ?? "") ?? null, shared: account.shared,
        identityVerified: account.identityVerified, detectedPlan: account.detectedPlan,
        observedAt: account.observedAt?.toISOString() ?? null, lastCheckedAt: account.lastCheckedAt?.toISOString() ?? null,
        refreshStatus: account.refreshStatus, canEdit: canEditSubscription(account, actor), price,
        usage: emptySubscriptionUsage(), agents: [] });
      if (price.status !== "active") continue;
      report.activeCount++;
      if (!account.identityVerified) report.unidentifiedAccountCount++;
      if (price.monthlyCents == null) { report.unknownPriceCount++; continue; }
      let total = report.monthlyTotals.find(row => row.currency === price.currency);
      if (!total) report.monthlyTotals.push(total = { currency: price.currency, amountCents: "0.0000000", estimatedCount: 0 });
      total.amountCents = addCents(total.amountCents, price.monthlyCents);
      if (price.source !== "user") total.estimatedCount++;
    }
    const byId = new Map(report.accounts.map(account => [account.id, account]));
    const aliases = new Map(links.map(account => [account.id, account.mergedIntoId]));
    const canonicalIds = new Map(links.map(account => [account.id, canonicalSubscriptionId(account.id, aliases)]));
    for (const group of groups) {
      const isSubscription = group.billingType === "subscription_included" || group.billingType === "subscription_overage";
      addUsage(group.billingType === "metered_api" ? report.api : isSubscription ? report.subscription : report.unknown, group);
      if (!isSubscription) continue;
      const canonicalId = group.subscriptionId ? canonicalIds.get(group.subscriptionId) : undefined;
      const account = canonicalId ? byId.get(canonicalId) : undefined;
      if (canonicalId && !account) continue; // Known private account; not missing attribution.
      if (!account) { addUsage(report.unattributedSubscription, group); continue; }
      addUsage(account.usage, group);
      if (group.agentId && !account.agents.some(agent => agent.id === group.agentId)) account.agents.push({ id: group.agentId, name: group.agentName ?? "Agent" });
    }
    report.accounts.sort((a, b) => (a.ownerName ?? "Shared").localeCompare(b.ownerName ?? "Shared") || a.name.localeCompare(b.name));
    report.monthlyTotals.sort((a, b) => a.currency.localeCompare(b.currency));
    return report;
  });
}
