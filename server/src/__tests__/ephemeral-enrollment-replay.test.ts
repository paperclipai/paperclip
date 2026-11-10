import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, companySkills, companySkillVersions, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareOnlineEphemeralEnrollment } from "../services/ephemeral-enrollment.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";
import { initializeDurableAgentFiles } from "../services/agent-file-durability.js";
import { resetCloudControlReplayFenceForTests } from "../services/cloud-runtime-identity.js";

const config = vi.hoisted(() => ({ databaseUrl: "", storageProvider: "s3" }));
vi.mock("../config.js", () => ({ loadConfig: () => config }));
vi.mock("../storage/index.js", () => ({ getStorageService: () => ({ provider: "s3" }) }));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("ephemeral-enrollment-replay-");
  db = createDb(database.connectionString); config.databaseUrl = database.connectionString;
}, 90_000);
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  const stackId = `stack-fixture-${randomUUID()}`, companyId = cloudTenantPrimaryCompanyId(stackId), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Online enrollment fixture", issuePrefix: `P${randomUUID().slice(0, 7).toUpperCase()}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Preparing agent" });
  await db.transaction(tx => initializeDurableAgentFiles(tx as unknown as Db, { id: agentId, companyId }));
  vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-managed-instance");
  vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", stackId);
  vi.stubEnv("PAPERCLIP_BUILD_COMMIT", "a".repeat(40));
  vi.stubEnv("RAILWAY_DEPLOYMENT_ID", randomUUID());
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "false");
  vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
  vi.stubEnv("PAPERCLIP_SHARED_UI_ASSETS", "true");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
  vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "fixture-preserved-original-key-at-least-32");
  vi.stubEnv("PAPERCLIP_DATABASE_LISTEN_URL", database.connectionString);
  return { companyId, agentId, attemptId: randomUUID(), control: { requestId: randomUUID(), exp: Math.floor(Date.now() / 1000) + 60 } };
}

it("exports once across simultaneous callers and a cleared process replay map using the durable audit key", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([prepareOnlineEphemeralEnrollment(db, f.attemptId, f.control),
    prepareOnlineEphemeralEnrollment(db, f.attemptId, f.control)]);
  if (!results.some(result => result.status === "fulfilled")) throw new AggregateError(results.map(result => (result as PromiseRejectedResult).reason), "All preparation callers failed");
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ status: 409 });
  resetCloudControlReplayFenceForTests();
  await expect(prepareOnlineEphemeralEnrollment(db, f.attemptId, f.control)).rejects.toMatchObject({ status: 409 });
  const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(process.env.PAPERCLIP_DECISION_SIGNING_SECRET);
});

it("prepares during normal admission before skill pins are saved, while preserving installation durability", async () => {
  const f = await fixture(), skillId = randomUUID(), versionId = randomUUID();
  await db.insert(companySkills).values({ id: skillId, companyId: f.companyId, key: "overlap", slug: "overlap", name: "Overlap",
    sourceType: "managed", markdown: "# Overlap", fileInventory: [{ path: "SKILL.md", kind: "entrypoint" }] });
  await db.insert(companySkillVersions).values({ id: versionId, companyId: f.companyId, companySkillId: skillId, revisionNumber: 1,
    fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# Overlap" }] });
  await db.update(companySkills).set({ currentVersionId: versionId }).where(eq(companySkills.id, skillId));
  await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand", status: "running", contextSnapshot: {} });
  expect(await prepareOnlineEphemeralEnrollment(db, f.attemptId, f.control)).toMatchObject({ enrollmentReady: false });
  await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, skillId));
  await expect(prepareOnlineEphemeralEnrollment(db, f.attemptId, { ...f.control, requestId: randomUUID() })).rejects.toMatchObject({ status: 409,
    details: { blockers: ["skills_require_migration"] } });
});
