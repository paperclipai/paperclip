import { and, eq, inArray, sql } from "drizzle-orm";
import { aiSubscriptions, aiSubscriptionPrices, aiSubscriptionConnections, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema, normalizeCents, subscriptionPlan, type AiProvider, type UpdateSubscriptionPrice } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity, type ActivityPublication } from "./activity-log.js";
import { publishAccountingActivities } from "./accounting-transaction.js";
import { subscriptionCredentialIdentity, subscriptionIdentityKey, type SubscriptionIdentity } from "./subscription-identity.js";

type Account = typeof aiSubscriptions.$inferSelect;
type Price = typeof aiSubscriptionPrices.$inferInsert;
export interface SubscriptionActor { userId: string; canManage: boolean; readOnly?: boolean }
export interface SubscriptionConnection {
  companyId: string; connectionId: string; grantId: string; provider: AiProvider;
  name: string; ownerUserId: string | null; credential: string;
}

export function canonicalSubscriptionId(id: string, accounts: Pick<Account, "id" | "mergedIntoId">[] | Map<string, string | null>): string {
  const map = accounts instanceof Map ? accounts : new Map(accounts.map(row => [row.id, row.mergedIntoId]));
  const seen = new Set<string>();
  while (map.get(id)) {
    if (seen.has(id)) throw new Error("Subscription link cycle");
    seen.add(id); id = map.get(id)!;
  }
  return id;
}

function detectedPrice(companyId: string, subscriptionId: string, plan: string | null, revision: number): Price {
  return { companyId, subscriptionId, revision, plan: plan ?? "Plan unknown", amountCents: null, source: "unknown" };
}

function autoPrice(account: Pick<Account, "id" | "companyId" | "provider" | "identityVerified">, plan: string | null, revision: number): Price {
  // A plan hint alone cannot prove whether two rotated credentials are one paid
  // seat. Require a stable identity before adding an automatic fee to totals.
  const catalog = account.identityVerified ? subscriptionPlan(account.provider, plan) : null;
  return { ...detectedPrice(account.companyId, account.id, plan, revision),
    ...(catalog ? { plan: catalog.name, amountCents: normalizeCents(catalog.monthlyCents), currency: catalog.currency, source: "catalog" as const, sourceUrl: catalog.sourceUrl } : {}),
  };
}

async function lock(db: Db, companyId: string) {
  // A separate, short lock; no provider requests or credential rotation under it.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('subscription_costs'), hashtext(${companyId}))`);
}

async function withSubscriptionTransaction<T>(db: Db, companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>) {
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await lock(tx, companyId);
    return work(tx, publications);
  });
  publishAccountingActivities(companyId, publications);
  return result;
}

type Ownership = Pick<Account, "ownerUserIds" | "shared">;
function combineOwnership(a: Ownership, b: Ownership): Ownership {
  return { ownerUserIds: [...new Set([...a.ownerUserIds, ...b.ownerUserIds])].sort(), shared: a.shared || b.shared };
}

export function canEditSubscription(account: Ownership, actor: SubscriptionActor) {
  return !actor.readOnly && (account.ownerUserIds.includes(actor.userId) || (account.shared && actor.canManage));
}

async function mergeInTransaction(db: Db, companyId: string, source: Account, target: Account, automatic: boolean) {
  if (source.id === target.id) throw conflict("Choose a different subscription to link");
  if (source.provider !== target.provider || source.mergedIntoId || target.mergedIntoId) throw conflict("Choose two current accounts from the same provider");
  await db.update(aiSubscriptions).set(combineOwnership(source, target)).where(and(eq(aiSubscriptions.id, target.id), eq(aiSubscriptions.companyId, companyId)));
  const prices = await db.select().from(aiSubscriptionPrices).where(and(eq(aiSubscriptionPrices.companyId, companyId), inArray(aiSubscriptionPrices.subscriptionId, [source.id, target.id])));
  const sourcePrice = prices.find(row => row.subscriptionId === source.id && row.revision === source.revision)!;
  const targetPrice = prices.find(row => row.subscriptionId === target.id && row.revision === target.revision)!;
  if (automatic && sourcePrice.source === "user") {
    if (targetPrice.source === "user" && ["amountCents", "currency", "cadence", "status"].some(key => sourcePrice[key as keyof typeof sourcePrice] !== targetPrice[key as keyof typeof targetPrice])) {
      throw conflict("These accounts have different saved prices. Link them after choosing the price to keep.");
    }
    if (targetPrice.source !== "user") {
      await db.insert(aiSubscriptionPrices).values({ ...sourcePrice, id: undefined, subscriptionId: target.id, revision: target.revision + 1, effectiveAt: new Date() });
      await db.update(aiSubscriptions).set({ revision: target.revision + 1 }).where(eq(aiSubscriptions.id, target.id));
    }
  }
  await db.update(aiSubscriptions).set({ mergedIntoId: target.id, revision: source.revision + 1 }).where(and(eq(aiSubscriptions.id, source.id), eq(aiSubscriptions.companyId, companyId)));
  // Preserve each old ID for historical run attribution. Flatten existing links.
  await db.update(aiSubscriptions).set({ mergedIntoId: target.id }).where(and(eq(aiSubscriptions.companyId, companyId), eq(aiSubscriptions.mergedIntoId, source.id)));
  await db.update(aiSubscriptionConnections).set({ subscriptionId: target.id }).where(and(eq(aiSubscriptionConnections.companyId, companyId), eq(aiSubscriptionConnections.subscriptionId, source.id)));
  return target.id;
}

