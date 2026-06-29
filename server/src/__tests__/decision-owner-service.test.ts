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
    const grandchildIssueId = randomUUID();

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
    await db.insert(issues).values({
      id: grandchildIssueId,
      companyId,
      goalId,
      parentId: childIssueId,
      title: "Agent grandchild issue",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, rootIssueId, childIssueId, grandchildIssueId };
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
    const { companyId, childIssueId, grandchildIssueId } = await seedIssueTree();
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
      issueIds: [grandchildIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "root_human_requester",
      issueId: expect.any(String),
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

  it("prefers a triggering board commenter over the issue's own creator", async () => {
    // TWX-1107: when an issue has a human creator but no human ancestor, a board
    // member who explicitly comments to request the decision must outrank the
    // person who merely filed the issue.
    const { companyId, rootIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    await seedActiveCompanyUser(companyId, "thomas-user");
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "thomas-user",
      body: "Send this decision to me.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [rootIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "thomas-user",
      source: "source_comment_author",
    });
  });

  it("skips a commenter who is no longer an active member and falls back to the issue creator", async () => {
    // TWX-1110: the accept/approval path is locked to the resolved decision owner.
    // A commenter who was removed from the company can no longer resolve it, so we
    // must fall through to the next resolver (the issue's own creator) instead.
    const { companyId, rootIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    // The issue creator "jonas-user" is a write-capable member and is the valid
    // fallback once the commenter is skipped (TWX-1112 gates the creator too).
    await seedActiveCompanyUser(companyId, "jonas-user");
    // "removed-user" authored the triggering comment but has no active membership.
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "removed-user",
      body: "Send this decision to me.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [rootIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "current_issue_creator",
    });
  });

  it("skips a commenter downgraded to viewer and falls back to the issue creator", async () => {
    // TWX-1110: a viewer membership is read-only and cannot resolve a decision,
    // so a downgraded commenter must not be targeted as the decision owner.
    const { companyId, rootIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    await seedActiveCompanyUser(companyId, "jonas-user");
    await seedActiveCompanyUser(companyId, "viewer-user", "viewer");
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "viewer-user",
      body: "Send this decision to me.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [rootIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "current_issue_creator",
    });
  });

  it("falls back to the issue's own creator when no ancestor or commenter resolves", async () => {
    // TWX-1107: the issue creator still wins over the current board actor and the
    // configured default owner when nothing higher-priority resolves.
    const { companyId, rootIssueId } = await seedIssueTree();
    await seedActiveCompanyUser(companyId, "jonas-user");

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      issueIds: [rootIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "jonas-user",
      source: "current_issue_creator",
    });
  });

  it("falls through an invalid commenter AND an invalid issue creator to the board actor", async () => {
    // TWX-1112: this is the blocking case the fix targets. When the triggering
    // commenter and the issue's own creator both lack an active write-capable
    // membership, the resolver must continue down the documented order instead of
    // locking the interaction onto a creator who cannot resolve it.
    const { companyId, rootIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    // Neither "removed-commenter" nor the creator "jonas-user" has a membership.
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "removed-commenter",
      body: "Send this decision to me.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [rootIssueId],
      currentUserId: "current-user",
    })).resolves.toMatchObject({
      userId: "current-user",
      source: "current_board_actor",
    });
  });

  it("falls through a viewer-only issue creator to the configured default owner", async () => {
    // TWX-1112: a viewer membership is read-only, so an issue creator downgraded
    // to viewer cannot resolve the decision and must continue to the configured
    // default board owner when no other higher-priority candidate resolves.
    const { companyId, rootIssueId } = await seedIssueTree();
    await seedActiveCompanyUser(companyId, "jonas-user", "viewer");
    await seedActiveCompanyUser(companyId, "default-user");
    await instanceSettingsService(db).updateGeneral({
      defaultDecisionOwnerUserId: "default-user",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      issueIds: [rootIssueId],
    })).resolves.toMatchObject({
      userId: "default-user",
      source: "configured_default_board_owner",
    });
  });

  it("skips a root human ancestor who lacks a write-capable membership", async () => {
    // TWX-1112: the parent-chain originator is also gated. If the root human
    // initiator was removed/downgraded, fall through to the next resolver rather
    // than lock the decision onto a user who cannot accept it. Here the commenter
    // is the next valid candidate.
    const { companyId, childIssueId, grandchildIssueId } = await seedIssueTree();
    const sourceCommentId = randomUUID();
    // "jonas-user" is the root creator but has no membership; thomas commented.
    await seedActiveCompanyUser(companyId, "thomas-user");
    await db.insert(issueComments).values({
      id: sourceCommentId,
      companyId,
      issueId: childIssueId,
      authorUserId: "thomas-user",
      body: "Send this decision to me.",
    });

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      sourceCommentId,
      issueIds: [grandchildIssueId],
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
      message: "Explicit decision owner must be an active, write-capable (non-viewer) user in this company",
    });
  });

  it("rejects an explicit user who is only a viewer", async () => {
    // TWX-1112: explicit owners are caller-specified, so an invalid (read-only)
    // target is a caller error and fails loudly rather than silently falling
    // through like the inferred resolver paths.
    const { companyId, childIssueId } = await seedIssueTree();
    await seedActiveCompanyUser(companyId, "viewer-explicit", "viewer");

    await expect(resolveDecisionOwnerUserId(db, {
      companyId,
      explicitUserId: "viewer-explicit",
      issueIds: [childIssueId],
      currentUserId: "current-user",
    })).rejects.toMatchObject({
      status: 400,
      message: "Explicit decision owner must be an active, write-capable (non-viewer) user in this company",
    });
  });
});
