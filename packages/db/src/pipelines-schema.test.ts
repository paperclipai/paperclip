import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  routines,
} from "./index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline schema tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function expectConstraintError(action: () => Promise<unknown>) {
  return expect(action()).rejects.toThrow("Failed query");
}

describeEmbeddedPostgres("pipeline schema", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-schema-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists one row per pipeline table and enforces unique keys and required checks", async () => {
    const [company] = await db.insert(companies).values({ name: "Pipeline Co", issuePrefix: "PIP" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Pipeline Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Draft content",
      assigneeAgentId: agent.id,
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Work linked to a case",
    }).returning();
    const [document] = await db.insert(documents).values({
      companyId: company.id,
      title: "Pipeline guidance",
      latestBody: "Use the launch rubric.",
    }).returning();

    const [pipeline] = await db.insert(pipelines).values({
      companyId: company.id,
      key: "content",
      name: "Content",
      createdByAgentId: agent.id,
    }).returning();
    await expectConstraintError(
      () => db.insert(pipelines).values({ companyId: company.id, key: "content", name: "Duplicate" }),
    );

    const [intakeStage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline.id,
      key: "intake",
      name: "Intake",
      kind: "working",
      position: 0,
    }).returning();
    const [reviewStage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline.id,
      key: "review",
      name: "Review",
      kind: "review",
      position: 1,
    }).returning();
    await expectConstraintError(
      () => db.insert(pipelineStages).values({
        pipelineId: pipeline.id,
        key: "intake",
        name: "Duplicate Intake",
        kind: "working",
        position: 2,
      }),
    );
    await expectConstraintError(
      () => db.insert(pipelineStages).values({
        pipelineId: pipeline.id,
        key: "invalid",
        name: "Invalid",
        kind: "waiting",
        position: 3,
      }),
    );

    await db.insert(pipelineTransitions).values({
      pipelineId: pipeline.id,
      fromStageId: intakeStage.id,
      toStageId: reviewStage.id,
      label: "Send to review",
    });
    await expectConstraintError(
      () => db.insert(pipelineTransitions).values({
        pipelineId: pipeline.id,
        fromStageId: intakeStage.id,
        toStageId: reviewStage.id,
      }),
    );

    const [rootCase] = await db.insert(pipelineCases).values({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: intakeStage.id,
      caseKey: "release-1",
      title: "Release 1",
      fields: { channel: "blog" },
      workspaceRef: { path: "content/release-1" },
      createdByAgentId: agent.id,
    }).returning();
    const [childCase] = await db.insert(pipelineCases).values({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: intakeStage.id,
      caseKey: "release-1/blog",
      title: "Release 1 blog post",
      parentCaseId: rootCase.id,
    }).returning();
    await expectConstraintError(
      () => db.insert(pipelineCases).values({
        companyId: company.id,
        pipelineId: pipeline.id,
        stageId: intakeStage.id,
        caseKey: "release-1",
        title: "Duplicate case",
      }),
    );

    const [event] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: rootCase.id,
      type: "ingested",
      actorType: "agent",
      actorAgentId: agent.id,
      runId: "00000000-0000-4000-8000-000000000001",
      toStageId: intakeStage.id,
      payload: { source: "test" },
    }).returning();
    await expectConstraintError(
      () => db.insert(pipelineCaseEvents).values({
        companyId: company.id,
        caseId: rootCase.id,
        type: "updated",
        actorType: "agent",
        actorAgentId: agent.id,
      }),
    );

    await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: rootCase.id,
      issueId: issue.id,
      role: "origin",
      createdByRunId: event.runId,
    });
    await expectConstraintError(
      () => db.insert(pipelineCaseIssueLinks).values({
        companyId: company.id,
        caseId: rootCase.id,
        issueId: issue.id,
        role: "work",
      }),
    );

    await db.insert(pipelineCaseBlockers).values({
      companyId: company.id,
      caseId: childCase.id,
      blockedByCaseId: rootCase.id,
    });
    await expectConstraintError(
      () => db.insert(pipelineCaseBlockers).values({
        companyId: company.id,
        caseId: childCase.id,
        blockedByCaseId: rootCase.id,
      }),
    );
    await expectConstraintError(
      () => db.insert(pipelineCaseBlockers).values({
        companyId: company.id,
        caseId: rootCase.id,
        blockedByCaseId: rootCase.id,
      }),
    );

    await db.insert(pipelineDocuments).values({
      companyId: company.id,
      pipelineId: pipeline.id,
      documentId: document.id,
      key: "guidance",
    });
    await expectConstraintError(
      () => db.insert(pipelineDocuments).values({
        companyId: company.id,
        pipelineId: pipeline.id,
        documentId: document.id,
        key: "guidance-duplicate-document",
      }),
    );
    const [secondDocument] = await db.insert(documents).values({
      companyId: company.id,
      title: "Duplicate guidance",
      latestBody: "Duplicate key.",
    }).returning();
    await expectConstraintError(
      () => db.insert(pipelineDocuments).values({
        companyId: company.id,
        pipelineId: pipeline.id,
        documentId: secondDocument.id,
        key: "guidance",
      }),
    );

    await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: rootCase.id,
      automationId: "draft-on-enter",
      triggeringEventId: event.id,
      routineId: routine.id,
      status: "succeeded",
      executionIssueId: issue.id,
    });
    await expectConstraintError(
      () => db.insert(pipelineAutomationExecutions).values({
        companyId: company.id,
        caseId: rootCase.id,
        automationId: "draft-on-enter",
        triggeringEventId: event.id,
        routineId: routine.id,
        status: "failed",
      }),
    );
  });
});
