import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { createDb, companies, agents, heartbeatRuns, costEvents, activityLog, aiSubscriptions, aiSubscriptionPrices, aiSubscriptionConnections, toolApplications, toolConnections, connectionGrants, connectionGrantMembers } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { monthlySubscriptionCents, subscriptionPlan, subscriptionPriceSchema } from "@paperclipai/shared";
import { subscriptionService, type SubscriptionConnection } from "../services/subscriptions.js";
import { subscriptionCostReport } from "../services/subscription-report.js";
import { refreshSubscriptionConnection } from "../services/subscription-refresh.js";
import { subscriptionCredentialIdentity, probeSubscriptionIdentity } from "../services/subscription-identity.js";
import { costService } from "../services/costs.js";
import { toolAccessService } from "../services/tool-access.js";
import * as liveEvents from "../services/live-events.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const owner = { userId: "alice", canManage: false };
const other = { userId: "bob", canManage: true };
const jwt = (body: unknown) => `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.signature`;
const token = (workspace = "workspace", seat = "alice", plan = "plus", generation = "1") => JSON.stringify({ tokens: {
  account_id: workspace, access_token: jwt({ sub: seat, generation,
    "https://api.openai.com/auth": { chatgpt_account_id: workspace, chatgpt_user_id: seat } }),
  id_token: jwt({ sub: seat, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_user_id: seat } }),
} });
const fixtureRequest = (body: unknown) => vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
const usage = (plan = "plus") => ({ plan_type: plan, rate_limit: { primary_window: { used_percent: 1, reset_at: 1800000000, limit_window_seconds: 18000 } } });
async function verifiedConnection(input: SubscriptionConnection) {
  const observed = await probeSubscriptionIdentity(input.companyId, input.provider, input.credential, fixtureRequest(usage()));
  return subscriptionService(db).register(input, observed);
}

beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-subscriptions-"); db = createDb(database.connectionString); }, 90000);
afterAll(async () => { await database?.cleanup(); });

async function company() {
  const id = randomUUID();
  await db.insert(companies).values({ id, name: "Subscription fixture", issuePrefix: `S${id.replaceAll("-", "").slice(0, 7).toUpperCase()}` });
  return id;
}
async function connection(companyId: string, credential = token(), provider: SubscriptionConnection["provider"] = "openai", userId: string | null = "alice") {
  const applicationId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID();
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "custom" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "My subscription", uid: connectionId,
    connectionPurpose: "ai", transport: "runtime_auth", status: "active", enabled: true, config: { ai: { provider, method: "subscription" } } });
  await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: userId ? "user" : "organization", subjectUserId: userId });
  return { companyId, connectionId, grantId, credential, provider, name: "My subscription", ownerUserId: userId };
}
async function price(companyId: string, id: string, amountCents: string | null = "10000", extra: Record<string, unknown> = {}, actor = owner) {
  const [account] = await db.select().from(aiSubscriptions).where(eq(aiSubscriptions.id, id));
  return subscriptionService(db).updatePrice(companyId, id, { expectedRevision: account.revision, plan: "My plan", amountCents, currency: "USD", cadence: "month", status: "active", ...extra }, actor);
}
async function event(companyId: string, subscriptionId: string | null, billingType: "metered_api" | "subscription_included" | "subscription_overage" | "unknown", amount = "0", occurredAt = new Date("2026-10-08T00:00:00Z")) {
  const agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "codex_local" });
  await db.insert(costEvents).values({ companyId, agentId, subscriptionId, provider: "openai", biller: "openai", billingType, model: "fixture",
    costCents: Number(amount), inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, receiptHash: "normalized", occurredAt });
  return agentId;
}

