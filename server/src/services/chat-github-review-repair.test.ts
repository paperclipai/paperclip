import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { githubReviewCheckService } from "./chat-github-checks.js";

type QueryParameters = NonNullable<Parameters<Db["$client"]["unsafe"]>[1]>;
type CapturedQuery = { text: string; parameters: QueryParameters };
type Plan = { "Node Type"?: string; "Relation Name"?: string; "Index Name"?: string; "Actual Loops"?: number; Plans?: Plan[] };
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("GitHub stale review repair PostgreSQL behavior", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let queries: CapturedQuery[];
  const noProviderCall = vi.fn(async () => { throw new Error("Repair must not contact a provider"); });

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-review-repair-");
    const setup = createDb(temporary.connectionString, { maxConnections: 1 });
    try {
      await setup.execute(sql`create schema github_review_repair_fixture`);
      await setup.execute(sql`set search_path=github_review_repair_fixture`);
      await setup.execute(sql`create table chat_github_reviews (id uuid primary key, company_id uuid not null,
        endpoint_id uuid not null, delivery_id text not null, state text not null, assessment jsonb,
        updated_at timestamptz not null default now())`);
      await setup.execute(sql`create table chat_deliveries (id uuid primary key, endpoint_id uuid not null, normalized_event jsonb)`);
      await setup.execute(sql`create table chat_actions (id uuid primary key, company_id uuid not null,
        endpoint_id uuid not null, provider_action_id text, kind text not null, status text not null,
        payload jsonb not null, result jsonb, updated_at timestamptz not null default now())`);
      await setup.execute(sql`create unique index chat_actions_provider_action_uq
        on chat_actions(company_id, endpoint_id, provider_action_id)`);
    } finally {
      await setup.$client.end();
    }
  }, 90_000);

  beforeEach(async () => {
    queries = [];
    db = createDb(temporary.connectionString, { maxConnections: 1 });
    db.$client.options.debug = (_connection: number, text: string, parameters: QueryParameters) => {
      if (/^update "chat_github_reviews"/i.test(text)) queries.push({ text, parameters: [...parameters] });
    };
    await db.execute(sql`set search_path=github_review_repair_fixture`);
    await db.execute(sql`truncate chat_github_reviews, chat_deliveries, chat_actions`);
    noProviderCall.mockClear();
  });
  afterEach(async () => { await db?.$client.end(); });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed(overrides: Record<string, unknown> = {}) {
    const companyId = randomUUID(), endpointId = randomUUID();
    const deliveryId = "a" + randomUUID().slice(1), reviewId = randomUUID(), actionId = randomUUID();
    const providerDeliveryId = "provider-" + randomUUID();
    const values = { companyId, endpointId, deliveryId, reviewId, actionId, providerDeliveryId,
      actionCompanyId: companyId, actionEndpointId: endpointId, deliveryEndpointId: endpointId,
      actionDeliveryId: providerDeliveryId, reviewDeliveryId: deliveryId, state: "queued", assessment: null,
      kind: "github_review_check", status: "cancelled", code: "stale_head", ...overrides };
    await db.execute(sql`insert into chat_deliveries(id, endpoint_id, normalized_event)
      values (${deliveryId}::uuid, ${values.deliveryEndpointId}::uuid,
        ${JSON.stringify({ githubAutomatic: { context: { deliveryId: providerDeliveryId } } })}::jsonb)`);
    await db.execute(sql`insert into chat_actions(id, company_id, endpoint_id, kind, status, payload, result)
      values (${actionId}::uuid, ${values.actionCompanyId}::uuid, ${values.actionEndpointId}::uuid,
        ${values.kind}, ${values.status}, ${JSON.stringify({ event: { deliveryId: values.actionDeliveryId } })}::jsonb,
        ${JSON.stringify({ code: values.code })}::jsonb)`);
    await db.execute(sql`insert into chat_github_reviews(id, company_id, endpoint_id, delivery_id, state, assessment, updated_at)
      values (${reviewId}::uuid, ${companyId}::uuid, ${endpointId}::uuid, ${values.reviewDeliveryId},
        ${values.state}, ${values.assessment === null ? null : JSON.stringify(values.assessment)}::jsonb, '2000-01-01T00:00:00Z')`);
    return values;
  }

  async function retainedRows() {
    return {
      reviews: await db.$client.unsafe("select * from chat_github_reviews order by id"),
      deliveries: await db.$client.unsafe("select * from chat_deliveries order by id"),
      actions: await db.$client.unsafe("select * from chat_actions order by id"),
    };
  }

  it.each(["queued", "running"])("supersedes only the exact %s unassessed review", async state => {
    const fixture = await seed({ state });
    const before = await retainedRows();
    const service = githubReviewCheckService(db, noProviderCall);
    await service.processPending();
    const after = await retainedRows();
    expect(after.reviews).toHaveLength(1);
    expect(after.reviews[0]).toMatchObject({ id: fixture.reviewId, state: "superseded", assessment: null });
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.actions).toEqual(before.actions);
    await service.processPending();
    expect(await retainedRows()).toEqual(after);
    expect(noProviderCall).not.toHaveBeenCalled();
  });

  it.each([
    ["another action company", { actionCompanyId: randomUUID() }],
    ["another action endpoint", { actionEndpointId: randomUUID() }],
    ["another delivery endpoint", { deliveryEndpointId: randomUUID() }],
    ["another provider delivery", { actionDeliveryId: "another-delivery" }],
    ["another cancellation reason", { code: "another_reason" }],
    ["another action kind", { kind: "another_kind" }],
    ["a processed action", { status: "processed" }],
    ["an assessed review", { assessment: { retained: true } }],
    ["a completed review", { state: "completed" }],
  ])("preserves rows for %s", async (_name, overrides) => {
    await seed(overrides as Record<string, unknown>);
    const before = await retainedRows();
    await githubReviewCheckService(db, noProviderCall).processPending();
    expect(await retainedRows()).toEqual(before);
    expect(noProviderCall).not.toHaveBeenCalled();
  });

  it.each(["malformed", "uppercase", "whitespace", "braces", "unhyphenated"])("preserves %s delivery references without cast errors", async kind => {
    const fixture = await seed();
    const reference = kind === "malformed" ? "not-a-uuid" : kind === "uppercase" ? fixture.deliveryId.toUpperCase()
      : kind === "whitespace" ? ` ${fixture.deliveryId} ` : kind === "braces" ? `{${fixture.deliveryId}}`
        : fixture.deliveryId.replaceAll("-", "");
    await db.execute(sql`update chat_github_reviews set delivery_id=${reference} where id=${fixture.reviewId}::uuid`);
    const before = await retainedRows();
    await githubReviewCheckService(db, noProviderCall).processPending();
    expect(await retainedRows()).toEqual(before);
    expect(noProviderCall).not.toHaveBeenCalled();
  });

  it.each(["missing delivery", "missing provider identity"])("preserves a review with %s", async kind => {
    const fixture = await seed();
    if (kind === "missing delivery") {
      await db.execute(sql`delete from chat_deliveries where id=${fixture.deliveryId}::uuid`);
    } else {
      await db.execute(sql`update chat_deliveries set normalized_event='{}'::jsonb where id=${fixture.deliveryId}::uuid`);
    }
    const before = await retainedRows();
    await githubReviewCheckService(db, noProviderCall).processPending();
    expect(await retainedRows()).toEqual(before);
    expect(noProviderCall).not.toHaveBeenCalled();
  });

  it("repairs a late review from the retained cancellation without replaying provider work", async () => {
    const fixture = await seed();
    await db.execute(sql`delete from chat_github_reviews where id=${fixture.reviewId}::uuid`);
    const service = githubReviewCheckService(db, noProviderCall);
    await service.processPending();
    await db.execute(sql`insert into chat_github_reviews(id, company_id, endpoint_id, delivery_id, state)
      values (${fixture.reviewId}::uuid, ${fixture.companyId}::uuid, ${fixture.endpointId}::uuid, ${fixture.deliveryId}, 'queued')`);
    await service.processPending();
    const rows = await db.$client.unsafe("select state from chat_github_reviews");
    expect(rows).toEqual([{ state: "superseded" }]);
    expect(noProviderCall).not.toHaveBeenCalled();
  });

  it("resolves each candidate delivery once through its primary key with retained history", async () => {
    const companyId = randomUUID(), endpointId = randomUUID();
    const candidates = 200;
    await db.execute(sql`insert into chat_deliveries(id, endpoint_id, normalized_event)
      select gen_random_uuid(), ${endpointId}::uuid,
        jsonb_build_object('githubAutomatic', jsonb_build_object('context', jsonb_build_object('deliveryId', 'delivery-' || n)))
      from generate_series(1,8000) n`);
    await db.execute(sql`insert into chat_github_reviews(id, company_id, endpoint_id, delivery_id, state)
      select gen_random_uuid(), ${companyId}::uuid, ${endpointId}::uuid, id::text, 'queued'
      from chat_deliveries order by id limit ${candidates}`);
    await db.execute(sql`insert into chat_actions(id, company_id, endpoint_id, provider_action_id, kind, status, payload, result)
      select gen_random_uuid(), ${companyId}::uuid, ${endpointId}::uuid, 'action-' || n,
        case when n<=100 then 'github_review_check' else 'another_kind' end, 'cancelled',
        jsonb_build_object('event', jsonb_build_object('deliveryId', 'unmatched-' || n)),
        jsonb_build_object('code', 'stale_head') from generate_series(1,1100) n`);
    await db.execute(sql`analyze chat_deliveries`);
    await db.execute(sql`analyze chat_actions`);
    await db.execute(sql`analyze chat_github_reviews`);
    await db.execute(sql`set statement_timeout='5s'`);
    await githubReviewCheckService(db, noProviderCall).processPending();
    expect(queries).toHaveLength(1);
    const query = queries[0];
    const explained = await db.$client.unsafe(`explain (analyze,buffers,format json) ${query.text}`, query.parameters);
    const root = (explained[0]["QUERY PLAN"] as Array<{ Plan: Plan }>)[0].Plan;
    function flatten(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(flatten)]; }
    const deliveries = flatten(root).filter(node => node["Relation Name"] === "chat_deliveries");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]["Index Name"]).toBe("chat_deliveries_pkey");
    expect(deliveries[0]["Actual Loops"]).toBeLessThanOrEqual(candidates);
    expect((await db.$client.unsafe("select count(*)::int as count from chat_github_reviews where state='queued'"))[0].count).toBe(candidates);
    expect(noProviderCall).not.toHaveBeenCalled();
  }, 30_000);
});
