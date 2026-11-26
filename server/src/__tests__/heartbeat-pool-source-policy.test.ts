import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { harnessPoolService } from "../services/harness-pools.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: ReturnType<typeof createIsolatedTestHome>;
let connection: Awaited<ReturnType<ReturnType<typeof aiConnectionService>["save"]>>;
const companyId = randomUUID();
const userId = randomUUID();

beforeAll(async () => {
  home = createIsolatedTestHome();
  temporary = await startEmbeddedPostgresTestDatabase("heartbeat-pool-source-policy-");
  db = createDb(temporary.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Pool policy dispatch", issuePrefix: "PPD" });
  await db.insert(authUsers).values({ id: userId, name: "Pool owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
  connection = await aiConnectionService(db).save(companyId, userId, { provider: "anthropic", method: "api_key", ownership: "personal", name: "Claude", apiKey: "fixture", agentIds: [], allAgents: true }, randomUUID());
  await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
}, 90000);

afterAll(async () => {
  await db?.$client.end();
  await temporary?.cleanup();
  home?.cleanup();
});

it.each([
  { name: "CLI sandbox restriction", memberConfig: { engine: "cli", dangerouslySkipPermissions: false } },
  { name: "ACP deny-all policy", memberConfig: { engine: "acp", permissionMode: "deny-all" } },
] as const)("keeps the native Claude sandbox when a Legacy pool member offers $name", async ({ memberConfig }) => {
  await dispatch(memberConfig, { provider: "acpx", acpxAgent: "claude" });
}, 90000);

it("still refuses a selected member that conflicts with the saved native source policy", async () => {
  await dispatch({ engine: "cli", dangerouslySkipPermissions: true }, { provider: "acpx", acpxAgent: "claude", dangerouslySkipPermissions: false });
}, 90000);

it.each(["cli", "acp"] as const)("keeps Legacy Claude %s outside a native Codex task sandbox", async engine => {
  await dispatch({ engine }, { provider: "codex" });
}, 90000);

async function dispatch(memberConfig: { engine: "cli" | "acp"; dangerouslySkipPermissions?: boolean; permissionMode?: "deny-all" }, sourcePolicy: Record<string, unknown>) {
  const pool = await harnessPoolService(db).save(companyId, { config: {
    schemaVersion: 2, kind: "harness_pool", name: randomUUID(), enabled: true, mode: "failover", members: [{
      id: randomUUID(), runner: "legacy", harness: { type: "claude_code" }, adapterConfig: memberConfig,
      connection: { mode: "delegated", provider: "anthropic", method: "api_key", ...connection }, model: "claude-sonnet-5",
    }],
  } }, userId);
  const [agent] = await db.insert(agents).values({ companyId, name: "Native source", adapterType: "paperclip_runner",
    adapterConfig: { provider: "codex", cwd: home.home, ...sourcePolicy }, runtimeConfig: { harnessPool: { poolId: pool.id }, heartbeat: { enabled: false } } }).returning();
  const [issue] = await db.insert(issues).values({ companyId, title: "Dispatch restricted pool member", status: "todo", assigneeAgentId: agent.id, responsibleUserId: userId, createdByUserId: userId }).returning();
  const execute = vi.fn(async () => { throw new Error("pool policy fixture reached provider dispatch"); });
  registerServerAdapter({ ...getServerAdapter("claude_local"), execute });
  const heartbeat = heartbeatService(db, { runtimeEnv: {} });
  try {
    const run = await heartbeat.wakeup(agent.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue.id },
      contextSnapshot: { issueId: issue.id, responsibleUserId: userId }, triggerDetail: "system" });
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 30000 }).toBe("failed");
    const settled = await heartbeat.getRun(run!.id);
    expect(execute).not.toHaveBeenCalled();
    expect(settled?.error).toMatch(/policy|permissions|preserve/i);
  } finally {
    await heartbeat.drainActiveRunExecutions();
    unregisterServerAdapter("claude_local");
  }
}
