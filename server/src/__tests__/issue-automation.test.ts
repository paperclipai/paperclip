import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll, afterEach, beforeAll } from "vitest";
import { agents, companies, createDb, issues, issueLabels, labels, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  matchAutoLabelRules,
  normalizeAutomationPolicy,
  resolveProjectAutoLabels,
} from "../services/issue-automation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue automation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("automation policy", () => {
  it("normalizes stored policies and rejects junk", () => {
    expect(normalizeAutomationPolicy(null)).toBeNull();
    expect(normalizeAutomationPolicy(undefined)).toBeNull();
    expect(normalizeAutomationPolicy({ autoLabelRules: [] })).toBeNull();
    expect(normalizeAutomationPolicy("nope")).toBeNull();
    expect(normalizeAutomationPolicy({ autoLabelRules: [{ id: "r1" }] })).toBeNull();
    expect(
      normalizeAutomationPolicy({
        autoLabelRules: [{ id: "r1", match: "outage", labelId: randomUUID() }],
      }),
    ).toEqual({
      autoLabelRules: [{ id: "r1", match: "outage", labelId: expect.any(String) }],
    });
    expect(normalizeAutomationPolicy({ autoLabelRules: new Array(26).fill({ id: "r", match: "x", labelId: randomUUID() }) })).toBeNull();
  });

  it("matches rules case-insensitively across title and description", () => {
    const rules = [
      { id: "r1", match: "Outage", labelId: "label-1" },
      { id: "r2", match: "postgres", labelId: "label-2" },
      { id: "r3", match: "  ", labelId: "label-3" },
      { id: "r4", match: "missing", labelId: "label-4" },
    ];
    expect(matchAutoLabelRules("OUTAGE in prod", null, rules).map((rule) => rule.id)).toEqual(["r1"]);
    expect(
      matchAutoLabelRules("Calm title", "the POSTGRES replica lags", rules).map((rule) => rule.id),
    ).toEqual(["r2"]);
  });
});

describeEmbeddedPostgres("resolveProjectAutoLabels", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-automation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves matched labels and skips stale label ids", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Automation",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const urgentId = randomUUID();
    await db.insert(labels).values({ id: urgentId, companyId, name: "urgent", color: "red" });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Platform",
      automationPolicy: {
        autoLabelRules: [
          { id: "r1", match: "outage", labelId: urgentId },
          { id: "r2", match: "outage", labelId: randomUUID() },
        ],
      },
    });

    const resolved = await resolveProjectAutoLabels(db, {
      companyId,
      projectId,
      title: "Outage in prod",
    });
    expect(resolved).toEqual([urgentId]);
    expect(
      await resolveProjectAutoLabels(db, { companyId, projectId: null, title: "Outage" }),
    ).toEqual([]);
    expect(
      await resolveProjectAutoLabels(db, { companyId, projectId, title: "Calm day" }),
    ).toEqual([]);
  });
});
