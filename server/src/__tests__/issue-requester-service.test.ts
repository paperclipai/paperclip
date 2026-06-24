import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  goals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  issueRequesterService,
  resolveRootHumanRequesterFromIssuePath,
} from "../services/issue-requester.js";

describe("issue requester resolution", () => {
  it("resolves the rootmost human requester across agent-created child chains", () => {
    const requester = resolveRootHumanRequesterFromIssuePath({
      issue: {
        id: "grandchild",
        identifier: "PAP-3",
        title: "Agent grandchild",
        createdByUserId: null,
      },
      ancestors: [
        {
          id: "child",
          identifier: "PAP-2",
          title: "Agent child",
          createdByUserId: null,
        },
        {
          id: "root",
          identifier: "PAP-1",
          title: "Human root",
          createdByUserId: "  jonas-user  ",
        },
      ],
    });

    expect(requester).toEqual({
      userId: "jonas-user",
      issueId: "root",
      identifier: "PAP-1",
      title: "Human root",
      source: "ancestor",
    });
  });

  it("falls back to the current issue when no ancestor has a human creator", () => {
    const requester = resolveRootHumanRequesterFromIssuePath({
      issue: {
        id: "current",
        identifier: "PAP-4",
        title: "Human current",
        createdByUserId: "thomas-user",
      },
      ancestors: [
        {
          id: "parent",
          identifier: "PAP-3",
          title: "Agent parent",
          createdByUserId: null,
        },
      ],
    });

    expect(requester).toEqual({
      userId: "thomas-user",
      issueId: "current",
      identifier: "PAP-4",
      title: "Human current",
      source: "current_issue",
    });
  });

  it("returns null when neither the current issue nor ancestors have a human creator", () => {
    const requester = resolveRootHumanRequesterFromIssuePath({
      issue: {
        id: "current",
        identifier: "PAP-4",
        title: "Agent current",
        createdByUserId: null,
      },
      ancestors: [
        {
          id: "parent",
          identifier: "PAP-3",
          title: "Agent parent",
          createdByUserId: null,
        },
      ],
    });

    expect(requester).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue requester service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-requester-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueTree(input: {
    companyId: string;
    rootUserId: string;
    rootTitle: string;
    childTitle: string;
  }) {
    const goalId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();

    await db.insert(goals).values({
      id: goalId,
      companyId: input.companyId,
      title: `${input.rootTitle} goal`,
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId: input.companyId,
      goalId,
      title: input.rootTitle,
      status: "in_progress",
      priority: "medium",
      createdByUserId: input.rootUserId,
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId: input.companyId,
      goalId,
      parentId: rootIssueId,
      title: input.childTitle,
      status: "in_progress",
      priority: "medium",
    });

    return { rootIssueId, childIssueId };
  }

  it("returns the first issue id's requester when multiple issue ids resolve", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const first = await seedIssueTree({
      companyId,
      rootUserId: "first-user",
      rootTitle: "First root",
      childTitle: "First child",
    });
    const second = await seedIssueTree({
      companyId,
      rootUserId: "second-user",
      rootTitle: "Second root",
      childTitle: "Second child",
    });

    await expect(issueRequesterService(db).resolveRootHumanRequesterForIssues({
      companyId,
      issueIds: [first.childIssueId, second.childIssueId],
    })).resolves.toMatchObject({
      userId: "first-user",
      issueId: first.rootIssueId,
    });
  });
});