describe("subscription identity and price rules", () => {
  it("requires provider authentication, a seat and a workspace, and never persists a credential or email", async () => {
    const observed = (companyId: string, credential: string) => probeSubscriptionIdentity(companyId, "openai", credential, fixtureRequest(usage()));
    const a = await observed("company", token());
    expect(a.verified).toBe(true);
    expect(a.accountKey).toBe((await observed("company", token("workspace", "alice", "plus", "2"))).accountKey);
    expect(a.accountKey).not.toBe((await observed("company", token("workspace", "bob"))).accountKey);
    expect(a.accountKey).not.toBe((await observed("other-company", token())).accountKey);
    expect(JSON.stringify(a)).not.toMatch(/workspace|alice|access-1|signature/);
    expect(subscriptionCredentialIdentity("company", "openai", token()).verified).toBe(false);
    expect(subscriptionCredentialIdentity("company", "openai", '{"tokens":{"account_id":"workspace"}}').verified).toBe(false);
    await expect(probeSubscriptionIdentity("company", "openai", token(), async () => new Response(null, { status: 401 }))).rejects.toThrow();
    const opaque = JSON.parse(token()); opaque.tokens.access_token = "opaque-bearer";
    expect((await observed("company", JSON.stringify(opaque))).verified).toBe(false);
    const wrongWorkspace = JSON.parse(token()); wrongWorkspace.tokens.account_id = "another-workspace";
    expect((await observed("company", JSON.stringify(wrongWorkspace))).verified).toBe(false);
  });
  it("keeps ambiguous tiers unknown and uses exact monthly equivalents", () => {
    expect(subscriptionPlan("openai", "pro")).toBeNull();
    expect(subscriptionPlan("anthropic", "max")).toBeNull();
    expect(subscriptionPlan("openai", "business")).toBeNull();
    expect(subscriptionPlan("openai", "unrecognized")).toBeNull();
    expect(monthlySubscriptionCents("20000", "year")).toBe("1666.6666667");
    expect(monthlySubscriptionCents("1", "year")).toBe("0.0833333");
    expect(monthlySubscriptionCents("0", "month")).toBe("0.0000000");
    expect(subscriptionPriceSchema.safeParse({ expectedRevision: 0, plan: "Max", amountCents: "-1", currency: "USD", cadence: "month", status: "active" }).success).toBe(false);
  });
  it("uses a Claude account and organization profile, never infers a Max tier from token usage", async () => {
    const request = fixtureRequest({ account: { uuid: "person" }, organization: { uuid: "org", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } });
    const observed = await probeSubscriptionIdentity("company", "anthropic", "selected-secret", request);
    expect(observed.plan).toBe("max_20x");
    expect(observed.verified).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("selected-secret");
    expect(request).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/profile", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer selected-secret" }) }));
    await expect(probeSubscriptionIdentity("company", "anthropic", "selected-secret", fixtureRequest({}))).rejects.toThrow();
  });
});

