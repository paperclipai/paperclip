import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatActions, chatGitHubReviews, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { idleWorkSnapshot } from "../../task-admission.js";
import { registerGitHubReviewCheckWork } from "./review-check-work.js";

const support = await getEmbeddedPostgresTestSupport();

// Staging (2026-11-15) polled 84 GitHub review checks whose runs had not
// started. Their check status reads ran at about 3/s at idle.
const CHECKS = 30;

describe.skipIf(!support.supported)("GitHub review check sweep", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  const dispatched: string[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-review-check-work-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; dispatched.length = 0;
    vi.useRealTimers();
    expect(errors.splice(0)).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed() {
    const client = db.$client;
    const [{ company }] = await client.unsafe(`insert into companies (name, issue_prefix) values ('Checks', $1) returning id as company`,
      [`C${randomUUID().slice(0, 7)}`]);
    const [{ agent }] = await client.unsafe(`insert into agents (company_id, name) values ($1, 'Reviewer') returning id as agent`, [company]);
    const [{ application }] = await client.unsafe(`insert into tool_applications (company_id, application_key, name, type)
      values ($1, 'github', 'GitHub', 'chat') returning id as application`, [company]);
    const [{ connection }] = await client.unsafe(`insert into tool_connections (company_id, application_id, name, uid, transport, connection_purpose)
      values ($1, $2, 'GitHub', $3, 'chat_sdk', 'channel') returning id as connection`, [company, application, `github-${company}`]);
    const [{ endpoint }] = await client.unsafe(`insert into chat_endpoints (company_id, connection_id, provider, public_id, assigned_agent_id, status)
      values ($1, $2, 'github', $3, $4, 'active') returning id as endpoint`, [company, connection, `checks-${company}`, agent]);
    await client.unsafe(`insert into chat_github_configurations (endpoint_id, company_id, configuration, updated_by_user_id)
      values ($1, $2, $3::jsonb, 'owner')`, [endpoint, company, JSON.stringify({ toolsEnabled: true, defaults: {}, repositories: {} })]);
    await client.unsafe(`insert into chat_endpoint_resources (company_id, endpoint_id, type, provider_resource_id, label, availability, enabled, metadata)
      values ($1, $2, 'repository', 'paperclipai/paperclip', 'paperclipai/paperclip', 'available', true, $3::jsonb)`,
    [company, endpoint, JSON.stringify({ providerRepositoryId: "418" })]);
    const checks: Array<{ id: string; number: number; headSha: string }> = [];
    const retryAt = new Date(Date.now() + 3_600_000).toISOString();
    for (let number = 1; number <= CHECKS; number++) {
      const headSha = randomUUID().replaceAll("-", "").padEnd(40, "0");
      const [action] = await db.insert(chatActions).values({ companyId: company, endpointId: endpoint, kind: "github_review_check",
        providerActionId: `github_review_check:${number}`, status: "received",
        payload: { admitted: true, runtimeGeneration: 0, event: { repository: "paperclipai/paperclip", repositoryId: "418",
          pullNumber: number, headSha, deliveryId: randomUUID() } },
        result: { state: "queued", retryAt } }).returning();
      checks.push({ id: action!.id, number, headSha });
    }
    return { companyId: company as string, agentId: agent as string, endpointId: endpoint as string, checks };
  }

  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    await registerGitHubReviewCheckWork(db, coordinator, async id => { dispatched.push(id); }, () => true).ready;
  }
  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, until - Date.now())); await delay(1);
      while (idleWorkSnapshot().active > 0) await delay(5);
    }
  }
  async function hint(scope: Record<string, unknown>) {
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubReviewChecks, JSON.stringify(scope));
    });
  }
  async function observe(work: () => Promise<unknown>) {
    const statements: string[] = [], prior = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try { await work(); } finally { db.$client.options.debug = prior; }
    return {
      statements: statements.filter(query => /"chat_actions"|chat_github_reviews|heartbeat_runs|chat_deliveries/.test(query)).length,
      // The first read of the check status of one check.
      states: statements.filter(query => /from "chat_endpoints" inner join "companies"/.test(query)).length,
    };
  }

  it("does not recompute the status of every waiting check on each company rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    await start(); await advance(5_000);
    const rebuilds = await observe(async () => {
      for (let pass = 0; pass < 4; pass++) { await hint({ companyId: f.companyId }); await advance(31_000); }
    });
    console.info(`review check sweep: 4 company rebuilds cost ${rebuilds.statements} statements `
      + `(${rebuilds.states} check status reads) for ${CHECKS} waiting checks`);
    expect(rebuilds.states).toBe(0);
    expect(rebuilds.statements).toBeLessThanOrEqual(4);
    expect(dispatched).toEqual([]);
  }, 300_000);

  it("still publishes a check promptly when its review run starts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    await start(); await advance(5_000);
    const target = f.checks[4]!;
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      contextSnapshot: {} }).returning();
    const [{ issue }] = await db.$client.unsafe(`insert into issues (company_id, title, status) values ($1, 'Review', 'in_progress')
      returning id as issue`, [f.companyId]);
    await db.insert(chatGitHubReviews).values({ companyId: f.companyId, endpointId: f.endpointId, issueId: issue,
      runId: run!.id, repositoryId: "418", repository: "paperclipai/paperclip", pullNumber: target.number,
      headSha: target.headSha, state: "running", deliveryId: randomUUID(), configurationRevision: 1,
      policySnapshot: {}, event: {} } as typeof chatGitHubReviews.$inferInsert);
    // A run lifecycle change sends a hint for its task.
    await hint({ companyId: f.companyId, issueId: issue });
    await advance(5_000);
    // The stand-in dispatch saves nothing, so the check stays due; only it is due.
    expect(new Set(dispatched)).toEqual(new Set([target.id]));
    // A later company-wide rebuild, which does not read the status, keeps the
    // changed check due instead of moving it to its saved poll deadline.
    dispatched.length = 0;
    await hint({ companyId: f.companyId });
    await advance(5_000);
    expect(new Set(dispatched)).toEqual(new Set([target.id]));
  }, 300_000);
});
