import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  projects,
  rt2V33DailyWikiPages,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  analyzeWikiPageConsistency,
  createRt2WikiLintScheduler,
  rt2WikiLintService,
  type WikiPageWithDbFields,
} from "../services/rt2-wiki-lint.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 wiki lint tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function wikiPage(input: Partial<WikiPageWithDbFields>): WikiPageWithDbFields {
  return {
    id: input.id ?? randomUUID(),
    pageKey: input.pageKey ?? "daily/2026-04-28.md",
    companyId: input.companyId ?? randomUUID(),
    projectId: input.projectId ?? randomUUID(),
    userId: input.userId ?? "board-user",
    reportDate: input.reportDate ?? "2026-04-28",
    shortSummary: input.shortSummary ?? [],
    markdown: input.markdown ?? "",
    history: input.history ?? [],
    sourceEventIds: input.sourceEventIds ?? [],
    createdAt: input.createdAt ?? new Date("2026-04-28T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? new Date("2026-04-28T00:00:00.000Z"),
  };
}

describe("rt2 wiki lint pure checks", () => {
  it("detects evidence-rich semantic contradictions without a database", () => {
    const issue = analyzeWikiPageConsistency(
      wikiPage({
        pageKey: "daily/2026-04-28.md",
        reportDate: "2026-04-28",
        shortSummary: ["Billing migration failed and ACME customer onboarding is blocked."],
        markdown: "ACME onboarding billing migration is blocked after failed validation.",
      }),
      wikiPage({
        pageKey: "daily/2026-04-27.md",
        reportDate: "2026-04-27",
        shortSummary: ["Billing migration completed successfully for ACME customer onboarding."],
        markdown: "ACME onboarding billing migration is complete and approved.",
      }),
    );

    expect(issue).toEqual(
      expect.objectContaining({
        issueType: "embedding_consistency",
        pageKey: "daily/2026-04-28.md",
        relatedPageKey: "daily/2026-04-27.md",
        evidence: expect.arrayContaining([
          expect.objectContaining({ snippet: expect.stringContaining("failed") }),
          expect.objectContaining({ snippet: expect.stringContaining("completed") }),
        ]),
      }),
    );
  });

  it("does not run the scheduler before the nightly window", () => {
    const scheduler = createRt2WikiLintScheduler({} as never, {
      nightlyRunHour: 2,
      now: () => new Date(2026, 3, 28, 1, 59, 0),
      service: {
        lintWikiPages: vi.fn(),
        getWikiQualityScore: vi.fn(),
      },
    });

    expect(scheduler.shouldRun()).toBe(false);
    scheduler.stop();
  });
});

describeEmbeddedPostgres("rt2 wiki lint", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-wiki-lint-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33DailyWikiPages);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Wiki Lint Corp",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Wiki Lint Project",
      status: "in_progress",
    });

    return { companyId, projectId };
  }

  it("flags embedding consistency issues with evidence without mutating wiki pages", async () => {
    const { companyId, projectId } = await seedProject();

    await db.insert(rt2V33DailyWikiPages).values([
      {
        companyId,
        projectId,
        userId: "board-user",
        reportDate: "2026-04-27",
        pageKey: "daily/2026-04-27.md",
        shortSummary: ["Billing migration completed successfully for ACME customer onboarding."],
        markdown: "ACME onboarding billing migration is complete and approved.",
        history: [],
      },
      {
        companyId,
        projectId,
        userId: "board-user",
        reportDate: "2026-04-28",
        pageKey: "daily/2026-04-28.md",
        shortSummary: ["Billing migration failed and ACME customer onboarding is blocked."],
        markdown: "ACME onboarding billing migration is blocked after failed validation.",
        history: [],
      },
    ]);

    const before = await db.select().from(rt2V33DailyWikiPages);
    const result = await rt2WikiLintService(db).lintWikiPages(companyId, projectId);
    const after = await db.select().from(rt2V33DailyWikiPages);

    expect(after).toEqual(before);
    expect(result.semanticComparisons).toBe(1);
    expect(result.summary.embeddingConsistency).toBe(1);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueType: "embedding_consistency",
          severity: "warning",
          pageKey: "daily/2026-04-28.md",
          relatedPageKey: "daily/2026-04-27.md",
          evidence: expect.arrayContaining([
            expect.objectContaining({
              pageKey: "daily/2026-04-28.md",
              snippet: expect.stringContaining("failed"),
            }),
            expect.objectContaining({
              pageKey: "daily/2026-04-27.md",
              snippet: expect.stringContaining("completed"),
            }),
          ]),
        }),
      ]),
    );
  });

  it("runs scheduled lint once per nightly window and prevents overlap", async () => {
    const { companyId, projectId } = await seedProject();
    await db.insert(rt2V33DailyWikiPages).values({
      companyId,
      projectId,
      userId: "board-user",
      reportDate: "2026-04-28",
      pageKey: "daily/2026-04-28.md",
      shortSummary: ["One page only."],
      markdown: "One page only.",
      history: [],
    });

    const lintWikiPages = vi.fn(async () => ({
      companyId,
      projectId,
      checkedPages: 1,
      semanticComparisons: 0,
      issues: [],
      summary: {
        empty: 0,
        tooShort: 0,
        missingSummary: 0,
        noActivity: 0,
        stale: 0,
        embeddingConsistency: 0,
      },
    }));
    const scheduler = createRt2WikiLintScheduler(db, {
      now: () => new Date(2026, 3, 28, 2, 0, 0),
      service: {
        lintWikiPages,
        getWikiQualityScore: vi.fn(),
      },
    });

    expect(scheduler.shouldRun()).toBe(true);
    const firstRun = await scheduler.runScheduledLintNow();
    expect(firstRun).toEqual(expect.objectContaining({ projectsChecked: 1, checkedPages: 1 }));
    expect(lintWikiPages).toHaveBeenCalledTimes(1);
    expect(scheduler.shouldRun()).toBe(false);
  });
});
