import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, agentRuntimeState, agentConfigRevisions, heartbeatRuns, companies, createDb } from "@paperclipai/db";
import { resolveAgentRunnerConfig } from "@paperclipai/adapter-utils";
import { eq } from "drizzle-orm";
import { agentService } from "../services/agents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("runner policy at the common creation boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runner-creation-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runner creation", issuePrefix: "RUN" });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  it.each([
    ["codex_local", "codex", undefined, "gpt-5.6-sol"],
    ["claude_local", "acpx", "claude", "claude-sonnet-5"],
    ["opencode_local", "opencode", undefined, "openai/gpt-5.6-sol"],
    ["grok_local", "acpx", "grok", "grok-4.7"],
    ["cursor", "acpx", "cursor", "composer-2.5"],
  ])("resolves internal %s creation before persistence", async (adapterType, provider, acpxAgent, model) => {
    const result = await agentService(db).create(companyId, { name: adapterType!, adapterType: adapterType!, adapterConfig: { model } });
    expect(result).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider, ...(acpxAgent ? { acpxAgent } : {}), model } });
    const [persisted] = await db.select().from(agents).where(eq(agents.id, result.id));
    expect(persisted.adapterType).toBe("paperclip_runner");
  });
  it("preserves explicit legacy and both saved choices on ordinary edits", async () => {
    const service = agentService(db);
    for (const runner of ["legacy", "paperclip"] as const) {
      const created = await service.create(companyId, { name: runner, adapterType: "codex_local", runner });
      const edited = await service.update(created.id, { title: "New title" });
      expect(edited?.adapterType).toBe(created.adapterType);
      expect(edited?.adapterConfig).toEqual(created.adapterConfig);
    }
  });
  it("does not turn legacy-only harnesses into native agents", async () => {
    const created = await agentService(db).create(companyId, { name: "Gemini", adapterType: "gemini_local" });
    expect(created.adapterType).toBe("gemini_local");
  });
  it("invalidates sessions on an explicit runner change while preserving recorded runs and a revision", async () => {
    const service = agentService(db);
    const created = await service.create(companyId, { name: "Switch runner", adapterType: "codex_local", runner: "legacy" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: created.id, status: "running", runtimeMode: "legacy", runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", adapterConfig: created.adapterConfig } } }).returning();
    await db.insert(agentRuntimeState).values({ companyId, agentId: created.id, adapterType: "codex_local", sessionId: "legacy-session" });
    await db.insert(agentTaskSessions).values({ companyId, agentId: created.id, adapterType: "codex_local", taskKey: "task", sessionDisplayId: "legacy-session" });
    await service.update(created.id, { title: "Unrelated edit" });
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, created.id))).toHaveLength(1);
    const selected = resolveAgentRunnerConfig({ adapterType: created.adapterType, adapterConfig: created.adapterConfig, runner: "paperclip" });
    await service.update(created.id, selected, { recordRevision: { source: "runner-change-test" } });
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, created.id))).toHaveLength(0);
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, created.id));
    expect(runtime).toMatchObject({ adapterType: "paperclip_runner", sessionId: null, stateJson: {} });
    const [recorded] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(recorded).toMatchObject({ status: "running", runtimeMode: "legacy", runnerProfileJson: run.runnerProfileJson });
    const [revision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, created.id));
    expect(revision).toMatchObject({ beforeConfig: { adapterType: "codex_local" }, afterConfig: { adapterType: "paperclip_runner" } });
  });
  it("rejects incompatible settings before inserting an agent", async () => {
    await expect(agentService(db).create(companyId, { name: "Custom", adapterType: "codex_local", adapterConfig: { command: "/custom/codex" } })).rejects.toThrow("command");
    expect(await db.select().from(agents).where(eq(agents.name, "Custom"))).toHaveLength(0);
  });
});
