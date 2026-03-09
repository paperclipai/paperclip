import { describe, expect, it } from "vitest";
import type { PlanRecord, ResultRecord } from "@paperclipai/shared";
import { summarizeProjectHealth } from "../services/records.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-03-09T00:00:00.000Z");

function createPlanRecord(overrides: Partial<PlanRecord>): PlanRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    companyId: COMPANY_ID,
    category: "plan",
    kind: "decision_record",
    scopeType: "project",
    scopeRefId: overrides.scopeRefId ?? "project-1",
    title: overrides.title ?? "Decision needed",
    summary: overrides.summary ?? null,
    bodyMd: overrides.bodyMd ?? null,
    status: overrides.status ?? "active",
    ownerAgentId: overrides.ownerAgentId ?? null,
    decisionNeeded: overrides.decisionNeeded ?? true,
    decisionDueAt: overrides.decisionDueAt ?? null,
    healthStatus: overrides.healthStatus ?? null,
    healthDelta: overrides.healthDelta ?? null,
    confidence: overrides.confidence ?? null,
    publishedAt: overrides.publishedAt ?? null,
    generatedAt: overrides.generatedAt ?? null,
    metadata: overrides.metadata ?? null,
    createdByAgentId: overrides.createdByAgentId ?? null,
    createdByUserId: overrides.createdByUserId ?? "board-user",
    updatedByAgentId: overrides.updatedByAgentId ?? null,
    updatedByUserId: overrides.updatedByUserId ?? "board-user",
    links: overrides.links ?? [],
    attachments: overrides.attachments ?? [],
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function createResultRecord(overrides: Partial<ResultRecord>): ResultRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    companyId: COMPANY_ID,
    category: "result",
    kind: "status_report",
    scopeType: "project",
    scopeRefId: overrides.scopeRefId ?? "project-1",
    title: overrides.title ?? "Published result",
    summary: overrides.summary ?? null,
    bodyMd: overrides.bodyMd ?? null,
    status: overrides.status ?? "published",
    ownerAgentId: overrides.ownerAgentId ?? null,
    decisionNeeded: overrides.decisionNeeded ?? false,
    decisionDueAt: overrides.decisionDueAt ?? null,
    healthStatus: overrides.healthStatus ?? null,
    healthDelta: overrides.healthDelta ?? null,
    confidence: overrides.confidence ?? null,
    publishedAt: overrides.publishedAt ?? NOW,
    generatedAt: overrides.generatedAt ?? null,
    metadata: overrides.metadata ?? null,
    createdByAgentId: overrides.createdByAgentId ?? null,
    createdByUserId: overrides.createdByUserId ?? "board-user",
    updatedByAgentId: overrides.updatedByAgentId ?? null,
    updatedByUserId: overrides.updatedByUserId ?? "board-user",
    links: overrides.links ?? [],
    attachments: overrides.attachments ?? [],
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

describe("summarizeProjectHealth", () => {
  it("uses the full blocker and decision collections when deriving project health", () => {
    const blockerProjectId = "project-9";
    const decisionProjectId = "project-10";
    const scopedProjects = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        status: "in_progress",
      })),
      { id: blockerProjectId, name: "Project 9", status: "in_progress" },
      { id: decisionProjectId, name: "Project 10", status: "in_progress" },
    ] as const;

    const blockerRecords = [
      ...Array.from({ length: 8 }, (_, index) =>
        createResultRecord({
          id: `blocker-${index + 1}`,
          kind: "blocker",
          scopeRefId: `project-${index + 1}`,
          title: `Blocker ${index + 1}`,
          updatedAt: new Date(`2026-03-08T0${8 - index}:00:00.000Z`),
        }),
      ),
      createResultRecord({
        id: "blocker-9",
        kind: "blocker",
        scopeRefId: blockerProjectId,
        title: "Hidden blocker",
        summary: "Late-arriving blocker",
        updatedAt: new Date("2026-03-07T23:59:00.000Z"),
      }),
    ];
    const decisionRecords = [
      ...Array.from({ length: 8 }, (_, index) =>
        createPlanRecord({
          id: `decision-${index + 1}`,
          scopeRefId: `project-${index + 1}`,
          title: `Decision ${index + 1}`,
          decisionDueAt: new Date(`2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
          updatedAt: new Date(`2026-03-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
        }),
      ),
      createPlanRecord({
        id: "decision-9",
        scopeRefId: decisionProjectId,
        title: "Late decision",
        decisionDueAt: new Date("2026-03-31T00:00:00.000Z"),
        updatedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
    ];

    const projectHealth = summarizeProjectHealth(scopedProjects, [], blockerRecords, decisionRecords);

    expect(projectHealth.find((entry) => entry.projectId === blockerProjectId)).toMatchObject({
      healthStatus: "red",
      currentBlocker: "Late-arriving blocker",
    });
    expect(projectHealth.find((entry) => entry.projectId === decisionProjectId)).toMatchObject({
      healthStatus: "yellow",
      nextDecision: expect.objectContaining({ id: "decision-9", title: "Late decision" }),
    });
  });
});
