import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping paused-company heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeatService tickTimers", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-pause-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  it("treats paused companies as skipped timer heartbeats instead of throwing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-04-22T16:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paused Co",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-04-22T15:00:00.000Z"),
      issuePrefix: "PSD",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
      permissions: {},
      createdAt: new Date("2026-04-22T14:00:00.000Z"),
      lastHeartbeatAt: new Date("2026-04-22T14:30:00.000Z"),
    });

    await expect(heartbeat.tickTimers(now)).resolves.toEqual({
      checked: 1,
      enqueued: 0,
      skipped: 1,
    });

    const wakeupRequests = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests);

    expect(wakeupRequests).toHaveLength(1);
    expect(wakeupRequests[0]).toEqual({
      status: "skipped",
      reason: "budget.blocked",
    });
  });
});
