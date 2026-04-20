import { describe, expect, it } from "vitest";
import { mapGoalToNote, mapIssueToNote, type MapperContext } from "../src/lib/mapper.js";
import type { Goal, Issue } from "@paperclipai/shared";

function makeMapperCtx(overrides?: Partial<MapperContext>): MapperContext {
  return {
    projectNames: new Map([["proj_1", "Website"]]),
    agentNames: new Map([["agent_1", "Founding Engineer"]]),
    goalTitles: new Map([["goal_1", "Ship MVP"]]),
    commentsByIssue: new Map(),
    folderStructure: "by-project",
    includeComments: true,
    maxCommentsPerIssue: 10,
    ...overrides,
  };
}

function makeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "iss_1",
    companyId: "comp_1",
    projectId: "proj_1",
    projectWorkspaceId: null,
    goalId: "goal_1",
    parentId: null,
    title: "Fix login bug",
    description: "The login form breaks when PAP-99 is also broken.",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: "agent_1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 42,
    identifier: "PAP-42",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2025-01-15T10:00:00Z"),
    updatedAt: new Date("2025-01-16T12:00:00Z"),
    ...overrides,
  } as Issue;
}

describe("mapIssueToNote", () => {
  it("generates correct path for by-project structure", () => {
    const note = mapIssueToNote(makeIssue(), makeMapperCtx());
    expect(note.relativePath).toBe("Projects/Website/Issues/PAP-42.md");
  });

  it("generates correct path for flat structure", () => {
    const note = mapIssueToNote(makeIssue(), makeMapperCtx({ folderStructure: "flat" }));
    expect(note.relativePath).toBe("Issues/PAP-42.md");
  });

  it("includes frontmatter fields", () => {
    const note = mapIssueToNote(makeIssue(), makeMapperCtx());
    expect(note.frontmatter.paperclip_id).toBe("iss_1");
    expect(note.frontmatter.identifier).toBe("PAP-42");
    expect(note.frontmatter.status).toBe("in_progress");
    expect(note.frontmatter.priority).toBe("high");
    expect(note.frontmatter.assignee).toBe("Founding Engineer");
    expect(note.frontmatter.project).toBe("Website");
    expect(note.frontmatter.goal).toBe("Ship MVP");
    expect(note.frontmatter.tags).toEqual(["paperclip", "issue"]);
  });

  it("converts issue references to wikilinks", () => {
    const note = mapIssueToNote(makeIssue(), makeMapperCtx());
    expect(note.body).toContain("[[PAP-99]]");
  });

  it("includes comments when configured", () => {
    const ctx = makeMapperCtx({
      commentsByIssue: new Map([
        [
          "iss_1",
          [
            {
              body: "Fixed the bug",
              createdAt: "2025-01-16T12:00:00Z",
              authorName: "Founding Engineer",
            },
          ],
        ],
      ]),
    });
    const note = mapIssueToNote(makeIssue(), ctx);
    expect(note.body).toContain("## Comments");
    expect(note.body).toContain("Fixed the bug");
    expect(note.body).toContain("Founding Engineer");
  });

  it("handles uncategorized projects", () => {
    const note = mapIssueToNote(makeIssue({ projectId: "unknown_proj" }), makeMapperCtx());
    expect(note.relativePath).toContain("Uncategorized");
  });
});

describe("mapGoalToNote", () => {
  it("generates a goal note with frontmatter", () => {
    const goal: Goal = {
      id: "goal_1",
      companyId: "comp_1",
      title: "Ship MVP",
      description: "Launch the minimum viable product by Q1.",
      level: "company",
      status: "active",
      parentId: null,
      ownerAgentId: "agent_1",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-10T00:00:00Z"),
    } as Goal;

    const note = mapGoalToNote(goal, makeMapperCtx());
    expect(note.relativePath).toBe("Goals/Ship MVP.md");
    expect(note.frontmatter.paperclip_id).toBe("goal_1");
    expect(note.frontmatter.level).toBe("company");
    expect(note.frontmatter.status).toBe("active");
    expect(note.frontmatter.owner).toBe("Founding Engineer");
    expect(note.frontmatter.tags).toEqual(["paperclip", "goal"]);
    expect(note.body).toContain("# Ship MVP");
    expect(note.body).toContain("Launch the minimum viable product");
  });
});
