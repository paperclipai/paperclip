import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { projectCreatedItems } from "./project-created-items";
const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent =>
  ({
    id: "activity",
    companyId: "company",
    actorType: "agent",
    actorId: "agent",
    agentId: "agent",
    runId: "run",
    action: "project.created",
    entityType: "project",
    entityId: "project",
    createdAt: new Date("2026-09-11T12:00:00Z"),
    details: {
      name: "Launch",
      repositories: [
        { id: "1", name: "org/app", url: "https://github.com/org/app" },
        { id: "2", name: "org/docs", url: "https://github.com/org/docs" },
      ],
    },
    ...overrides,
  }) as ActivityEvent;
describe("durable project creation feed", () => {
  it("deduplicates repeated receipts while retaining all repositories", () => {
    const items = projectCreatedItems([event(), event({ id: "replay" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "project_created",
      projectId: "project",
      name: "Launch",
    });
    expect(items[0].repositories).toHaveLength(2);
    expect(projectCreatedItems(JSON.parse(JSON.stringify([event()])))).toEqual(
      items,
    );
  });
  it("does not turn a failed tool call or agent claim into a success card", () => {
    expect(
      projectCreatedItems([
        event({ action: "runner.api_called" }),
        event({ action: "issue.comment_added" }),
      ]),
    ).toEqual([]);
  });
  it("omits unsafe repository links and accepts projects without repositories", () => {
    expect(
      projectCreatedItems([
        event({
          details: {
            name: "Research",
            repositories: [
              { id: "unsafe", name: "unsafe", url: "javascript:alert(1)" },
            ],
          },
        }),
      ])[0].repositories,
    ).toEqual([]);
    expect(
      projectCreatedItems([event({ details: { name: "Research" } })])[0].name,
    ).toBe("Research");
  });
});

describe("project creation repository hydration", () => {
  const project = {
    id: "project",
    companyId: "company",
    workspaces: [
      { id: "workspace-1", name: "App", repoUrl: "https://github.com/org/app" },
      {
        id: "workspace-2",
        name: "Docs",
        repoUrl: "https://github.com/org/docs",
      },
    ],
  } as import("@paperclipai/shared").Project;

  it("includes repositories added after creation without adding another card", () => {
    const receipt = event({
      details: {
        name: "Launch",
        repositories: [
          { id: "1", name: "App", url: "https://github.com/org/app" },
        ],
      },
    });
    const items = projectCreatedItems([receipt, receipt], [project]);
    expect(items).toHaveLength(1);
    expect(items[0].repositories.map((repo) => repo.url)).toEqual([
      "https://github.com/org/app",
      "https://github.com/org/docs",
    ]);
    expect(projectCreatedItems([], [project])).toEqual([]);
    expect(items[0].timestamp).toBe("2026-09-11T12:00:00.000Z");
  });

  it("reflects repository removal but falls back when current project data is unavailable", () => {
    expect(
      projectCreatedItems([event()], [{ ...project, workspaces: [] }])[0]
        .repositories,
    ).toEqual([]);
    expect(
      projectCreatedItems(
        [event()],
        [{ ...project, companyId: "other-company" }],
      ),
    ).toEqual(projectCreatedItems([event()]));
  });

  it("deduplicates workspaces and rejects unsafe current repository links", () => {
    const workspaces = [
      project.workspaces[0],
      project.workspaces[0],
      { ...project.workspaces[1], repoUrl: "javascript:alert(1)" },
    ];
    expect(
      projectCreatedItems([event()], [{ ...project, workspaces }])[0]
        .repositories,
    ).toEqual([
      { id: "workspace-1", name: "App", url: "https://github.com/org/app" },
    ]);
  });
});
