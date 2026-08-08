import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, afterAll, afterEach, beforeAll } from "vitest";
import { agents, companies, createDb, issueComments, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  BLOCKED_ISSUE_ESCALATION_MARKER,
  buildBlockedIssueEscalationComment,
  buildBlockedIssueEscalationFingerprint,
  isBlockedIssueEscalationSuppressed,
  isBlockedIssueEscalationEnabled,
  parseBlockedIssueEscalationMarker,
  resolveCompanyDecider,
  selectBlockedIssueEscalationCandidates,
  createBlockedIssueEscalationRunner,
} from "./blocked-issue-escalation.js";

const now = new Date("2026-08-02T12:00:00.000Z");

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "SAG-1",
    title: "Unblock release",
    status: "blocked",
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function attention(state: "needs_attention" | "stalled" | "covered") {
  return {
    state,
    reason: state === "stalled" ? "stalled_review" : state === "covered" ? "active_child" : "attention_required",
    unresolvedBlockerCount: 1,
    coveredBlockerCount: state === "covered" ? 1 : 0,
    stalledBlockerCount: state === "stalled" ? 1 : 0,
    attentionBlockerCount: state === "needs_attention" ? 1 : 0,
    sampleBlockerIdentifier: "SAG-2",
    sampleStalledBlockerIdentifier: state === "stalled" ? "SAG-2" : null,
  } as const;
}

describe("blocked issue escalation candidate filter", () => {
  it("selects leaderless and stale blocked issues, excluding covered, fresh, and terminal issues", () => {
    const candidates = selectBlockedIssueEscalationCandidates({
      issues: [
        issue({ id: "leaderless", identifier: "SAG-1" }),
        issue({ id: "stale", identifier: "SAG-2" }),
        issue({ id: "covered", identifier: "SAG-3" }),
        issue({ id: "fresh", identifier: "SAG-4", updatedAt: new Date("2026-08-02T11:00:00.000Z") }),
        issue({ id: "done", identifier: "SAG-5", status: "done" }),
      ],
      attentionByIssueId: new Map([
        ["leaderless", attention("needs_attention")],
        ["stale", attention("stalled")],
        ["covered", attention("covered")],
        ["fresh", attention("stalled")],
        ["done", attention("needs_attention")],
      ]),
      now,
      staleThresholdMs: 24 * 60 * 60 * 1000,
    });

    expect(candidates.map((candidate) => [candidate.issue.id, candidate.reason])).toEqual([
      ["leaderless", "leaderless"],
      ["stale", "stale"],
    ]);
  });

  it("requires age to be strictly greater than the stale threshold", () => {
    const exactlyAtThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const candidates = selectBlockedIssueEscalationCandidates({
      issues: [issue({ updatedAt: exactlyAtThreshold })],
      attentionByIssueId: new Map([["issue-1", attention("stalled")]]),
      now,
      staleThresholdMs: 24 * 60 * 60 * 1000,
    });

    expect(candidates).toEqual([]);
  });
});

describe("blocked issue escalation contracts", () => {
  it("is disabled unless the explicit Stage 2b flag is enabled", () => {
    expect(isBlockedIssueEscalationEnabled({})).toBe(false);
    expect(isBlockedIssueEscalationEnabled({ PAPERCLIP_NO_DEAD_BLOCKS_STAGE_2B_ENABLED: "true" })).toBe(true);
  });

  it("suppresses the same fingerprint during cooldown but allows material changes", () => {
    const marker = {
      version: 1 as const,
      issueId: "issue-1",
      fingerprint: "same",
      deciderId: "agent-2",
      createdAt: "2026-08-02T00:00:00.000Z",
    };
    expect(isBlockedIssueEscalationSuppressed({
      marker,
      fingerprint: "same",
      now,
      cooldownMs: 24 * 60 * 60 * 1000,
    })).toBe(true);
    expect(isBlockedIssueEscalationSuppressed({
      marker,
      fingerprint: "changed",
      now,
      cooldownMs: 24 * 60 * 60 * 1000,
    })).toBe(false);
  });

  it("resolves the CEO from the current company agent graph", () => {
    expect(resolveCompanyDecider([
      { id: "agent-1", companyId: "company-1", name: "Engineer", role: "engineer", title: "Engineer", reportsTo: null },
      { id: "agent-2", companyId: "company-1", name: "Chief", role: "ceo", title: "Chief Executive Officer", reportsTo: null },
    ], "company-1")).toMatchObject({ id: "agent-2", name: "Chief" });
    expect(resolveCompanyDecider([
      { id: "other", companyId: "company-2", name: "Other CEO", role: "ceo", title: "CEO", reportsTo: null },
    ], "company-1")).toBeNull();
  });

  it("renders the CEO wake and a three-part unblock ask", () => {
    const candidate = selectBlockedIssueEscalationCandidates({
      issues: [issue()],
      attentionByIssueId: new Map([["issue-1", attention("needs_attention")]]),
      now,
      staleThresholdMs: 24 * 60 * 60 * 1000,
    })[0]!;
    const decider = { id: "agent-2", name: "Chief" };
    const fingerprint = buildBlockedIssueEscalationFingerprint(candidate, decider.id);
    const body = buildBlockedIssueEscalationComment(candidate, decider, fingerprint, now);

    expect(body).toContain(`[@Chief](agent://agent-2)`);
    expect(body).toContain("Decision needed:");
    expect(body).toContain("Named decider:");
    expect(body).toContain("Concrete unblock action:");
    expect(body).toContain(BLOCKED_ISSUE_ESCALATION_MARKER);
    expect(parseBlockedIssueEscalationMarker(body)).toMatchObject({
      issueId: "issue-1",
      fingerprint,
      deciderId: "agent-2",
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("blocked issue escalation sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-issue-escalation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("posts one dynamic CEO escalation and suppresses a duplicate fire", async () => {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const rootId = randomUUID();
    const blockerId = randomUUID();
    const prefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const firstFire = new Date("2026-08-02T12:00:00.000Z");

    await db.insert(companies).values({ id: companyId, name: "Escalation Test", issuePrefix: prefix });
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "Dynamic CEO",
      role: "ceo",
      title: "Chief Executive Officer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        identifier: `${prefix}-1`,
        title: "Waiting on release dependency",
        status: "blocked",
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        id: blockerId,
        companyId,
        identifier: `${prefix}-2`,
        title: "Unowned release dependency",
        status: "todo",
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: rootId,
      type: "blocks",
    });

    const runner = createBlockedIssueEscalationRunner(db, {
      runtimeEnv: { PAPERCLIP_NO_DEAD_BLOCKS_STAGE_2B_ENABLED: "true" },
      staleThresholdMs: 24 * 60 * 60 * 1000,
    });
    const first = await runner.run(companyId, firstFire);
    const second = await runner.run(companyId, firstFire);
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, rootId));

    expect(first).toMatchObject({ companiesScanned: 1, candidatesFound: 1, escalationsPosted: 1 });
    expect(second).toMatchObject({ candidatesFound: 1, escalationsPosted: 0, suppressedByCooldown: 1 });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(`[@Dynamic CEO](agent://${ceoId})`);
    expect(comments[0]!.body).toContain("Concrete unblock action:");
  });
});
