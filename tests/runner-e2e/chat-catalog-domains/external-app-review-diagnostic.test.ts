import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { eq }: typeof import("../../../packages/db/node_modules/drizzle-orm/index.js") =
  createRequire(new URL("../../../packages/db/package.json", import.meta.url))("drizzle-orm");
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, agents, companies, issues, heartbeatRuns, issueThreadInteractions, toolInvocations,
  toolActionRequests, toolActionDeliveries, agentWakeupRequests } from "../../../packages/db/src/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../../server/src/__tests__/helpers/embedded-postgres.js";
import { summarizeToolValue } from "../../../server/src/services/tool-content-guards.js";
import { observeReviewAdmission, readReviewAdmissionSnapshot, reviewAdmissionSummary, type ReviewAdmissionBinding } from "./external-app-review-diagnostic.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("review-admission-observer-"); db = createDb(database.connectionString); }, 30000);
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
const privateCanary = "synthetic-private-content-never-export";
async function seed(wrongSourceIssue = false): Promise<ReviewAdmissionBinding> {
  const b = Object.fromEntries(["companyId", "issueId", "agentId", "actionRequestId", "invocationId", "sourceRunId", "interactionId"].map(key => [key, randomUUID()])) as unknown as ReviewAdmissionBinding;
  await db.insert(companies).values({ id: b.companyId, name: "Read-only review observer", issuePrefix: b.companyId.slice(0, 8).toUpperCase() });
  await db.insert(agents).values({ id: b.agentId, companyId: b.companyId, name: "Observer fixture", adapterType: "paperclip_runner" });
  await db.insert(issues).values({ id: b.issueId, companyId: b.companyId, title: privateCanary, assigneeAgentId: b.agentId, status: "in_review" });
  const sourceIssueId = wrongSourceIssue ? randomUUID() : b.issueId;
  if (wrongSourceIssue) await db.insert(issues).values({ id: sourceIssueId, companyId: b.companyId, title: "Unrelated issue", assigneeAgentId: b.agentId });
  await db.insert(heartbeatRuns).values({ id: b.sourceRunId, companyId: b.companyId, agentId: b.agentId,
    issueId: sourceIssueId, status: "succeeded", runtimeMode: "native", nativePhase: "committed", contextSnapshot: { issueId: sourceIssueId, private: privateCanary } });
  await db.insert(issueThreadInteractions).values({ id: b.interactionId, companyId: b.companyId, issueId: b.issueId,
    sourceRunId: b.sourceRunId, kind: "request_confirmation", status: "accepted", payload: { version: 1, prompt: privateCanary } });
  await db.insert(toolInvocations).values({ id: b.invocationId, companyId: b.companyId, agentId: b.agentId,
    issueId: b.issueId, runId: b.sourceRunId, toolName: "controlled_write", status: "failed", errorMessage: privateCanary });
  await db.insert(toolActionRequests).values({ id: b.actionRequestId, companyId: b.companyId, issueId: b.issueId,
    interactionId: b.interactionId, invocationId: b.invocationId, requestedByAgentId: b.agentId, status: "failed",
    canonicalArgumentsHash: "a".repeat(64), canonicalArgumentsSummary: summarizeToolValue({ text: privateCanary }) });
  return b;
}

