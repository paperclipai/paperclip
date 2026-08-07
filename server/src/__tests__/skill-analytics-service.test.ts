import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySkillUsageEvents,
  companySkills,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  aggregateSkillUsageRows,
  skillAnalyticsService,
  type SkillUsageWindowInput,
} from "../services/skill-analytics.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres skill analytics service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(date: string, hour = 12) {
  const base = new Date(date);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour));
}

describeEmbeddedPostgres("skillAnalyticsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-analytics-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkillUsageEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates daily buckets and top-agent totals without DB access", () => {
    const rows = [
      {
        date: "2026-01-01",
        eventKind: "loaded" as const,
        count: 2,
        agentId: "agent-a",
        agentName: "Agent A",
        lastUsedAt: "2026-01-01T13:00:00.000Z",
      },
      {
        date: "2026-01-01",
        eventKind: "invoked" as const,
        count: 1,
        agentId: "agent-a",
        agentName: "Agent A",
        lastUsedAt: "2026-01-01T14:00:00.000Z",
      },
      {
        date: "2026-01-02",
        eventKind: "loaded" as const,
        count: 1,
        agentId: "agent-b",
        agentName: "Agent B",
        lastUsedAt: "2026-01-02T09:00:00.000Z",
      },
      {
        date: "2026-01-02",
        eventKind: "invoked" as const,
        count: 3,
        agentId: "agent-b",
        agentName: "Agent B",
        lastUsedAt: "2026-01-02T10:00:00.000Z",
      },
    ];

    const aggregated = aggregateSkillUsageRows(rows);

    expect(aggregated).toMatchObject({
      totals: {
        loadCount: 3,
        invocationCount: 4,
      },
      daily: [
        { date: "2026-01-01", loadCount: 2, invocationCount: 1 },
        { date: "2026-01-02", loadCount: 1, invocationCount: 3 },
      ],
      topAgents: [
        {
          agentId: "agent-b",
          agentName: "Agent B",
          totals: {
            loadCount: 1,
            invocationCount: 3,
          },
        },
        {
          agentId: "agent-a",
          agentName: "Agent A",
          totals: {
            loadCount: 2,
            invocationCount: 1,
          },
        },
      ],
      lastUsedAt: new Date("2026-01-02T10:00:00.000Z"),
    });
  });

  it("returns ranked top-used skills for a company", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const skillA = randomUUID();
    const skillB = randomUUID();

    const makeRun = () => randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentA,
        companyId,
        name: "Agent A",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentB,
        companyId,
        name: "Agent B",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(companySkills).values([
      {
        id: skillA,
        companyId,
        key: `company/${companyId}/skill-a`,
        slug: "skill-a",
        name: "Skill A",
        description: null,
        markdown: "# Skill A",
        sourceType: "local_path",
        sourceLocator: "/tmp/skill-a",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {},
      },
      {
        id: skillB,
        companyId,
        key: `company/${companyId}/skill-b`,
        slug: "skill-b",
        name: "Skill B",
        description: null,
        markdown: "# Skill B",
        sourceType: "local_path",
        sourceLocator: "/tmp/skill-b",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {},
      },
    ]);

    const runRows = [
      {
        id: makeRun(),
        companyId,
        agentId: agentA,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-10"),
      },
      {
        id: makeRun(),
        companyId,
        agentId: agentB,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-15"),
      },
      {
        id: makeRun(),
        companyId,
        agentId: agentA,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-20"),
      },
      {
        id: makeRun(),
        companyId,
        agentId: agentB,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-21"),
      },
    ];

    await db.insert(heartbeatRuns).values(runRows);

    await db.insert(companySkillUsageEvents).values([
      {
        companyId,
        skillKey: `company/${companyId}/skill-a`,
        skillId: skillA,
        skillVersionId: null,
        agentId: agentA,
        runId: runRows[0]!.id,
        issueId: null,
        adapter: "codex_local",
        eventKind: "loaded",
        createdAt: utcDay("2026-01-10", 10),
      },
      {
        companyId,
        skillKey: `company/${companyId}/skill-a`,
        skillId: skillA,
        skillVersionId: null,
        agentId: agentA,
        runId: runRows[1]!.id,
        issueId: null,
        adapter: "codex_local",
        eventKind: "invoked",
        createdAt: utcDay("2026-01-15", 11),
      },
      {
        companyId,
        skillKey: `company/${companyId}/skill-a`,
        skillId: skillA,
        skillVersionId: null,
        agentId: agentB,
        runId: runRows[2]!.id,
        issueId: null,
        adapter: "codex_local",
        eventKind: "invoked",
        createdAt: utcDay("2026-01-20", 12),
      },
      {
        companyId,
        skillKey: `company/${companyId}/skill-b`,
        skillId: skillB,
        skillVersionId: null,
        agentId: agentB,
        runId: runRows[3]!.id,
        issueId: null,
        adapter: "codex_local",
        eventKind: "loaded",
        createdAt: utcDay("2026-01-21", 13),
      },
      {
        companyId,
        skillKey: `company/${companyId}/skill-b`,
        skillId: skillB,
        skillVersionId: null,
        agentId: agentB,
        runId: runRows[3]!.id,
        issueId: null,
        adapter: "codex_local",
        eventKind: "loaded",
        createdAt: utcDay("2026-01-21", 14),
      },
      {
        companyId,
        skillKey: `company/${companyId}/skill-b`,
        skillId: skillB,
        skillVersionId: null,
        agentId: agentA,
        runId: runRows[2]!.id,
        issueId: null,
        adapter: "codex_local",
        eventKind: "invoked",
        createdAt: utcDay("2026-01-20", 15),
      },
    ]);

    const svc = skillAnalyticsService(db);
    const args: SkillUsageWindowInput = {
      window: "30d",
      since: utcDay("2026-01-01"),
      until: utcDay("2026-01-31", 20),
      limit: 10,
      metric: "loaded",
    };

    const topByLoad = await svc.topUsedSkills(companyId, args);
    expect(topByLoad.map((item) => item.skillKey)).toEqual([
      `company/${companyId}/skill-b`,
      `company/${companyId}/skill-a`,
    ]);
    expect(topByLoad[0]).toMatchObject({
      skillId: skillB,
      skillKey: `company/${companyId}/skill-b`,
      uses: 2,
      invocations: 1,
      uniqueAgents: 2,
    });

    const topByInvoke = await svc.topUsedSkills(companyId, {
      ...args,
      metric: "invoked",
    });
    expect(topByInvoke.map((item) => item.skillKey)).toEqual([
      `company/${companyId}/skill-a`,
      `company/${companyId}/skill-b`,
    ]);
    expect(topByInvoke[0]).toMatchObject({
      skillId: skillA,
      skillKey: `company/${companyId}/skill-a`,
      uses: 1,
      invocations: 2,
      uniqueAgents: 2,
    });
  });

  it("returns usage detail with daily totals and top agents", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const skillId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentA,
        companyId,
        name: "Agent A",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentB,
        companyId,
        name: "Agent B",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/analytics-detail`,
      slug: "analytics-detail",
      name: "Analytics Detail",
      description: null,
      markdown: "# Analytics Detail",
      sourceType: "local_path",
      sourceLocator: "/tmp/analytics-detail",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: {},
    });

    const runA = randomUUID();
    const runB = randomUUID();
    const runC = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: runA,
        companyId,
        agentId: agentA,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-20"),
      },
      {
        id: runB,
        companyId,
        agentId: agentA,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-21"),
      },
      {
        id: runC,
        companyId,
        agentId: agentB,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: utcDay("2026-01-21", 13),
      },
    ]);

    await db.insert(companySkillUsageEvents).values([
      {
        companyId,
        skillKey: `company/${companyId}/analytics-detail`,
        skillId,
        skillVersionId: null,
        agentId: agentA,
        runId: runA,
        issueId: null,
        adapter: "codex_local",
        eventKind: "loaded",
        createdAt: utcDay("2026-01-20", 9),
      },
      {
        companyId,
        skillKey: `company/${companyId}/analytics-detail`,
        skillId,
        skillVersionId: null,
        agentId: agentA,
        runId: runA,
        issueId: null,
        adapter: "codex_local",
        eventKind: "invoked",
        createdAt: utcDay("2026-01-20", 10),
      },
      {
        companyId,
        skillKey: `company/${companyId}/analytics-detail`,
        skillId,
        skillVersionId: null,
        agentId: agentB,
        runId: runB,
        issueId: null,
        adapter: "codex_local",
        eventKind: "loaded",
        createdAt: utcDay("2026-01-21", 8),
      },
      {
        companyId,
        skillKey: `company/${companyId}/analytics-detail`,
        skillId,
        skillVersionId: null,
        agentId: agentB,
        runId: runC,
        issueId: null,
        adapter: "codex_local",
        eventKind: "invoked",
        createdAt: utcDay("2026-01-21", 13),
      },
    ]);

    const svc = skillAnalyticsService(db);
    const detail = await svc.skillUsageDetail(companyId, skillId, {
      window: "30d",
      since: utcDay("2026-01-01"),
      until: utcDay("2026-01-31", 20),
    });

    expect(detail).toMatchObject({
      skillId,
      skillKey: `company/${companyId}/analytics-detail`,
      totals: { loadCount: 2, invocationCount: 2 },
      daily: [
        { date: "2026-01-20", loadCount: 1, invocationCount: 1 },
        { date: "2026-01-21", loadCount: 1, invocationCount: 1 },
      ],
      topAgents: [
        { agentId: agentB, totals: { loadCount: 1, invocationCount: 1 } },
        { agentId: agentA, totals: { loadCount: 1, invocationCount: 1 } },
      ],
      lastUsedAt: utcDay("2026-01-21", 13),
    });

  });
});
