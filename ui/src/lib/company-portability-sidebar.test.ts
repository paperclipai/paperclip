import { describe, expect, it } from "vitest";
import type { Agent, Project } from "@paperclipai/shared";
import {
  buildPortableAgentSlugMap,
  buildPortableProjectSlugMap,
  buildPortableSidebarOrder,
} from "./company-portability-sidebar";

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    urlKey: name.toLowerCase(),
  };
}

function makeProject(id: string, name: string): Project {
  return {
    id,
    companyId: "company-1",
    goalId: null,
    urlKey: name.toLowerCase(),
    name,
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
    goalIds: [],
    goals: [],
    primaryWorkspace: null,
    workspaces: [],
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/managed",
      effectiveLocalFolder: "/tmp/managed",
      origin: "managed_checkout",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("company portability sidebar order", () => {
  it("uses the same unique slug allocation as export and preserves the requested order", () => {
    const alphaOne = makeAgent("agent-1", "Alpha");
    const alphaTwo = makeAgent("agent-2", "Alpha");
    const beta = makeAgent("agent-3", "Beta");
    const launch = makeProject("project-1", "Launch");
    const launchTwo = makeProject("project-2", "Launch");

    expect(Array.from(buildPortableAgentSlugMap([alphaOne, alphaTwo, beta]).entries())).toEqual([
      ["agent-1", "alpha"],
      ["agent-2", "alpha-2"],
      ["agent-3", "beta"],
    ]);
    expect(Array.from(buildPortableProjectSlugMap([launch, launchTwo]).entries())).toEqual([
      ["project-1", "launch"],
      ["project-2", "launch-2"],
    ]);

    expect(buildPortableSidebarOrder({
      agents: [alphaOne, alphaTwo, beta],
      orderedAgents: [beta, alphaTwo, alphaOne],
      projects: [launch, launchTwo],
      orderedProjects: [launchTwo, launch],
    })).toEqual({
      agents: ["beta", "alpha-2", "alpha"],
      projects: ["launch-2", "launch"],
    });
  });
});
