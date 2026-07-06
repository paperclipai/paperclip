import { describe, expect, it } from "vitest";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

const canonicalWorkflowTargetDescription = [
  "Notes for the next agent.",
  "",
  "Workflow target: workflowId=CITAAAAAA-111, workflowKey=CITAAAAAA-112, capability=CITAAAAAA-113",
  "",
  "Keep the rest of the description intact.",
].join("\n");

describe("buildPaperclipWakePayload", () => {
  it("preserves issue description in the serialized paperclip wake issue payload", async () => {
    const payload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
      },
      issueSummary: {
        id: "issue-1",
        identifier: "CIT-21",
        title: "new feature",
        description: "create a public api in core-api to expose sensitive secrets",
        status: "in_progress",
        priority: "medium",
      },
    });

    expect(payload).toMatchObject({
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "CIT-21",
        title: "new feature",
        description: "create a public api in core-api to expose sensitive secrets",
        status: "in_progress",
        priority: "medium",
      },
    });
  });

  it("includes workflow bridge context when the wake is routed through a workflow", async () => {
    const payload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "workflow_invoked",
        workflowContext: {
          workflowId: "workflow-1",
          workflowKey: "content_strategist",
          capability: "content-strategist",
        },
      },
    });

    expect(payload).toMatchObject({
      reason: "workflow_invoked",
      workflowBridge: {
        workflowId: "workflow-1",
        workflowKey: "content_strategist",
        capability: "content-strategist",
      },
    });
  });

  it("materializes workflow bridge selectors from the issue description when the structured field is absent", async () => {
    const payload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "workflow_invoked",
      },
      issueSummary: {
        id: "issue-1",
        identifier: "CITAAAAAA-111",
        title: "workflow handoff",
        description: canonicalWorkflowTargetDescription,
        status: "in_progress",
        priority: "medium",
      },
    });

    expect(payload).toMatchObject({
      reason: "workflow_invoked",
      issue: {
        id: "issue-1",
        identifier: "CITAAAAAA-111",
        title: "workflow handoff",
        description: canonicalWorkflowTargetDescription,
        status: "in_progress",
        priority: "medium",
      },
      workflowBridge: {
        workflowId: "CITAAAAAA-111",
        workflowKey: "CITAAAAAA-112",
        capability: "CITAAAAAA-113",
      },
    });
  });

  it("does not materialize workflow bridge selectors from stale issue descriptions on non-workflow wakes", async () => {
    const payload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
      },
      issueSummary: {
        id: "issue-3",
        identifier: "CITAAAAAA-113",
        title: "assignment wake",
        description: canonicalWorkflowTargetDescription,
        status: "in_progress",
        priority: "medium",
      },
    });

    expect(payload).toMatchObject({
      reason: "issue_assigned",
      issue: {
        id: "issue-3",
        identifier: "CITAAAAAA-113",
        title: "assignment wake",
        description: canonicalWorkflowTargetDescription,
        status: "in_progress",
        priority: "medium",
      },
    });
    expect(payload?.workflowBridge).toBeNull();
  });

  it("keeps an explicit workflow bridge even when the description conflicts", async () => {
    const payload = await buildPaperclipWakePayload({
      db: {} as never,
      companyId: "company-1",
      contextSnapshot: {
        wakeReason: "workflow_invoked",
        workflowBridge: {
          workflowId: "workflow-explicit",
          workflowKey: "content_strategist",
          capability: "content-strategist",
        },
      },
      issueSummary: {
        id: "issue-2",
        identifier: "CITAAAAAA-112",
        title: "workflow handoff",
        description: canonicalWorkflowTargetDescription,
        status: "in_progress",
        priority: "medium",
      },
    });

    expect(payload).toMatchObject({
      workflowBridge: {
        workflowId: "workflow-explicit",
        workflowKey: "content_strategist",
        capability: "content-strategist",
      },
    });
  });
});
