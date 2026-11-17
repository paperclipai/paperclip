import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { agentProviderLimitCooldown } from "./native-startup-retry.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Claude ACP wording for an exhausted weekly allowance, such as "resets Nov 10, 3pm (UTC)". */
function weeklyLimitMessage(at: Date) {
  const month = at.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hour = at.getUTCHours();
  return `ACP agent reported a terminal limit failure.\nYou've hit your weekly limit · resets ${month} ${at.getUTCDate()}, ${
    hour % 12 || 12}${hour < 12 ? "am" : "pm"} (UTC)`;
}

describe("native provider limit cooldown", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-provider-limit-cooldown-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native provider limit", issuePrefix: "NPL" });
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  /** An agent whose latest native run failed on an exhausted weekly allowance. */
  async function limitedAgent(resetAt: Date) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Limited agent ${agentId.slice(0, 8)}`,
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", agent: "claude" },
    });
    const limitedAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      runtimeMode: "native",
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      startedAt: new Date(limitedAt.getTime() - 60_000),
      finishedAt: limitedAt,
      errorCode: "native_provider_usage_limit",
      resultJson: {
        providerFailure: {
          schema: "paperclip.provider-failure.v1",
          provider: "anthropic",
          phase: "turn",
          category: "quota_exhausted",
          message: weeklyLimitMessage(resetAt),
          retryability: "requires_action",
        },
      },
    });
    return agentId;
  }

  it("holds an agent until a dated weekly-limit reset instead of the one-hour default", async () => {
    const resetAt = new Date(Math.ceil((Date.now() + 20 * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const agentId = await limitedAgent(resetAt);
    expect(await agentProviderLimitCooldown(db, { companyId, agentId, now: new Date() }))
      .toMatchObject({ resetAt, resetReported: true, category: "quota_exhausted" });
  });

  it("re-checks a dated reset days away within one day", async () => {
    const agentId = await limitedAgent(new Date(Math.ceil((Date.now() + 3 * DAY_MS) / HOUR_MS) * HOUR_MS));
    const now = new Date();
    const cooldown = await agentProviderLimitCooldown(db, { companyId, agentId, now });
    expect(cooldown).toMatchObject({ resetReported: true });
    expect(cooldown!.resetAt.getTime()).toBe(now.getTime() + DAY_MS);
  });
});
