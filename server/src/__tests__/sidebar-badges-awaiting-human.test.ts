import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  goals,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { sidebarBadgeService } from "../services/sidebar-badges.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("sidebarBadgeService awaitingHuman", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof sidebarBadgeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sidebar-badges-awaiting-human-");
    db = createDb(tempDb.connectionString);
    svc = sidebarBadgeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(issueStatus = "in_review", hiddenAt: Date | null = null) {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({ id: goalId, companyId, title: "G", level: "task", status: "active" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Parent issue",
      status: issueStatus,
      priority: "medium",
      hiddenAt,
    });
    return { companyId, issueId };
  }

  async function addInteraction(
    companyId: string,
    issueId: string,
    overrides: { kind?: string; status?: string } = {},
  ) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId,
      issueId,
      kind: overrides.kind ?? "request_confirmation",
      status: overrides.status ?? "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1 },
    });
    return id;
  }

  it("counts one per issue (not per interaction) and folds it into the inbox total", async () => {
    const { companyId, issueId } = await seedIssue();
    // Two pending asks on the SAME issue collapse to a single waiting item.
    await addInteraction(companyId, issueId, { kind: "request_confirmation" });
    await addInteraction(companyId, issueId, { kind: "ask_user_questions" });

    let badges = await svc.get(companyId);
    expect(badges.awaitingHuman).toBe(1);
    expect(badges.inbox).toBe(1);

    // A second issue (same company) with a pending ask adds a second item.
    const secondGoalId = randomUUID();
    const secondIssueId = randomUUID();
    await db.insert(goals).values({ id: secondGoalId, companyId, title: "G2", level: "task", status: "active" });
    await db.insert(issues).values({
      id: secondIssueId,
      companyId,
      goalId: secondGoalId,
      title: "Second issue",
      status: "in_review",
      priority: "medium",
    });
    await addInteraction(companyId, secondIssueId, { kind: "request_confirmation" });
    badges = await svc.get(companyId);
    expect(badges.awaitingHuman).toBe(2);
    expect(badges.inbox).toBe(2);
  });

  it("ignores resolved interactions and interactions on terminal or hidden issues", async () => {
    const { companyId, issueId } = await seedIssue();
    await addInteraction(companyId, issueId, { status: "accepted" });

    const done = await seedIssue("done");
    await addInteraction(done.companyId, done.issueId);

    const hidden = await seedIssue("in_review", new Date());
    await addInteraction(hidden.companyId, hidden.issueId);

    expect((await svc.get(companyId)).awaitingHuman).toBe(0);
    expect((await svc.get(done.companyId)).awaitingHuman).toBe(0);
    expect((await svc.get(hidden.companyId)).awaitingHuman).toBe(0);
  });

  it("excludes interactions dismissed after their last update", async () => {
    const { companyId, issueId } = await seedIssue();
    const interactionId = await addInteraction(companyId, issueId);

    const dismissals = new Map<string, number>([[`interaction:${interactionId}`, Date.now() + 60_000]]);
    const badges = await svc.get(companyId, { dismissals });
    expect(badges.awaitingHuman).toBe(0);
  });
});
