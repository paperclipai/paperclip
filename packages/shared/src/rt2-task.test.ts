import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_TYPES,
  assignRt2ParticipantSchema,
  claimRt2ExecutionSchema,
  completeRt2ExecutionSchema,
  createOneLinerInboundDraftSchema,
  createRt2MessagingInboundSchema,
  rt2CaptureSourceEvidenceMetadataSchema,
  createRt2TaskSchema,
  createRt2TodoSchema,
  enqueueRt2ExecutionSchema,
  reviseRt2CaptureDraftSchema,
  transitionRt2CaptureDraftSchema,
} from "./index.js";

describe("RT2 task shared contracts", () => {
  it("rejects tasks with empty deliverables", () => {
    expect(() =>
      createRt2TaskSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        title: "Plan task engine",
        taskMode: "solo",
        capacity: 1,
        deliverables: [],
      }),
    ).toThrow();
  });

  it("rejects deliverables without base price", () => {
    expect(() =>
      createRt2TaskSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        title: "Plan task engine",
        taskMode: "solo",
        capacity: 1,
        deliverables: [
          {
            title: "Task brief",
            type: "document",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects todos without assigneeUserId", () => {
    expect(() =>
      createRt2TodoSchema.parse({
        taskIssueId: "550e8400-e29b-41d4-a716-446655440001",
        title: "Draft checklist",
        deliverables: [
          {
            title: "Checklist",
            type: "document",
            basePrice: 120000,
          },
        ],
      }),
    ).toThrow();
  });

  it("includes RT2 live event types", () => {
    expect(LIVE_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "rt2.task.updated",
        "rt2.participant.updated",
        "rt2.todo.updated",
        "rt2.deliverable.updated",
      ]),
    );
  });

  it("requires a participant userId for manager assignment", () => {
    expect(() => assignRt2ParticipantSchema.parse({})).toThrow();
    expect(assignRt2ParticipantSchema.parse({ userId: "user-1" })).toEqual({ userId: "user-1" });
  });

  it("validates RT2 execution lifecycle payloads", () => {
    expect(enqueueRt2ExecutionSchema.parse({})).toEqual({});
    expect(claimRt2ExecutionSchema.parse({ executorType: "jarvis", executorId: "jarvis-1" })).toEqual({
      executorType: "jarvis",
      executorId: "jarvis-1",
    });
    expect(() => completeRt2ExecutionSchema.parse({})).toThrow();
    expect(completeRt2ExecutionSchema.parse({ missingDeliverableReason: "manual result" })).toEqual({
      missingDeliverableReason: "manual result",
    });
  });

  it("accepts web, floating, voice, messenger, mobile, and native One-Liner inbound sources", () => {
    for (const source of ["web", "floating", "voice", "slack", "teams", "webhook", "mobile", "native"] as const) {
      expect(createOneLinerInboundDraftSchema.parse({
        source,
        text: "task: Capture field note; deliverable: note; price: 1000",
      })).toEqual({
        source,
        text: "task: Capture field note; deliverable: note; price: 1000",
      });
    }
  });

  it("accepts bounded messaging metadata without changing existing inbound source compatibility", () => {
    expect(createOneLinerInboundDraftSchema.parse({
      source: "slack",
      text: "task: Slack capture; deliverable: note; price: 1000",
      metadata: {
        channelId: "C123",
        teamId: "T123",
        ignoredNull: null,
        numericEvent: 42,
      },
    })).toEqual(expect.objectContaining({
      source: "slack",
      metadata: {
        channelId: "C123",
        teamId: "T123",
        numericEvent: "42",
      },
    }));

    expect(rt2CaptureSourceEvidenceMetadataSchema.parse({
      "  provider  ": "Slack",
      token: "x".repeat(700),
    })).toEqual({
      provider: "Slack",
    });
  });

  it("normalizes public messaging inbound payload fields", () => {
    expect(createRt2MessagingInboundSchema.parse({
      messageText: "task: Teams note; deliverable: summary; price: 1000",
      channelId: "19:abc",
      userId: "user-1",
      messageId: "message-1",
      teamId: "team-1",
      metadata: {
        tenantId: "tenant-1",
        providerLabel: "Teams",
      },
    })).toEqual(expect.objectContaining({
      messageText: "task: Teams note; deliverable: summary; price: 1000",
      channelId: "19:abc",
      userId: "user-1",
      messageId: "message-1",
      teamId: "team-1",
      metadata: {
        tenantId: "tenant-1",
        providerLabel: "Teams",
      },
    }));
  });

  it("validates persisted capture draft revision and transition payloads", () => {
    expect(reviseRt2CaptureDraftSchema.parse({
      snapshot: {
        taskTitle: "제안서 검수",
        todoTitle: "가격표 확인",
        deliverableTitle: "검수 메모",
        deliverableType: "document",
        basePrice: 120000,
        taskMode: "solo",
        capacity: 1,
        qualityHint: "검토 대기",
        okrCandidate: "매출 KPI",
      },
      changeSummary: "가격 힌트 수정",
    })).toEqual(expect.objectContaining({
      snapshot: expect.objectContaining({
        taskTitle: "제안서 검수",
        deliverableTitle: "검수 메모",
        basePrice: 120000,
      }),
      changeSummary: "가격 힌트 수정",
    }));

    expect(() => reviseRt2CaptureDraftSchema.parse({
      snapshot: {
        taskTitle: "",
        deliverableTitle: "검수 메모",
      },
    })).toThrow();

    expect(transitionRt2CaptureDraftSchema.parse({
      action: "hold",
      reason: "중복 여부 확인 필요",
    })).toEqual({
      action: "hold",
      reason: "중복 여부 확인 필요",
    });
    expect(transitionRt2CaptureDraftSchema.parse({ action: "mark_review_required" })).toEqual({
      action: "mark_review_required",
    });
    expect(() => transitionRt2CaptureDraftSchema.parse({ action: "reject" })).toThrow();
  });
});
