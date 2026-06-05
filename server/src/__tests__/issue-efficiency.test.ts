/**
 * issue-efficiency tests (BLO-9117 / BLO-9102 Diff 2).
 *
 * The two failure modes the acceptance criteria name are asserted as pure,
 * environment-robust unit tests (they don't need a DB):
 *   - data-wall #4 (double-counting): a multi-adapter issue's authored-LOC must
 *     sum across adapters to the issue total.
 *   - data-wall #2 (silent tail drop): coverage % must equal ref-linked / total.
 * A DB-backed describe (embedded Postgres, skipped where unsupported) exercises
 * the full stack end-to-end against the real migration, including the
 * identity-agnostic linkage path.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterEach, afterAll } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issuePullRequests,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  apportionIssueAcrossAdapters,
  coverageForWindow,
  reduceCostSource,
  rollupApportioned,
  UNATTRIBUTED_ADAPTER,
  issueEfficiencyService,
  type PerIssueApportionInput,
} from "../services/issue-efficiency.js";
import { recordMergedPullRequest } from "../services/issue-pull-requests.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("apportionment (pure) — data-wall #4: no double-counting", () => {
  it("sums authored-LOC across adapters to the issue total for a 2-adapter issue", () => {
    // BLO-5295-shaped: claude (small share) + opencode (large share).
    const apportioned = apportionIssueAcrossAdapters({
      issueId: "i1",
      adapters: [
        { adapterType: "claude_k8s", outputTokens: 70_000, costCents: 900 },
        { adapterType: "opencode_k8s", outputTokens: 210_000, costCents: 300 },
      ],
      authoredLoc: 1000,
      mergedPrCount: 1,
    });
    // Shares sum to 1.0 …
    expect(sum(apportioned.map((a) => a.outputTokenShare))).toBeCloseTo(1, 9);
    // … and authored-LOC summed across adapters equals the issue total (NOT 2×).
    expect(sum(apportioned.map((a) => a.authoredLoc))).toBeCloseTo(1000, 6);
    expect(sum(apportioned.map((a) => a.mergedPrShare))).toBeCloseTo(1, 9);
    // Apportioned by output share: opencode (75%) carries 3× claude's LOC.
    const claude = apportioned.find((a) => a.adapterType === "claude_k8s")!;
    const opencode = apportioned.find((a) => a.adapterType === "opencode_k8s")!;
    expect(opencode.authoredLoc).toBeCloseTo(750, 6);
    expect(claude.authoredLoc).toBeCloseTo(250, 6);
  });

  it("falls back to cost-share when no adapter reported output tokens", () => {
    const apportioned = apportionIssueAcrossAdapters({
      issueId: "i2",
      adapters: [
        { adapterType: "a", outputTokens: 0, costCents: 300 },
        { adapterType: "b", outputTokens: 0, costCents: 100 },
      ],
      authoredLoc: 400,
      mergedPrCount: 2,
    });
    expect(sum(apportioned.map((a) => a.authoredLoc))).toBeCloseTo(400, 6);
    expect(apportioned.find((a) => a.adapterType === "a")!.authoredLoc).toBeCloseTo(300, 6);
  });

  it("routes authored-LOC to the unattributed bucket when there is no usage signal", () => {
    const apportioned = apportionIssueAcrossAdapters({
      issueId: "i3",
      adapters: [{ adapterType: "a", outputTokens: 0, costCents: 0 }],
      authoredLoc: 500,
      mergedPrCount: 1,
    });
    // Nothing dropped: the total still surfaces, under the explicit sentinel.
    expect(sum(apportioned.map((a) => a.authoredLoc))).toBeCloseTo(500, 6);
    const bucket = apportioned.find((a) => a.adapterType === UNATTRIBUTED_ADAPTER);
    expect(bucket?.authoredLoc).toBe(500);
  });

  it("rollup keeps a single issue's authored-LOC equal to its total (no per-adapter inflation)", () => {
    const perIssue: PerIssueApportionInput[] = [
      {
        issueId: "i1",
        adapters: [
          { adapterType: "claude_k8s", outputTokens: 100, costCents: 500 },
          { adapterType: "opencode_k8s", outputTokens: 300, costCents: 100 },
        ],
        authoredLoc: 800,
        mergedPrCount: 1,
      },
    ];
    const rows = rollupApportioned(perIssue);
    expect(sum(rows.map((r) => r.authoredLoc))).toBeCloseTo(800, 6);
    // $/authored-LOC is finite per adapter (no divide-by-zero, no NaN).
    for (const r of rows) {
      if (r.authoredLoc > 0) expect(Number.isFinite(r.costCentsPerAuthoredLoc!)).toBe(true);
    }
  });
});

describe("coverage (pure) — data-wall #2: surface the unattributed tail", () => {
  it("reports coverage as ref-linked / total across all identities", () => {
    // 5 merged PRs: 2 linked (issueId set), 3 unlinked (null) — author-blind.
    const cov = coverageForWindow([
      { issueId: "a" },
      { issueId: "b" },
      { issueId: null },
      { issueId: null },
      { issueId: null },
    ]);
    expect(cov.totalMergedPrs).toBe(5);
    expect(cov.refLinkedMergedPrs).toBe(2);
    expect(cov.unattributedMergedPrs).toBe(3);
    expect(cov.coverage).toBeCloseTo(2 / 5, 9);
    // The tail is present (null-issueId rows), so coverage is trustworthy.
    expect(cov.reconciledTailObserved).toBe(true);
    expect(cov.forwardOnly).toBe(false);
  });

  it("flags a forward-only window so a vacuous 100% is not mistaken for real coverage", () => {
    // Forward-capture stores ONLY ref-linked rows → every row has an issueId and
    // no 'reconciler' linkSource. coverage reads 1.0 but it's not yet measured.
    const cov = coverageForWindow([
      { issueId: "a", linkSource: "branch_ref" },
      { issueId: "b", linkSource: "title_ref" },
    ]);
    expect(cov.coverage).toBe(1);
    expect(cov.reconciledTailObserved).toBe(false);
    expect(cov.forwardOnly).toBe(true);
  });

  it("treats a 'reconciler'-sourced row as evidence the tail was enumerated", () => {
    const cov = coverageForWindow([
      { issueId: "a", linkSource: "branch_ref" },
      { issueId: "b", linkSource: "reconciler" },
    ]);
    expect(cov.reconciledTailObserved).toBe(true);
    expect(cov.forwardOnly).toBe(false);
  });

  it("is 100% when there are no PRs (no spurious 0/0), and not flagged forward-only", () => {
    const cov = coverageForWindow([]);
    expect(cov.coverage).toBe(1);
    expect(cov.forwardOnly).toBe(false);
  });
});

describe("reduceCostSource", () => {
  it("collapses a single source, flags mixed, and null-passes empties", () => {
    expect(reduceCostSource(["metered", "metered"])).toBe("metered");
    expect(reduceCostSource(["list_estimate"])).toBe("list_estimate");
    expect(reduceCostSource(["metered", "list_estimate"])).toBe("mixed");
    expect(reduceCostSource([null, undefined])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB-backed end-to-end (embedded Postgres applies the 0106 migration).
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-efficiency tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue-efficiency (DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueEfficiencyService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-efficiency-");
    db = createDb(tempDb.connectionString);
    svc = issueEfficiencyService(db);
  });

  afterEach(async () => {
    await db.delete(issuePullRequests);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, adapterType: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${adapterType}`,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("forIssue: two adapters, shares ~1.0, authored-LOC from the merged PR, costSource surfaced", async () => {
    const companyId = await seedCompany();
    const claude = await seedAgent(companyId, "claude_k8s");
    const opencode = await seedAgent(companyId, "opencode_k8s");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multi-adapter",
      status: "done",
      priority: "medium",
      issueNumber: 1,
      identifier: "TST-5295",
    });

    // A run per adapter carrying costSource in usage_json.
    const claudeRun = randomUUID();
    const opencodeRun = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: claudeRun, companyId, agentId: claude, usageJson: { costSource: "metered" } },
      { id: opencodeRun, companyId, agentId: opencode, usageJson: { costSource: "list_estimate" } },
    ]);
    await db.insert(costEvents).values([
      {
        companyId, agentId: claude, issueId, heartbeatRunId: claudeRun,
        provider: "anthropic", biller: "anthropic", billingType: "metered_api",
        model: "claude-opus-4-8", inputTokens: 0, cachedInputTokens: 0, outputTokens: 70_000,
        costCents: 900, occurredAt: new Date("2026-05-20T00:00:00Z"),
      },
      {
        companyId, agentId: opencode, issueId, heartbeatRunId: opencodeRun,
        provider: "openai", biller: "openai", billingType: "subscription_included",
        model: "gpt-5.3-codex", inputTokens: 0, cachedInputTokens: 0, outputTokens: 210_000,
        costCents: 300, occurredAt: new Date("2026-05-20T00:01:00Z"),
      },
    ]);
    await db.insert(issuePullRequests).values({
      companyId, issueId, repoFullName: "Blockcast/paperclip", prNumber: 5295,
      mergedAt: new Date("2026-05-20T01:00:00Z"), additions: 1200, deletions: 200,
      authoredAdditions: 800, authoredDeletions: 200, linkSource: "branch_ref",
      paperclipIdentifier: "TST-5295", locEnrichedAt: new Date("2026-05-20T01:05:00Z"),
    });

    const eff = await svc.forIssue(companyId, issueId);
    expect(eff.adapters).toHaveLength(2);
    expect(sum(eff.adapters.map((a) => a.outputTokenShare))).toBeCloseTo(1, 6);
    expect(eff.authoredLoc).toBe(1000); // 800 + 200, generated-excluded
    expect(eff.rawLoc).toBe(1400); // raw retained for comparison
    expect(eff.costCents).toBe(1200);
    expect(eff.costSource).toBe("mixed"); // metered (claude) + list_estimate (opencode)
    expect(eff.mergedPullRequests).toHaveLength(1);
    expect(eff.mergedPullRequests[0]?.prNumber).toBe(5295);
  });

  it("adapterRollup: apportioned authored-LOC sums to the issue total; coverage = linked/total", async () => {
    const companyId = await seedCompany();
    const claude = await seedAgent(companyId, "claude_k8s");
    const opencode = await seedAgent(companyId, "opencode_k8s");
    const linkedIssue = randomUUID();
    await db.insert(issues).values({
      id: linkedIssue, companyId, title: "Linked", status: "done", priority: "medium",
      issueNumber: 1, identifier: "TST-1",
    });
    await db.insert(costEvents).values([
      {
        companyId, agentId: claude, issueId: linkedIssue, provider: "anthropic", biller: "anthropic",
        billingType: "metered_api", model: "claude-opus-4-8", outputTokens: 100, costCents: 500,
        occurredAt: new Date("2026-05-20T00:00:00Z"),
      },
      {
        companyId, agentId: opencode, issueId: linkedIssue, provider: "openai", biller: "openai",
        billingType: "subscription_included", model: "gpt-5.3-codex", outputTokens: 300, costCents: 100,
        occurredAt: new Date("2026-05-20T00:01:00Z"),
      },
    ]);
    const window = { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-06-01T00:00:00Z") };
    // One linked PR (issue) + two unattributed tail PRs (no issueId).
    await db.insert(issuePullRequests).values([
      {
        companyId, issueId: linkedIssue, repoFullName: "Blockcast/paperclip", prNumber: 1,
        mergedAt: new Date("2026-05-20T01:00:00Z"), authoredAdditions: 600, authoredDeletions: 200,
        linkSource: "branch_ref", locEnrichedAt: new Date(),
      },
      {
        companyId, issueId: null, repoFullName: "Blockcast/paperclip", prNumber: 2,
        mergedAt: new Date("2026-05-21T01:00:00Z"), linkSource: "reconciler",
      },
      {
        companyId, issueId: null, repoFullName: "Blockcast/paperclip", prNumber: 3,
        mergedAt: new Date("2026-05-22T01:00:00Z"), linkSource: "reconciler",
      },
    ]);

    const rollup = await svc.adapterRollup(companyId, window);
    // data-wall #4: the issue's 800 authored-LOC is apportioned, not doubled.
    const apportionedTotal = sum(rollup.adapters.map((a) => a.authoredLoc));
    expect(apportionedTotal).toBeCloseTo(800, 6);
    // data-wall #2: 1 of 3 merged PRs is ref-linked → 33% coverage, tail surfaced.
    expect(rollup.coverage.totalMergedPrs).toBe(3);
    expect(rollup.coverage.refLinkedMergedPrs).toBe(1);
    expect(rollup.coverage.coverage).toBeCloseTo(1 / 3, 6);
  });

  it("identity-agnostic linkage: a non-kkroo (app/allyblockcast) PR links by ref identically", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Identity", status: "in_progress", priority: "medium",
      issueNumber: 7, identifier: "TST-9117",
    });

    // recordMergedPullRequest takes NO author field — attribution is purely by
    // ref. This is the structural guarantee: a PR authored by app/allyblockcast
    // links exactly as a kkroo-authored one would, because author is never read.
    const recorded = await recordMergedPullRequest(db, {
      repoFullName: "Blockcast/paperclip",
      prNumber: 303,
      headSha: "99cae76e",
      mergedAt: new Date("2026-05-20T01:00:00Z"),
      additions: 50,
      deletions: 5,
      // Branch carries a lowercase ref (doesn't match the uppercase extractor),
      // so attribution comes from the title — exercising the source preference.
      branch: "feature/some-work",
      title: "feat: TST-9117 efficiency",
      body: null,
      matchedIssues: [{ id: issueId, companyId, identifier: "TST-9117" }],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.issueId).toBe(issueId);

    const [row] = await db.select().from(issuePullRequests);
    expect(row?.issueId).toBe(issueId);
    expect(row?.linkSource).toBe("title_ref"); // matched via the title TST-9117
    expect(row?.paperclipIdentifier).toBe("TST-9117");
    // Structural guard: the persisted row has no author column at all.
    expect(Object.keys(row ?? {})).not.toContain("prAuthor");
    expect(Object.keys(row ?? {})).not.toContain("author");
  });
});
