import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeState, agents, companies, createDb } from "@paperclipai/db";
import { readProviderRateLimits, type ProviderRateLimitSnapshot } from "@paperclipai/shared";
import { recordAgentProviderRateLimits, preservedAccountRuntimeState } from "../services/agent-provider-rate-limits.js";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping provider rate limit tests: ${recoveryPostgresSupport.reason}`);

function snapshot(input: Partial<ProviderRateLimitSnapshot> & { observedAt: string }): ProviderRateLimitSnapshot {
  return {
    schema: "paperclip.provider.rate_limits.v1",
    provider: "openai",
    windows: [],
    credits: null,
    limitReached: null,
    ...input,
  };
}

function notice(value: ProviderRateLimitSnapshot) {
  return {
    eventType: "provider.notice.recorded",
    payload: {
      schema: "paperclip.provider.notice.v1",
      noticeId: "codex-rate-limits:1",
      severity: "info",
      category: "provider.rate_limits",
      scope: "account",
      recoverable: true,
      userActionable: false,
      summary: "Codex rate limits",
      details: [{ name: "rateLimits", value: JSON.stringify(value) }],
    },
  };
}

const fiveHour = (usedPercent: number) => ({
  id: "codex.primary", label: "5-hour window", shortLabel: "5h", windowMinutes: 300,
  usedPercent, resetsAt: "2026-11-05T15:40:00.000Z", status: null,
});
const weekly = (usedPercent: number) => ({
  id: "codex.secondary", label: "Weekly", shortLabel: "7d", windowMinutes: 10080,
  usedPercent, resetsAt: "2026-11-09T09:00:00.000Z", status: null,
});

/** The latest provider rate-limit snapshot is kept per agent, in its own company. */
describePostgres("agent provider rate limits", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("agent-provider-rate-limits-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rate limit fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex planner", adapterType: "paperclip_runner", status: "idle", adapterConfig: {} });
    return { companyId, agentId };
  }

  async function stored(agentId: string) {
    const row = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]);
    return row ? readProviderRateLimits(row.stateJson) : null;
  }

  it("creates runtime state and merges later snapshots by window", async () => {
    const binding = await seed();
    await expect(recordAgentProviderRateLimits(db, binding, notice(snapshot({
      observedAt: "2026-11-05T15:00:00.000Z", windows: [fiveHour(70), weekly(40)],
    })))).resolves.toBe(true);
    await recordAgentProviderRateLimits(db, binding, notice(snapshot({
      observedAt: "2026-11-05T15:10:00.000Z", windows: [fiveHour(78)],
    })));
    expect((await stored(binding.agentId))?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["codex.primary", 78],
      ["codex.secondary", 40],
    ]);
  });

  it("ignores an older snapshot delivered late", async () => {
    const binding = await seed();
    await recordAgentProviderRateLimits(db, binding, notice(snapshot({ observedAt: "2026-11-05T15:10:00.000Z", windows: [fiveHour(78)] })));
    await recordAgentProviderRateLimits(db, binding, notice(snapshot({ observedAt: "2026-11-05T15:00:00.000Z", windows: [fiveHour(60)] })));
    expect((await stored(binding.agentId))?.windows[0]?.usedPercent).toBe(78);
  });

  it("does not write for another company's agent or for unrelated notices", async () => {
    const binding = await seed();
    const other = await seed();
    await expect(recordAgentProviderRateLimits(db, { companyId: other.companyId, agentId: binding.agentId }, notice(snapshot({
      observedAt: "2026-11-05T15:00:00.000Z", windows: [fiveHour(10)],
    })))).resolves.toBe(false);
    await expect(recordAgentProviderRateLimits(db, binding, {
      eventType: "provider.notice.recorded",
      payload: { schema: "paperclip.provider.notice.v1", category: "warning", details: [] },
    })).resolves.toBe(false);
    expect(await stored(binding.agentId)).toBeNull();
  });

  it("keeps the snapshot when the board resets the agent's session", async () => {
    const binding = await seed();
    await recordAgentProviderRateLimits(db, binding, notice(snapshot({ observedAt: "2026-11-05T15:00:00.000Z", windows: [fiveHour(55)] })));
    await db.update(agentRuntimeState)
      .set({ stateJson: { ...(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, binding.agentId)).then((rows) => rows[0]!.stateJson)), sessionScratch: true } })
      .where(eq(agentRuntimeState.agentId, binding.agentId));
    await heartbeatService(db).resetRuntimeSession(binding.agentId);
    const row = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, binding.agentId)).then((rows) => rows[0]!);
    expect(row.stateJson.sessionScratch).toBeUndefined();
    expect(readProviderRateLimits(row.stateJson)?.windows[0]?.usedPercent).toBe(55);
  });

  it("preserves only account keys", () => {
    expect(preservedAccountRuntimeState({ providerRateLimits: { a: 1 }, other: 2 })).toEqual({ providerRateLimits: { a: 1 } });
    expect(preservedAccountRuntimeState(null)).toEqual({});
  });
});