it("observes missing/queued/native-running/settled states without writing or reading unrelated ownership", async () => {
  const b = await seed(), foreign = await seed();
  await db.insert(agentWakeupRequests).values({ companyId: foreign.companyId, agentId: foreign.agentId,
    source: "automation", status: "queued", payload: { toolActionRequestIds: [b.actionRequestId], private: privateCanary } });
  expect(await readReviewAdmissionSnapshot(db, { ...b, companyId: foreign.companyId })).toEqual({ available: false, reason: "binding_mismatch" });
  expect(await readReviewAdmissionSnapshot(db, { ...b, sourceRunId: foreign.sourceRunId })).toEqual({ available: false, reason: "binding_mismatch" });
  const wrongSource = await seed(true);
  expect(await readReviewAdmissionSnapshot(db, wrongSource)).toEqual({ available: false, reason: "binding_mismatch" });
  expect(reviewAdmissionSummary(await readReviewAdmissionSnapshot(db, b))).toMatchObject({ delivery: "missing", wakes: 0, boundRuns: 0 });
  await db.insert(toolActionDeliveries).values({ actionRequestId: b.actionRequestId, companyId: b.companyId, issueId: b.issueId, interactionId: b.interactionId });
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: b.companyId, agentId: b.agentId,
    source: "automation", status: "queued", coalescedCount: 2, payload: { toolActionRequestIds: [b.actionRequestId], private: privateCanary } }).returning();
  expect(reviewAdmissionSummary(await readReviewAdmissionSnapshot(db, b))).toMatchObject({ delivery: "pending", wakes: 1, wakeStates: { queued: 1 }, coalescedWakes: 1, boundRuns: 0 });
  const [run] = await db.insert(heartbeatRuns).values({ companyId: b.companyId, agentId: b.agentId, issueId: b.issueId,
    wakeupRequestId: wake.id, status: "queued", runtimeMode: "native", contextSnapshot: { toolActionRequestIds: [b.actionRequestId], private: privateCanary } }).returning();
  await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
  expect(reviewAdmissionSummary(await readReviewAdmissionSnapshot(db, b))).toMatchObject({ boundRuns: 1, nativeRunStates: { queued: 1 } });
  await db.update(heartbeatRuns).set({ status: "running", nativePhase: "observed" }).where(eq(heartbeatRuns.id, run.id));
  expect(reviewAdmissionSummary(await readReviewAdmissionSnapshot(db, b))).toMatchObject({ nativeRunStates: { running: 1 } });
  await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed" }).where(eq(heartbeatRuns.id, run.id));
  await db.update(toolActionDeliveries).set({ deliveredAt: new Date() }).where(eq(toolActionDeliveries.actionRequestId, b.actionRequestId));
  const before = await db.select().from(toolActionDeliveries).where(eq(toolActionDeliveries.actionRequestId, b.actionRequestId));
  const snapshot = await readReviewAdmissionSnapshot(db, b);
  expect(reviewAdmissionSummary(snapshot)).toMatchObject({ delivery: "acknowledged", nativeRunStates: { succeeded: 1 } });
  expect(JSON.stringify(snapshot)).not.toContain(privateCanary);
  expect(JSON.stringify(reviewAdmissionSummary(snapshot))).not.toContain(b.companyId);
  expect(await db.select().from(toolActionDeliveries).where(eq(toolActionDeliveries.actionRequestId, b.actionRequestId))).toEqual(before);
  await db.update(agentWakeupRequests).set({ status: privateCanary }).where(eq(agentWakeupRequests.id, wake.id));
  const closed = reviewAdmissionSummary(await readReviewAdmissionSnapshot(db, b));
  expect(closed).toMatchObject({ wakeStates: { other: 1 } });
  expect(JSON.stringify(closed)).not.toContain(privateCanary);
  await db.insert(agentWakeupRequests).values(Array.from({ length: 8 }, () => ({ companyId: b.companyId, agentId: b.agentId,
    source: "automation", payload: { toolActionRequestIds: [b.actionRequestId] } })));
  const bounded = await readReviewAdmissionSnapshot(db, b);
  expect(bounded.available && bounded.wakes).toHaveLength(8);
  expect(bounded).toMatchObject({ rowLimitReached: true });
});

it("keeps absent owned configuration explicitly unavailable", async () => {
  const b = await seed();
  expect(await observeReviewAdmission(b, {})).toEqual({ available: false, reason: "owned_config_unavailable" });
});

it("uses the launcher's owned config and rejects a config outside that root", async () => {
  const b = await seed(), root = await mkdtemp(path.join(os.tmpdir(), "review-admission-config-"));
  const filename = path.join(root, "config.json");
  try {
    await writeFile(filename, JSON.stringify({ $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
      database: { mode: "postgres", connectionString: database.connectionString }, logging: { mode: "file" }, server: {}, telemetry: {} }), { mode: 0o600 });
    const snapshot = await observeReviewAdmission(b, { PAPERCLIP_CONFIG: filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: root });
    expect(snapshot).toMatchObject({ available: true, binding: b, wakes: [], runs: [] });
    expect(await observeReviewAdmission(b, { PAPERCLIP_CONFIG: filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: path.join(root, "missing") }))
      .toEqual({ available: false, reason: "observation_unavailable" });
    const sibling = await mkdtemp(path.join(os.tmpdir(), "review-admission-other-"));
    try { expect(await observeReviewAdmission(b, { PAPERCLIP_CONFIG: filename, PAPERCLIP_RUNNER_E2E_TEMP_ROOT: sibling }))
      .toEqual({ available: false, reason: "owned_config_unavailable" }); }
    finally { await rm(sibling, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