export function subscriptionService(db: Db) {
  async function register(input: SubscriptionConnection, observed?: SubscriptionIdentity) {
    const identity = { ...(observed ?? subscriptionCredentialIdentity(input.companyId, input.provider, input.credential)) };
    // Only a successful provider observation may match another grant's billing
    // identity or add its editors. Provisional rows are grant-scoped, even when
    // two callers supply the same unverified credential or forged ID claims.
    if (!observed?.verified) identity.accountKey = subscriptionIdentityKey(input.companyId, input.provider, ["grant", input.grantId, identity.credentialKey]);
    if (!observed) {
      const [cached] = await db.select().from(aiSubscriptionConnections).where(and(eq(aiSubscriptionConnections.companyId, input.companyId), eq(aiSubscriptionConnections.grantId, input.grantId)));
      if (cached?.credentialKey === identity.credentialKey && cached.connectionId === input.connectionId) return cached.subscriptionId;
    }
    return withSubscriptionTransaction(db, input.companyId, async (tx, publications) => {
      // Company and grant identity are authoritative, even for internal callers.
      const [grant] = await tx.select({ grant: connectionGrants, connection: toolConnections }).from(connectionGrants)
        .innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, connectionGrants.companyId)))
        .where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, input.grantId), eq(toolConnections.id, input.connectionId)));
      const metadata = aiConnectionMetadataSchema.safeParse(grant?.connection.config.ai);
      if (!grant || grant.grant.status !== "active" || grant.connection.connectionPurpose !== "ai"
        || !grant.connection.enabled || grant.connection.status !== "active"
        || !metadata.success || metadata.data.method !== "subscription" || metadata.data.provider !== input.provider) {
        throw notFound("Subscription connection not found");
      }
      const [binding] = await tx.select().from(aiSubscriptionConnections).where(and(eq(aiSubscriptionConnections.companyId, input.companyId), eq(aiSubscriptionConnections.grantId, input.grantId)));
      const accounts = await tx.select().from(aiSubscriptions).where(eq(aiSubscriptions.companyId, input.companyId));
      if (observed && binding && binding.credentialKey !== identity.credentialKey) return canonicalSubscriptionId(binding.subscriptionId, accounts);
      // A fresh credential-local hint cannot override a verified profile binding.
      if (!observed && binding?.credentialKey === identity.credentialKey) return canonicalSubscriptionId(binding.subscriptionId, accounts);
      const known = accounts.find(row => row.provider === input.provider && row.accountKey === identity.accountKey);
      let account = known ? accounts.find(row => row.id === canonicalSubscriptionId(known.id, accounts))! : undefined;
      const previous = binding?.credentialKey === identity.credentialKey ? accounts.find(row => row.id === canonicalSubscriptionId(binding.subscriptionId, accounts)) : undefined;
      if (!account && previous && observed && !previous.identityVerified && !previous.mergedIntoId) {
        [account] = await tx.update(aiSubscriptions).set({ accountKey: identity.accountKey, identityVerified: identity.verified }).where(eq(aiSubscriptions.id, previous.id)).returning();
      }
      if (!account) {
        [account] = await tx.insert(aiSubscriptions).values({ companyId: input.companyId, provider: input.provider,
          accountKey: identity.accountKey, identityVerified: identity.verified, name: grant.connection.name,
          ownerUserIds: grant.grant.subjectUserId ? [grant.grant.subjectUserId] : [], shared: grant.grant.kind === "organization", detectedPlan: identity.plan,
        }).returning();
        await tx.insert(aiSubscriptionPrices).values(autoPrice(account, identity.plan, 0));
        await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "subscription_reporting",
          action: "subscription.discovered", entityType: "ai_subscription", entityId: account.id, details: { provider: input.provider } }, publications);
      }
      // The union is independent of discovery order. Credential sharing does
      // not transfer personal ownership, and personal reuse does not remove
      // managers' authority over a fee already connected to the company.
      const ownership = combineOwnership(account, {
        ownerUserIds: grant.grant.subjectUserId ? [grant.grant.subjectUserId] : [], shared: grant.grant.kind === "organization",
      });
      if (ownership.shared !== account.shared || ownership.ownerUserIds.join() !== account.ownerUserIds.join()) {
        [account] = await tx.update(aiSubscriptions).set(ownership).where(eq(aiSubscriptions.id, account.id)).returning();
        await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "subscription_reporting",
          action: "subscription.ownership_updated", entityType: "ai_subscription", entityId: account.id,
          details: { shared: ownership.shared, ownerCount: ownership.ownerUserIds.length } }, publications);
      }
      if (observed && previous && previous.id !== account.id && !previous.identityVerified) {
        await mergeInTransaction(tx, input.companyId, previous, account, true);
        await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "subscription_reporting",
          action: "subscription.linked", entityType: "ai_subscription", entityId: previous.id, details: { targetId: account.id, automatic: true } }, publications);
        // Merging can adopt a user price and advance the revision.
        [account] = await tx.select().from(aiSubscriptions).where(eq(aiSubscriptions.id, account.id));
      }
      if (observed) {
        if (identity.plan) {
          const [price] = await tx.select().from(aiSubscriptionPrices).where(and(eq(aiSubscriptionPrices.subscriptionId, account.id), eq(aiSubscriptionPrices.revision, account.revision)));
          const next = autoPrice(account, identity.plan, account.revision + 1);
          if (price?.source !== "user" && (price?.plan !== next.plan || price?.amountCents !== (next.amountCents ?? null) || price?.source !== next.source)) {
            account.revision++;
            await tx.insert(aiSubscriptionPrices).values(next);
          }
        }
        await tx.update(aiSubscriptions).set({ detectedPlan: identity.plan ?? account.detectedPlan, observedAt: identity.plan ? new Date() : account.observedAt,
          lastCheckedAt: new Date(), refreshStatus: identity.plan ? "ok" : "unavailable", revision: account.revision }).where(eq(aiSubscriptions.id, account.id));
      }
      await tx.insert(aiSubscriptionConnections).values({ companyId: input.companyId, connectionId: input.connectionId, grantId: input.grantId,
        credentialKey: identity.credentialKey, subscriptionId: account.id }).onConflictDoUpdate({ target: [aiSubscriptionConnections.companyId, aiSubscriptionConnections.grantId],
        set: { credentialKey: identity.credentialKey, subscriptionId: account.id } });
      return account.id;
    });
  }

  async function updatePrice(companyId: string, id: string, input: UpdateSubscriptionPrice, actor: SubscriptionActor) {
    return withSubscriptionTransaction(db, companyId, async (tx, publications) => {
      const [account] = await tx.select().from(aiSubscriptions).where(and(eq(aiSubscriptions.companyId, companyId), eq(aiSubscriptions.id, id)));
      if (!account) throw notFound("Subscription not found");
      if (!canEditSubscription(account, actor)) throw forbidden("Only subscription owners or managers of shared accounts can edit prices");
      if (account.mergedIntoId || account.revision !== input.expectedRevision) throw conflict("This subscription changed. Reload it before saving.");
      const revision = account.revision + 1;
      await tx.insert(aiSubscriptionPrices).values({ companyId, subscriptionId: id, revision, plan: input.plan,
        amountCents: input.amountCents == null ? null : normalizeCents(input.amountCents), currency: input.currency,
        cadence: input.cadence, status: input.status, source: "user" });
      await tx.update(aiSubscriptions).set({ revision }).where(eq(aiSubscriptions.id, id));
      await logActivity(tx, { companyId, actorType: "user", actorId: actor.userId, action: "subscription.price_updated",
        entityType: "ai_subscription", entityId: id, details: { revision, status: input.status } }, publications);
      return { id, revision };
    });
  }

  async function merge(companyId: string, id: string, targetId: string, expectedRevision: number, targetRevision: number, actor: SubscriptionActor) {
    return withSubscriptionTransaction(db, companyId, async (tx, publications) => {
      const rows = await tx.select().from(aiSubscriptions).where(and(eq(aiSubscriptions.companyId, companyId), inArray(aiSubscriptions.id, [id, targetId])));
      const source = rows.find(row => row.id === id), target = rows.find(row => row.id === targetId);
      if (!source || !target) throw notFound("Subscription not found");
      if (!canEditSubscription(source, actor) || !canEditSubscription(target, actor)) throw forbidden("You must be able to edit both subscriptions");
      if (source.revision !== expectedRevision || target.revision !== targetRevision) throw conflict("These subscriptions changed. Reload before linking them.");
      const result = await mergeInTransaction(tx, companyId, source, target, false);
      await logActivity(tx, { companyId, actorType: "user", actorId: actor.userId, action: "subscription.linked", entityType: "ai_subscription", entityId: id, details: { targetId } }, publications);
      return { id: result };
    });
  }
  return { register, updatePrice, merge };
}
