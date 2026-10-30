import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  closeRegisteredClients,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createSentryRunLinkResolver } from "../sentry-run-links.js";

const testDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = testDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

it.skipIf(!support.supported)("resolves saved task links and rejects foreign company, agent, and task identities", async () => {
  const tempDb = testDatabaseUrl ? null : await startEmbeddedPostgresTestDatabase("paperclip-sentry-links-");
  const databaseUrl = testDatabaseUrl ?? tempDb!.connectionString;
  const db = createDb(databaseUrl);
  const companyIds: string[] = [];
  try {
    if (testDatabaseUrl) await applyPendingMigrations(testDatabaseUrl);
    const companyPrefix = `T${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const taskIdentifier = `${companyPrefix}-42`;
    const [company] = await db.insert(companies).values({ name: "Fixture", issuePrefix: companyPrefix }).returning();
    const companyId = company!.id;
    companyIds.push(companyId);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Fixture", role: "engineer", adapterType: "codex_local",
    }).returning();
    const agentId = agent!.id;
    const [task] = await db.insert(issues).values({ companyId, title: "Fixture task", identifier: taskIdentifier }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", status: "failed", issueId: task!.id,
    }).returning();
    const resolve = createSentryRunLinkResolver(db);
    expect(await resolve({ runId: run!.id, companyId, agentId })).toMatchObject({
      companyId, agentId, companyPrefix, taskId: task!.id, taskIdentifier,
    });
    expect(await resolve({ runId: run!.id, companyId: randomUUID() })).toBeNull();
    expect(await resolve({ runId: run!.id, agentId: randomUUID() })).toBeNull();
    const otherPrefix = `O${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: otherPrefix }).returning();
    companyIds.push(other!.id);
    const [otherTask] = await db.insert(issues).values({
      companyId: other!.id, title: "Other task", identifier: `${otherPrefix}-1`,
    }).returning();
    const [taskless] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", status: "failed",
    }).returning();
    expect(await resolve({ runId: taskless!.id })).toMatchObject({ taskId: null, taskIdentifier: null });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: otherTask!.id } }).where(eq(heartbeatRuns.id, taskless!.id));
    expect(await resolve({ runId: taskless!.id })).toMatchObject({ taskId: null, taskIdentifier: null });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: task!.id } }).where(eq(heartbeatRuns.id, taskless!.id));
    expect(await resolve({ runId: taskless!.id })).toMatchObject({ taskId: task!.id, taskIdentifier });
  } finally {
    try {
      if (testDatabaseUrl && companyIds.length) {
        await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, companyIds));
        await db.delete(issues).where(inArray(issues.companyId, companyIds));
        await db.delete(agents).where(inArray(agents.companyId, companyIds));
        await db.delete(companies).where(inArray(companies.id, companyIds));
      }
    } finally {
      if (testDatabaseUrl) await closeRegisteredClients(testDatabaseUrl);
      await tempDb?.cleanup();
    }
  }
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