describe("durable subscription reporting", () => {
  it("can replay the migration and retains fees after connection deletion", async () => {
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0322_reflective_kree.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
    const c = await company(), input = await connection(c);
    await verifiedConnection(input);
    await db.delete(connectionGrants).where(eq(connectionGrants.id, input.grantId));
    await db.delete(toolConnections).where(eq(toolConnections.id, input.connectionId));
    expect(await db.select().from(aiSubscriptionConnections).where(eq(aiSubscriptionConnections.companyId, c))).toHaveLength(0);
    expect((await subscriptionCostReport(db, c, owner)).monthlyTotals[0].amountCents).toBe("2000.0000000");
    await db.delete(toolApplications).where(eq(toolApplications.companyId, c));
    await db.delete(activityLog).where(eq(activityLog.companyId, c));
    await db.delete(companies).where(eq(companies.id, c));
    expect(await db.select().from(aiSubscriptions).where(eq(aiSubscriptions.companyId, c))).toHaveLength(0);
    expect(await db.select().from(aiSubscriptionPrices).where(eq(aiSubscriptionPrices.companyId, c))).toHaveLength(0);
  });
  it("rejects a different provider, revoked grant, or foreign company before discovery", async () => {
    const c = await company(), input = await connection(c), service = subscriptionService(db);
    await expect(service.register({ ...input, provider: "anthropic" })).rejects.toMatchObject({ status: 404 });
    await expect(service.register({ ...input, companyId: await company() })).rejects.toMatchObject({ status: 404 });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, input.grantId));
    await expect(service.register(input)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(aiSubscriptions).where(eq(aiSubscriptions.companyId, c))).toHaveLength(0);
  });
  it.each([401, 200])("cannot acquire another owner's billing rights with forged ID claims (provider status %s)", async (status) => {
    const c = await company(), service = subscriptionService(db);
    const victim = await verifiedConnection(await connection(c));
    const forged = JSON.parse(token("workspace", "attacker"));
    forged.tokens.id_token = JSON.parse(token()).tokens.id_token;
    const attacker = await connection(c, JSON.stringify(forged), "openai", "bob");
    const provisional = await service.register(attacker);
    expect(provisional).not.toBe(victim);
    await expect(price(c, victim, "0", { status: "excluded" }, other)).rejects.toMatchObject({ status: 403 });
    await refreshSubscriptionConnection(db, attacker, provisional, status === 200 ? fixtureRequest(usage()) : async () => new Response(null, { status }));
    await expect(price(c, victim, "0", { status: "excluded" }, other)).rejects.toMatchObject({ status: 403 });
    const report = await subscriptionCostReport(db, c, other);
    expect(report.accounts.find(row => row.id === victim)).toBeUndefined();
    const [account] = await db.select().from(aiSubscriptions).where(eq(aiSubscriptions.id, victim));
    expect(account.ownerUserIds).toEqual(["alice"]);
  });
  it("keeps unverified credentials grant-scoped even when two members submit identical bytes", async () => {
    const c = await company(), service = subscriptionService(db);
    const personal = await connection(c, "unverified", "anthropic");
    const id = await service.register(personal);
    await price(c, id, "10000");
    const otherId = await service.register(await connection(c, "unverified", "anthropic", "bob"));
    expect(otherId).not.toBe(id);
    await expect(price(c, id, "0", { status: "excluded" }, other)).rejects.toMatchObject({ status: 403 });
    expect(await service.register(personal)).toBe(id);
  });
  it("requires fresh provider proof before an identical credential grants a new personal editor", async () => {
    const c = await company(), service = subscriptionService(db);
    const id = await verifiedConnection(await connection(c));
    const second = await connection(c, token(), "openai", "bob");
    const provisional = await service.register(second);
    expect(provisional).not.toBe(id);
    await refreshSubscriptionConnection(db, second, provisional, async () => new Response(null, { status: 401 }));
    await expect(price(c, id, "0", { status: "excluded" }, other)).rejects.toMatchObject({ status: 403 });
    await db.update(aiSubscriptions).set({ lastCheckedAt: new Date(0) }).where(eq(aiSubscriptions.id, provisional));
    await refreshSubscriptionConnection(db, second, provisional, fixtureRequest(usage()));
    await price(c, id, "1900", {}, other);
    await price(c, id, "1800", {}, owner);
    const report = await subscriptionCostReport(db, c, other);
    expect(report.accounts).toHaveLength(1);
    expect(report.monthlyTotals[0].amountCents).toBe("1800.0000000");
  });
  it("deduplicates concurrent connections and rotations, while separating seats and companies", async () => {
    const c = await company(), service = subscriptionService(db);
    const a = await connection(c), b = await connection(c, token("workspace", "alice", "plus", "rotated"));
    const [first, second] = await Promise.all([verifiedConnection(a), verifiedConnection(b)]);
    expect(first).toBe(second);
    expect(await verifiedConnection(await connection(c, token("workspace", "bob"), "openai", "bob"))).not.toBe(first);
    expect(await verifiedConnection(await connection(await company()))).not.toBe(first);
    const report = await subscriptionCostReport(db, c, owner, { allTime: true });
    expect(report.activeCount).toBe(1);
    expect(report.monthlyTotals).toEqual([{ currency: "USD", amountCents: "2000.0000000", estimatedCount: 1 }]);
    expect((await subscriptionCostReport(db, c, other)).activeCount).toBe(1);
    expect(report.accounts.find(row => row.id === second)?.price.revision).toBe(0);
  });
  it("does not multiply automatic fees when a plan has no stable account identity", async () => {
    const c = await company(), service = subscriptionService(db);
    const credential = JSON.parse(token());
    delete credential.tokens.account_id;
    for (const generation of ["first", "rotated"]) {
      credential.tokens.access_token = generation;
      await service.register(await connection(c, JSON.stringify(credential)));
    }
    const report = await subscriptionCostReport(db, c, owner);
    expect(report.monthlyTotals).toEqual([]);
    expect(report.unknownPriceCount).toBe(2);
    expect(report.unidentifiedAccountCount).toBe(2);
    expect(report.accounts.every(account => account.detectedPlan === "plus")).toBe(true);
  });
  it("keeps fixed fees through zero-use periods and disconnection; preserves price history and currency", async () => {
    const c = await company(), input = await connection(c), service = subscriptionService(db);
    const id = await service.register(input);
    await price(c, id, "20000", { cadence: "year", currency: "EUR" });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, input.grantId));
    const report = await subscriptionCostReport(db, c, owner, { from: new Date("2020-01-01"), to: new Date("2020-01-07") });
    expect(report.monthlyTotals).toEqual([{ currency: "EUR", amountCents: "1666.6666667", estimatedCount: 0 }]);
    expect(await db.select().from(aiSubscriptionPrices).where(eq(aiSubscriptionPrices.subscriptionId, id))).toHaveLength(2);
    expect(report.accounts[0]).not.toHaveProperty("history");
    expect(report.accounts[0].usage.eventCount).toBe(0);
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, c)))).toHaveLength(0);
    const [state] = await db.select().from(companies).where(eq(companies.id, c));
    expect(state.spentMonthlyCents).toBe(0);
    await price(c, id, "20000", { status: "ended" });
    expect((await subscriptionCostReport(db, c, owner)).activeCount).toBe(0);
  });
  it("deduplicates profile observations, preserves manual prices, and reuses promoted credentials", async () => {
    const c = await company(), service = subscriptionService(db);
    const first = await connection(c, "claude-first", "anthropic");
    const second = await connection(c, "claude-second", "anthropic");
    const firstId = await service.register(first), secondId = await service.register(second);
    await price(c, secondId, "9500");
    await event(c, firstId, "subscription_included"); await event(c, secondId, "subscription_included");
    const profile = fixtureRequest({ account: { uuid: "seat" }, organization: { uuid: "workspace", organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" } });
    await refreshSubscriptionConnection(db, first, firstId, profile);
    await refreshSubscriptionConnection(db, second, secondId, profile);
    const third = await connection(c, "claude-second", "anthropic"), thirdId = await service.register(third);
    expect(thirdId).not.toBe(firstId);
    await refreshSubscriptionConnection(db, third, thirdId, profile);
    expect(await service.register(third)).toBe(firstId);
    const report = await subscriptionCostReport(db, c, owner, { allTime: true });
    expect(report.accounts).toHaveLength(1);
    expect(report.monthlyTotals).toEqual([{ currency: "USD", amountCents: "9500.0000000", estimatedCount: 0 }]);
    expect(report.accounts[0]).toMatchObject({ identityVerified: true, usage: { eventCount: 2 }, price: { source: "user" } });
  });
  it("records detected plan changes without rewriting earlier prices or treating an unknown tier as zero", async () => {
    const c = await company(), input = await connection(c), id = await verifiedConnection(input);
    await db.update(aiSubscriptions).set({ lastCheckedAt: new Date(0) }).where(eq(aiSubscriptions.id, id));
    await refreshSubscriptionConnection(db, input, id, fixtureRequest(usage("pro")));
    const report = await subscriptionCostReport(db, c, owner);
    expect((await db.select().from(aiSubscriptionPrices).where(eq(aiSubscriptionPrices.subscriptionId, id)).orderBy(aiSubscriptionPrices.revision)).map(price => price.amountCents)).toEqual(["2000.0000000", null]);
    expect(report.monthlyTotals).toEqual([]);
    expect(report.unknownPriceCount).toBe(1);
    const observedAt = report.accounts[0].observedAt;
    await db.update(aiSubscriptions).set({ lastCheckedAt: new Date(0) }).where(eq(aiSubscriptions.id, id));
    await refreshSubscriptionConnection(db, input, id, fixtureRequest({ ...usage(), plan_type: null }));
    const after = (await subscriptionCostReport(db, c, owner)).accounts[0];
    expect(after.observedAt).toBe(observedAt);
    expect(after.detectedPlan).toBe("pro");
    expect(await db.select().from(aiSubscriptionPrices).where(eq(aiSubscriptionPrices.subscriptionId, id))).toHaveLength(2);
    expect(after.refreshStatus).toBe("unavailable");
  });
  it("keeps shared subscription permissions and currencies separate", async () => {
    const c = await company(), service = subscriptionService(db);
    await verifiedConnection(await connection(c));
    const shared = await service.register(await connection(c, token("shared"), "openai", null));
    await expect(price(c, shared)).rejects.toMatchObject({ status: 403 });
    await price(c, shared, "2100", { currency: "EUR" }, other);
    const report = await subscriptionCostReport(db, c, owner);
    expect(report.monthlyTotals).toEqual([
      { currency: "EUR", amountCents: "2100.0000000", estimatedCount: 0 },
      { currency: "USD", amountCents: "2000.0000000", estimatedCount: 1 },
    ]);
  });
  it.each([true, false])("preserves personal and shared editors regardless of discovery order (shared first: %s)", async (sharedFirst) => {
    const c = await company(), service = subscriptionService(db);
    const personal = await connection(c), shared = await connection(c, token(), "openai", null);
    const first = await verifiedConnection(sharedFirst ? shared : personal);
    expect(await verifiedConnection(sharedFirst ? personal : shared)).toBe(first);
    await price(c, first, "1900", {}, owner);
    await price(c, first, "1800", {}, other);
    for (const actor of [owner, other]) {
      const report = await subscriptionCostReport(db, c, actor);
      expect(report.accounts).toHaveLength(1);
      expect(report.accounts[0]).toMatchObject({ canEdit: true, ownerUserId: null });
      expect(report.monthlyTotals[0].amountCents).toBe("1800.0000000");
    }
    await expect(price(c, first, "1700", {}, { ...other, canManage: false })).rejects.toMatchObject({ status: 403 });
    await expect(price(c, first, "1700", {}, { ...owner, readOnly: true })).rejects.toMatchObject({ status: 403 });
    // Removing authentication connections must not remove the ability to end
    // a fee that can still be billed by the provider.
    await db.delete(connectionGrants).where(eq(connectionGrants.companyId, c));
    await price(c, first, "1700", {}, owner);
    await price(c, first, "1700", { status: "ended" }, other);
    expect((await subscriptionCostReport(db, c, owner)).activeCount).toBe(0);
  });
  it.each([true, false])("combines editors when verified profiles link accounts (shared first: %s)", async (sharedFirst) => {
    const c = await company(), service = subscriptionService(db);
    const personal = await connection(c, "claude-personal", "anthropic");
    const shared = await connection(c, "claude-shared", "anthropic", null);
    const personalId = await service.register(personal), sharedId = await service.register(shared);
    const profile = fixtureRequest({ account: { uuid: "seat" }, organization: { uuid: "org", rate_limit_tier: "default_claude_max_5x" } });
    const order = sharedFirst ? [[shared, sharedId], [personal, personalId]] as const : [[personal, personalId], [shared, sharedId]] as const;
    for (const [input, id] of order) await refreshSubscriptionConnection(db, input, id, profile);
    const report = await subscriptionCostReport(db, c, owner);
    expect(report.accounts).toHaveLength(1);
    const id = report.accounts[0].id;
    await price(c, id, "9500", {}, owner);
    await price(c, id, "9000", {}, other);
    expect((await subscriptionCostReport(db, c, other)).accounts[0].canEdit).toBe(true);
    expect((await subscriptionCostReport(db, c, owner)).monthlyTotals[0].amountCents).toBe("9000.0000000");
  });
  it("retains every personal owner without granting managers access to a personal-only fee", async () => {
    const c = await company(), service = subscriptionService(db);
    const id = await verifiedConnection(await connection(c));
    expect(await verifiedConnection(await connection(c, token(), "openai", "carol"))).toBe(id);
    await price(c, id, "1800", {}, { userId: "carol", canManage: false });
    await price(c, id, "1900", {}, owner);
    await expect(price(c, id, "2000", {}, other)).rejects.toMatchObject({ status: 403 });
    expect((await subscriptionCostReport(db, c, other)).accounts).toEqual([]);
    expect((await subscriptionCostReport(db, c, owner)).accounts[0]).toMatchObject({ canEdit: true, shared: false, ownerUserId: null });
  });
  it.each([false, true])("keeps another member's personal fees private from cost readers (manager: %s)", async (canManage) => {
    const c = await company(), input = await connection(c), id = await verifiedConnection(input);
    await price(c, id, "1234", { plan: "Private negotiated plan" });
    await event(c, id, "subscription_included");
    const hidden = await subscriptionCostReport(db, c, { userId: "bob", canManage }, { allTime: true });
    expect(hidden.accounts).toEqual([]);
    expect(hidden.monthlyTotals).toEqual([]);
    expect(hidden.activeCount).toBe(0);
    expect(hidden.unknownPriceCount).toBe(0);
    expect(hidden.subscription.eventCount).toBe(1);
    expect(hidden.unattributedSubscription.eventCount).toBe(0);
    expect(JSON.stringify(hidden)).not.toMatch(/Private negotiated plan|alice|1234/);
    const visible = await subscriptionCostReport(db, c, { ...owner, readOnly: true });
    expect(visible.accounts[0]).toMatchObject({ id, canEdit: false, price: { amountCents: "1234.0000000" } });
  });
  it("respects shared connection audiences while retaining managers' access after disconnection", async () => {
    const c = await company(), input = await connection(c, token(), "openai", null), id = await verifiedConnection(input);
    await db.insert(connectionGrantMembers).values({ companyId: c, grantId: input.grantId, subjectType: "user", subjectId: "bob" });
    expect((await subscriptionCostReport(db, c, owner)).accounts).toEqual([]);
    expect((await subscriptionCostReport(db, c, { ...other, canManage: false })).accounts[0]).toMatchObject({ id, shared: true, canEdit: false });
    expect((await subscriptionCostReport(db, c, { ...owner, canManage: true })).accounts[0]).toMatchObject({ id, canEdit: true });
    await db.delete(connectionGrants).where(eq(connectionGrants.id, input.grantId));
    expect((await subscriptionCostReport(db, c, { ...other, canManage: false })).accounts).toEqual([]);
    expect((await subscriptionCostReport(db, c, { ...owner, canManage: true })).accounts[0].id).toBe(id);
  });
  it.each([false, true])("revokes shared fee visibility through the public revoke service (restricted audience: %s)", async (restricted) => {
    const c = await company(), input = await connection(c, token(), "openai", null), id = await verifiedConnection(input);
    expect(await verifiedConnection(await connection(c))).toBe(id);
    if (restricted) await db.insert(connectionGrantMembers).values({ companyId: c, grantId: input.grantId, subjectType: "user", subjectId: "bob" });
    await event(c, id, "subscription_included");
    const reader = { userId: "bob", canManage: false };
    expect((await subscriptionCostReport(db, c, reader, { allTime: true })).accounts[0]).toMatchObject({ id, usage: { eventCount: 1 } });

    await toolAccessService(db).revokeConnectionGrant(input.connectionId, input.grantId, { actorType: "user", actorId: "alice" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, input.grantId));
    expect(grant.status).toBe("revoked");
    expect(await db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, input.grantId))).toHaveLength(restricted ? 1 : 0);
    const hidden = await subscriptionCostReport(db, c, reader, { allTime: true });
    expect(hidden.accounts).toEqual([]);
    expect(hidden.monthlyTotals).toEqual([]);
    expect(hidden.activeCount).toBe(0);
    expect(hidden.subscription.eventCount).toBe(1);
    expect(hidden.unattributedSubscription.eventCount).toBe(0);
    expect(JSON.stringify(hidden)).not.toContain(id);
    for (const editor of [owner, { userId: "carol", canManage: true }]) {
      const report = await subscriptionCostReport(db, c, editor);
      expect(report.accounts[0]).toMatchObject({ id, canEdit: true });
      expect(report.monthlyTotals[0].amountCents).toBe("2000.0000000");
    }

    // A different active shared grant can independently authorize the reader.
    expect(await verifiedConnection(await connection(c, token(), "openai", null))).toBe(id);
    expect((await subscriptionCostReport(db, c, reader)).accounts[0].id).toBe(id);
  });
  it("keeps private linked-account usage out of details without calling it unattributed", async () => {
    const c = await company(), service = subscriptionService(db);
    const a = await service.register(await connection(c, "private-a", "anthropic"));
    const b = await service.register(await connection(c, "private-b", "anthropic"));
    await event(c, a, "subscription_included"); await event(c, b, "subscription_included");
    await event(c, null, "subscription_included");
    await service.merge(c, a, b, 0, 0, owner);
    const hidden = await subscriptionCostReport(db, c, other, { allTime: true });
    expect(hidden.accounts).toEqual([]);
    expect(hidden.subscription.eventCount).toBe(3);
    expect(hidden.unattributedSubscription.eventCount).toBe(1);
    expect(JSON.stringify(hidden)).not.toContain(a);
    expect(JSON.stringify(hidden)).not.toContain(b);
  });
  it("reports only current prices while preserving accumulated revisions for auditing", async () => {
    const c = await company(), service = subscriptionService(db);
    const id = await service.register(await connection(c));
    await db.insert(aiSubscriptionPrices).values(Array.from({ length: 500 }, (_, i) => ({
      companyId: c, subscriptionId: id, revision: i + 1, plan: `Historic plan ${i}`, amountCents: "1000", source: "user" as const,
    })));
    await db.update(aiSubscriptions).set({ revision: 500 }).where(eq(aiSubscriptions.id, id));
    const report = await subscriptionCostReport(db, c, owner);
    expect(report.accounts[0].price).toMatchObject({ revision: 500, plan: "Historic plan 499" });
    expect(report.accounts[0]).not.toHaveProperty("history");
    expect(JSON.stringify(report)).not.toContain("Historic plan 498");
    expect(await db.select().from(aiSubscriptionPrices).where(eq(aiSubscriptionPrices.subscriptionId, id))).toHaveLength(501);
  });
  it("never lets an admin overwrite another user's personal price or cross a company boundary", async () => {
    const c = await company(), id = await subscriptionService(db).register(await connection(c));
    await expect(price(c, id, "10000", {}, other)).rejects.toMatchObject({ status: 403 });
    await expect(price(await company(), id)).rejects.toMatchObject({ status: 404 });
    await expect(price(c, id, "10000", {}, { ...owner, readOnly: true })).rejects.toMatchObject({ status: 403 });
    const input = { expectedRevision: 0, plan: "Plus", amountCents: "1234", currency: "USD" as const, cadence: "month" as const, status: "active" as const };
    const results = await Promise.allSettled([subscriptionService(db).updatePrice(c, id, input, owner), subscriptionService(db).updatePrice(c, id, { ...input, amountCents: "5678" }, owner)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("commits the price and audit record even if live notification fails", async () => {
    const c = await company(), id = await subscriptionService(db).register(await connection(c));
    const publish = vi.spyOn(liveEvents, "publishLiveEvent").mockImplementationOnce(() => { throw new Error("fixture subscriber unavailable"); });
    try {
      await expect(price(c, id, "1900")).resolves.toMatchObject({ revision: 1 });
      expect((await subscriptionCostReport(db, c, owner)).accounts[0].price.amountCents).toBe("1900.0000000");
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, c), eq(activityLog.action, "subscription.price_updated")))).toHaveLength(1);
    } finally { publish.mockRestore(); }
  });
  it("merges duplicate usage once and retains the selected price", async () => {
    const c = await company(), service = subscriptionService(db);
    const a = await service.register(await connection(c, "claude-token-a", "anthropic"));
    const b = await service.register(await connection(c, "claude-token-b", "anthropic"));
    await price(c, a, "10000"); await price(c, b, "20000");
    await event(c, a, "subscription_included"); await event(c, b, "subscription_overage", "200");
    await service.merge(c, a, b, 1, 1, owner);
    const report = await subscriptionCostReport(db, c, owner, { allTime: true });
    expect(report.activeCount).toBe(1);
    expect(report.monthlyTotals[0].amountCents).toBe("20000.0000000");
    expect(report.accounts[0].usage).toMatchObject({ eventCount: 2, inputTokens: 200, cachedInputTokens: 80, outputTokens: 20, costCents: "200.0000000" });
    expect(report.accounts[0].agents).toHaveLength(2);
    await expect(service.merge(c, b, a, 1, 2, owner)).rejects.toMatchObject({ status: 409 });
    const different = await service.register(await connection(c));
    await expect(service.merge(c, b, different, 1, 0, owner)).rejects.toMatchObject({ status: 409 });
  });
  it("separates API, subscriptions, overages and unknown usage with exclusive cache counters", async () => {
    const c = await company(), id = await verifiedConnection(await connection(c));
    await event(c, null, "metered_api", "123"); await event(c, id, "subscription_included");
    await event(c, id, "subscription_overage", "456"); await event(c, null, "unknown", "789");
    await event(c, null, "subscription_included"); await event(c, id, "subscription_included", "0", new Date("2026-09-01"));
    const report = await subscriptionCostReport(db, c, owner, { from: new Date("2026-10-01"), to: new Date("2026-11-01") });
    expect(report.api.costCents).toBe("123.0000000");
    expect(report.subscription.costCents).toBe("456.0000000");
    expect(report.subscription.inputTokens + report.subscription.cachedInputTokens + report.subscription.outputTokens).toBe(450);
    expect(report.unknown.costCents).toBe("789.0000000");
    expect(report.unattributedSubscription.eventCount).toBe(1);
    expect(report.accounts[0].usage.eventCount).toBe(2);
    expect(report.monthlyTotals[0].amountCents).toBe("2000.0000000");
  });
  it("snapshots account attribution, rejects forged attribution, and preserves receipt replay", async () => {
    const c = await company(), input = await connection(c), service = subscriptionService(db);
    const original = await service.register(input);
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: c, name: "Codie", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: c, agentId, invocationSource: "on_demand", status: "succeeded", contextSnapshot: { aiConnection: { subscriptionId: original, provider: "openai" } } });
    const replacement = await service.register({ ...input, credential: token("other-workspace") });
    expect(replacement).not.toBe(original);
    const receipt = { agentId, heartbeatRunId: runId, idempotencyKey: "subscription-test", provider: "openai", billingType: "subscription_included" as const, model: "fixture", inputTokens: 10, costCents: "0", occurredAt: new Date() };
    const saved = await costService(db).createEvent(c, { ...receipt, subscriptionId: replacement });
    expect(saved.subscriptionId).toBe(original);
    expect((await costService(db).createEvent(c, receipt)).id).toBe(saved.id);
    const report = await subscriptionCostReport(db, c, owner, { allTime: true });
    expect(report.accounts.find(row => row.id === original)?.usage.eventCount).toBe(1);
    expect(report.accounts.find(row => row.id === replacement)?.usage.eventCount).toBe(0);
    // Legacy or foreign context must not make a valid receipt fail or leak an account.
    const foreign = await service.register(await connection(await company()));
    for (const subscriptionId of ["malformed-legacy-id", foreign]) {
      await db.update(heartbeatRuns).set({ contextSnapshot: { aiConnection: { subscriptionId, provider: "openai" } } }).where(eq(heartbeatRuns.id, runId));
      const unlinked = await costService(db).createEvent(c, { ...receipt, idempotencyKey: subscriptionId });
      expect(unlinked.subscriptionId).toBeNull();
    }
  });
  it("preserves successful observations and manual prices through provider failures", async () => {
    const c = await company(), input = await connection(c), service = subscriptionService(db), id = await service.register(input);
    const request = fixtureRequest(usage());
    await Promise.all([refreshSubscriptionConnection(db, input, id, request), refreshSubscriptionConnection(db, input, id, request)]);
    expect(request).toHaveBeenCalledTimes(1);
    await refreshSubscriptionConnection(db, input, id, request);
    expect(request).toHaveBeenCalledTimes(1);
    await price(c, id, "1750");
    await db.update(aiSubscriptions).set({ lastCheckedAt: new Date(0) }).where(eq(aiSubscriptions.id, id));
    await refreshSubscriptionConnection(db, input, id, vi.fn<typeof fetch>().mockRejectedValue(new Error("SECRET raw provider failure")));
    const report = await subscriptionCostReport(db, c, owner);
    expect(report.accounts[0]).toMatchObject({ detectedPlan: "plus", refreshStatus: "unavailable", price: { amountCents: "1750.0000000" } });
    expect(report.accounts[0].observedAt).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain("SECRET");
    await db.update(aiSubscriptions).set({ lastCheckedAt: new Date(0) }).where(eq(aiSubscriptions.id, id));
    await refreshSubscriptionConnection(db, input, id, fixtureRequest(usage("pro")));
    expect((await subscriptionCostReport(db, c, owner)).accounts[0].price.amountCents).toBe("1750.0000000");
  });
  it("ignores a delayed provider observation after reconnecting another account", async () => {
    const c = await company(), input = await connection(c), service = subscriptionService(db), id = await service.register(input);
    let finish!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const request = vi.fn<typeof fetch>().mockImplementation(() => { started(); return new Promise<Response>(resolve => { finish = resolve; }); });
    const pending = refreshSubscriptionConnection(db, input, id, request);
    await ready;
    const next = await service.register({ ...input, credential: token("new-workspace") });
    finish(Response.json(usage("pro"))); await pending;
    const [binding] = await db.select().from(aiSubscriptionConnections).where(and(eq(aiSubscriptionConnections.companyId, c), eq(aiSubscriptionConnections.grantId, input.grantId)));
    expect(binding.subscriptionId).toBe(next);
    expect((await db.select().from(aiSubscriptions).where(eq(aiSubscriptions.id, next)))[0].detectedPlan).toBe("plus");
  });
});
