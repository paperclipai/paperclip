// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { KnowledgeItem, Agent } from "@paperclipai/shared";
import {
  getKnowledgeAuthorshipLabels,
  resolveKnowledgeActorLabel,
} from "./knowledge-metadata";

function makeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "knowledge-1",
    companyId: "company-1",
    title: "Runbook",
    kind: "note",
    summary: "Summary",
    body: "Body",
    assetId: null,
    sourceUrl: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-03-08T10:00:00.000Z"),
    updatedAt: new Date("2026-03-08T11:00:00.000Z"),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "KnowledgeBot",
    urlKey: "knowledgebot",
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-03-08T10:00:00.000Z"),
    updatedAt: new Date("2026-03-08T10:00:00.000Z"),
    ...overrides,
  };
}

describe("resolveKnowledgeActorLabel", () => {
  it("prefers matching agent names", () => {
    const label = resolveKnowledgeActorLabel({
      agentId: "agent-1",
      userId: null,
      agents: [makeAgent()],
      currentUserId: null,
    });

    expect(label).toBe("KnowledgeBot");
  });

  it("labels the board user explicitly", () => {
    const label = resolveKnowledgeActorLabel({
      agentId: null,
      userId: "local-board",
      agents: [],
      currentUserId: null,
    });

    expect(label).toBe("Board");
  });

  it("labels the signed-in user as Me", () => {
    const label = resolveKnowledgeActorLabel({
      agentId: null,
      userId: "user-12345",
      agents: [],
      currentUserId: "user-12345",
    });

    expect(label).toBe("Me");
  });

  it("falls back to a stable short id when the actor is unknown", () => {
    const label = resolveKnowledgeActorLabel({
      agentId: null,
      userId: "user-123456789",
      agents: [],
      currentUserId: null,
    });

    expect(label).toBe("user-123");
  });

  it("returns Unknown when there is no actor information", () => {
    const label = resolveKnowledgeActorLabel({
      agentId: null,
      userId: null,
      agents: [],
      currentUserId: null,
    });

    expect(label).toBe("Unknown");
  });
});

describe("getKnowledgeAuthorshipLabels", () => {
  it("returns created and updated labels from agent and user authorship", () => {
    const item = makeItem({
      createdByAgentId: "agent-1",
      updatedByUserId: "local-board",
    });

    const labels = getKnowledgeAuthorshipLabels(item, {
      agents: [makeAgent()],
      currentUserId: "user-1",
    });

    expect(labels).toEqual({
      createdBy: "KnowledgeBot",
      updatedBy: "Board",
    });
  });
});
