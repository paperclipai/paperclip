import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companyMemberships,
  companies,
  createDb,
  goals,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_PULL_REQUEST_ASSIGNEE_RULES,
  resolvePullRequestAssignee,
  THOMAS_BOARD_USER_ID,
} from "../services/pull-request-assignee.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pull request assignee resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-assignee-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
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

  async function seedActiveCompanyUser(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
  }

  /**
   * Builds a root(human) -> child(agent) -> grandchild(agent) tree so the
   * resolver has to walk the parent chain to find the human initiator.
   */
  async function seedIssueTree(companyId: string, rootCreatedByUserId: string | null) {
    const goalId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "PR assignment",
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
      createdByUserId: rootCreatedByUserId,
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
    return { rootIssueId, childIssueId, grandchildIssueId };
  }

  it("ships a built-in default rule assigning Thomas's trees to Thomas", () => {
    expect(DEFAULT_PULL_REQUEST_ASSIGNEE_RULES).toEqual([
      { rootRequesterUserId: THOMAS_BOARD_USER_ID, assigneeUserId: THOMAS_BOARD_USER_ID },
    ]);
  });

  it("assigns the PR to Thomas when the tree root requester is Thomas (default rule)", async () => {
    const companyId = await seedCompany();
    await seedActiveCompanyUser(companyId, THOMAS_BOARD_USER_ID);
    const { grandchildIssueId } = await seedIssueTree(companyId, THOMAS_BOARD_USER_ID);

    await expect(
      resolvePullRequestAssignee(db, { companyId, issueId: grandchildIssueId }),
    ).resolves.toMatchObject({
      userId: THOMAS_BOARD_USER_ID,
      source: "issue_tree_root_requester_rule",
      rootRequesterUserId: THOMAS_BOARD_USER_ID,
    });
  });

  it("preserves existing behavior for trees initiated by other users", async () => {
    const companyId = await seedCompany();
    await seedActiveCompanyUser(companyId, "jonas-user");
    const { grandchildIssueId } = await seedIssueTree(companyId, "jonas-user");

    await expect(
      resolvePullRequestAssignee(db, { companyId, issueId: grandchildIssueId }),
    ).resolves.toBeNull();
  });

  it("returns null when there is no human root requester", async () => {
    const companyId = await seedCompany();
    const { grandchildIssueId } = await seedIssueTree(companyId, null);

    await expect(
      resolvePullRequestAssignee(db, { companyId, issueId: grandchildIssueId }),
    ).resolves.toBeNull();
  });

  it("does not assign when the matched assignee is not an active company member", async () => {
    const companyId = await seedCompany();
    // Thomas is the root requester but is NOT a member of this company.
    const { grandchildIssueId } = await seedIssueTree(companyId, THOMAS_BOARD_USER_ID);

    await expect(
      resolvePullRequestAssignee(db, { companyId, issueId: grandchildIssueId }),
    ).resolves.toBeNull();
  });

  it("honors instance-settings rules overriding the built-in default", async () => {
    const companyId = await seedCompany();
    await seedActiveCompanyUser(companyId, "jonas-user");
    await instanceSettingsService(db).updateGeneral({
      pullRequestAssigneeRules: [
        { rootRequesterUserId: "jonas-user", assigneeUserId: "jonas-user" },
      ],
    });
    const { grandchildIssueId } = await seedIssueTree(companyId, "jonas-user");

    await expect(
      resolvePullRequestAssignee(db, { companyId, issueId: grandchildIssueId }),
    ).resolves.toMatchObject({
      userId: "jonas-user",
      source: "issue_tree_root_requester_rule",
      rootRequesterUserId: "jonas-user",
    });

    // And Thomas's default rule no longer applies once settings are explicit.
    await seedActiveCompanyUser(companyId, THOMAS_BOARD_USER_ID);
    const thomasTree = await seedIssueTree(companyId, THOMAS_BOARD_USER_ID);
    await expect(
      resolvePullRequestAssignee(db, { companyId, issueId: thomasTree.grandchildIssueId }),
    ).resolves.toBeNull();
  });
});
