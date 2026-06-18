import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companyMemberships,
  companies,
  createDb,
  goals,
  instanceSettings,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveDecisionOwnerUserId } from "../services/decision-owner.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("decision owner resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-owner-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueTree() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Decision routing",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      goalId,
      title: "Root human issue",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "jonas-user",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      goalId,
      parentId: rootIssueId,
      title: "Agent child issue",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, rootIssueId, childIssueId };
  }

  async function seedActiveCompanyUser(companyId: string, userId: string, membershipRole = "owner") {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
  }

  it("prefers explicit user, then root human requester, then source comment author", async () => {
    const { companyId, childIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    await seedActiveCompanyUser(companyId, "explicit-user");
    await seedActiveCompanyUser(companyId, "thomas-user");
    await seedActiveCompanyUser(companyId, "jonas-user");
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: childIssueId,
      authorUserId: "thomas-user",
      body: "Please ask me.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      explicitUserId: "explicit-user",
      sourceCommentId,
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "explicit-user",
      source: "explicit_user",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "root_human_requester",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "thomas-user",
      source: "source_comment_author",
    });
  });

  it("falls back to current board actor and configured default owner", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "current-user",
      source: "current_board_actor",
    });

    await seedActiveCompanyUser(companyId, "default-user");
    await instanceSettingsService(db).updateGeneral({
      defaultDecisionOwnerUserId: "default-user",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
    })).resolves.toMatchObject({
      userId: "default-user",
      source: "configured_default_board_owner",
    });
  });

  it("rejects explicit users that are not active company members", async () => {
    const { companyId, childIssueId } = await seedIssueTree();

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      explicitUserId: "outsider-user",
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).rejects.toMatchObject({
      status: 400,
      message: "Explicit decision owner must be an active user in this company",
    });
  });
});
