import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { rejectedModelRetryRefusal } from "./model-rejected-retry.js";

const support = await getEmbeddedPostgresTestSupport();
const REJECTED = "openrouter/paperclip-eval/unavailable";
const WORKING = "openrouter/deepseek/deepseek-v4.1-flash-1017";

describe.skipIf(!support.supported)("retrying a run whose model the provider rejected", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-model-rejected-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(input: { agentModel: string; overrideModel?: string; errorCode?: string }) {
    const [company] = await db.insert(companies).values({ name: "Model retry", issuePrefix: `M${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Morgan", adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: input.agentModel } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Website task", status: "blocked", assigneeAgentId: agent!.id,
      assigneeAdapterOverrides: input.overrideModel ? { adapterConfig: { model: input.overrideModel } } : null }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "failed", runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), nativeIssueId: issue!.id, errorCode: input.errorCode ?? "native_provider_model_rejected",
      contextSnapshot: { issueId: issue!.id },
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: REJECTED } } } }).returning();
    return { agent: agent!, issue: issue!, run: run! };
  }

  const check = (f: Awaited<ReturnType<typeof seed>>) => rejectedModelRetryRefusal(db, {
    failedRun: f.run, agent: f.agent, issue: f.issue });

  it("refuses while the agent still selects the rejected model and names the agent setting", async () => {
    const f = await seed({ agentModel: REJECTED });
    expect(await check(f)).toEqual({
      message: `The provider rejected the model "${REJECTED}", and it is still selected. Choose a supported model in Morgan's settings, then try again.`,
      details: { code: "native_provider_model_still_unavailable", setting: "agent_model", rejectedModel: REJECTED, agentId: f.agent.id, issueId: f.issue.id },
    });
  });

  it("names the task's model override when that override still selects the rejected model", async () => {
    const f = await seed({ agentModel: WORKING, overrideModel: REJECTED });
    expect((await check(f))?.details.setting).toBe("task_model_override");
  });

  it.each([
    { shape: "the agent now selects another model", agentModel: WORKING },
    { shape: "the task override selects another model", agentModel: REJECTED, overrideModel: WORKING },
    { shape: "the run failed for another reason", agentModel: REJECTED, errorCode: "adapter_failed" },
  ])("allows the retry when $shape", async ({ agentModel, overrideModel, errorCode }) => {
    expect(await check(await seed({ agentModel, overrideModel, errorCode }))).toBeNull();
  });

  it("compares the model a new run would resolve, including provider defaults", async () => {
    const f = await seed({ agentModel: "" });
    await db.update(agents).set({ adapterConfig: { provider: "acpx", acpxAgent: "grok", model: "grok-build" } }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "acpx", model: "grok-4.7" } } } }).where(eq(heartbeatRuns.id, f.run.id));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect((await rejectedModelRetryRefusal(db, { failedRun: f.run, agent: agent!, issue: f.issue }))?.details).toMatchObject({ setting: "agent_model", rejectedModel: "grok-4.7" });
  });

  it("refuses when an omitted model resolves to the provider default that was rejected", async () => {
    const f = await seed({ agentModel: "" });
    await db.update(agents).set({ adapterConfig: { provider: "acpx", acpxAgent: "claude" } }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "acpx", model: "claude-opus-5-5" } } } }).where(eq(heartbeatRuns.id, f.run.id));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect((await rejectedModelRetryRefusal(db, { failedRun: f.run, agent: agent!, issue: f.issue }))?.details.rejectedModel).toBe("claude-opus-5-5");
  });

  it("ignores another company's run with the same id shape", async () => {
    const f = await seed({ agentModel: REJECTED });
    const other = await seed({ agentModel: REJECTED });
    expect(await rejectedModelRetryRefusal(db, { failedRun: f.run, agent: other.agent, issue: other.issue })).toBeNull();
  });
});
