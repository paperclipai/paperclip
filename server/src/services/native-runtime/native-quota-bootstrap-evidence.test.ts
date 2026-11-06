import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { lockNativeQuotaBootstrapEvidence } from "./native-quota-bootstrap-evidence.js";

describe("native quota bootstrap predecessor evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  const selection: AiConnectionRouterSelection = {
    poolId: randomUUID(), memberId: randomUUID(),
    binding: { mode: "delegated", provider: "openai", method: "api_key", connectionId: randomUUID(), grantId: randomUUID() },
    runtimeConfig: { provider: "codex", model: "gpt-5" }, notes: [],
  };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-quota-bootstrap-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Quota evidence", issuePrefix: "NQB" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
  }, 90000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture(changes: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Quota", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", status: "failed", finishedAt: new Date(), errorCode: "provider_quota",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { aiRouterTaskKey: issueId, aiRouterSelection: selection }, ...changes });
    return { companyId, agentId, issueId, runId, expectedSelection: selection };
  }
  it("accepts only an exactly bound failed quota run with a pre-provider receipt", async () => {
    const input = await fixture();
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, input))).resolves.toMatchObject({ runId: input.runId });
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, { ...input, expectedSelection: { ...selection, memberId: randomUUID() } }))).resolves.toBeNull();
  });
  it.each([
    { resultJson: {} },
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } },
    { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, startupCancellation: {} } },
    { errorCode: "provider_transport_failed" },
    { nativeSessionId: randomUUID() },
    { status: "cancelled" },
  ])("rejects unproven or stopped work: %j", async changes => {
    const input = await fixture(changes);
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, input))).resolves.toBeNull();
  });
  it("rejects an already-created successor", async () => {
    const input = await fixture();
    await db.insert(heartbeatRuns).values({ companyId, agentId, retryOfRunId: input.runId });
    await expect(db.transaction(tx => lockNativeQuotaBootstrapEvidence(tx, input))).resolves.toBeNull();
  });
});
