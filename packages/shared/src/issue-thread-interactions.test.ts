import { describe, expect, it } from "vitest";
import {
  acceptIssueThreadInteractionSchema,
  askUserQuestionsResultSchema,
  createIssueThreadInteractionSchema,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
  submitIssueThreadInteractionVerdictsSchema,
} from "./validators/issue.js";

describe("issue thread interaction schemas", () => {
  it("parses request_confirmation payloads with default no-wake continuation", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Revise",
        rejectRequiresReason: true,
        rejectReasonLabel: "What needs to change?",
        declineReasonPlaceholder: "Optional: tell the agent what you'd change.",
        detailsMarkdown: "The current plan document will be accepted as-is.",
        supersedeOnUserComment: true,
      },
    });

    expect(parsed).toMatchObject({
      kind: "request_confirmation",
      continuationPolicy: "none",
      payload: {
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Revise",
        rejectRequiresReason: true,
        rejectReasonLabel: "What needs to change?",
        allowDeclineReason: true,
        declineReasonPlaceholder: "Optional: tell the agent what you'd change.",
        supersedeOnUserComment: true,
      },
    });
  });

  it("round-trips versioned tool action payload and lifecycle metadata", () => {
    const payload = requestConfirmationPayloadSchema.parse({
      version: 1,
      prompt: "Approve send_email?",
      toolAction: {
        version: 1,
        actionRequestId: "11111111-1111-4111-8111-111111111111",
        invocationId: "22222222-2222-4222-8222-222222222222",
        toolName: "send_email",
        toolDisplayName: "Send email",
        connectionId: "33333333-3333-4333-8333-333333333333",
        applicationId: "44444444-4444-4444-8444-444444444444",
        appDisplayName: "Gmail",
        risk: "write",
        previewMarkdown: "Send an email to the reviewed recipient.",
        argumentsSummaryJson: '{"to":"recipient@example.com"}',
        argumentsHash: "reviewed-arguments-hash",
        expiresAt: "2026-07-12T16:00:00.000Z",
      },
    });
    const result = requestConfirmationResultSchema.parse({
      version: 1,
      outcome: "accepted",
      toolAction: {
        version: 1,
        status: "executed",
        errorCode: null,
        errorMessage: null,
        updatedAt: "2026-07-12T15:05:00.000Z",
      },
    });

    expect(payload.toolAction).toMatchObject({
      version: 1,
      toolDisplayName: "Send email",
      risk: "write",
      argumentsHash: "reviewed-arguments-hash",
    });
    expect(result.toolAction).toMatchObject({ version: 1, status: "executed" });
    expect(requestConfirmationPayloadSchema.parse({ version: 1, prompt: "Legacy confirmation?" }).toolAction)
      .toBeUndefined();
  });

  it("accepts issue document targets for request_confirmation interactions", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Accept the latest plan revision?",
        allowDeclineReason: false,
        target: {
          type: "issue_document",
          issueId: "11111111-1111-4111-8111-111111111111",
          documentId: "22222222-2222-4222-8222-222222222222",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 2,
          label: "Plan v2",
          href: "/issues/PAP-123#document-plan",
        },
      },
    });

    expect(parsed.kind).toBe("request_confirmation");
    if (parsed.kind !== "request_confirmation") return;
    expect(parsed.payload.target).toMatchObject({
      type: "issue_document",
      key: "plan",
      revisionNumber: 2,
      label: "Plan v2",
      href: "/issues/PAP-123#document-plan",
    });
  });

  it("accepts custom targets for request_confirmation interactions", () => {
    for (const href of [
      "https://example.com/checklist",
      "http://example.com/checklist",
      "/PAP/issues/PAP-123#document-plan",
      "#document-plan",
    ]) {
      const parsed = createIssueThreadInteractionSchema.parse({
        kind: "request_confirmation",
        payload: {
          version: 1,
          prompt: "Proceed with the external checklist?",
          target: {
            type: "custom",
            key: "external-checklist",
            revisionId: "checklist-v1",
            revisionNumber: 1,
            label: "Checklist v1",
            href,
          },
        },
      });

      expect(parsed.kind).toBe("request_confirmation");
      if (parsed.kind !== "request_confirmation") return;
      expect(parsed.payload.target).toMatchObject({
        type: "custom",
        key: "external-checklist",
        label: "Checklist v1",
        href,
      });
    }
  });

  it("parses ask_user_questions supersede flags and expired results", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "ask_user_questions",
      payload: {
        version: 1,
        title: "Choose scope",
        supersedeOnUserComment: false,
        questions: [
          {
            id: "scope",
            prompt: "Which scope should I use?",
            selectionMode: "single",
            options: [{ id: "small", label: "Small" }],
          },
        ],
      },
    });

    expect(parsed).toMatchObject({
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        supersedeOnUserComment: false,
      },
    });

    expect(askUserQuestionsResultSchema.parse({
      version: 1,
      answers: [],
      expirationReason: "superseded_by_comment",
      commentId: "11111111-1111-4111-8111-111111111111",
      summaryMarkdown: null,
    })).toMatchObject({
      expirationReason: "superseded_by_comment",
      commentId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects unsafe request_confirmation target hrefs", () => {
    const base = {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed?",
        target: {
          type: "custom",
          key: "external-checklist",
          revisionId: "checklist-v1",
          label: "Checklist v1",
        },
      },
    } as const;

    for (const href of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "//evil.example/path",
      "file:///tmp/x",
      "mailto:user@example.com",
      "slack://channel?id=1",
      "vscode://file/tmp/x",
      "ftp://example.com/file",
    ]) {
      expect(() => createIssueThreadInteractionSchema.parse({
        ...base,
        payload: {
          ...base.payload,
          target: {
            ...base.payload.target,
            href,
          },
        },
      })).toThrow("href must be a root-relative path, same-page fragment, or http(s) URL");
    }
  });

  it("parses request_checkbox_confirmation payloads with checkbox defaults", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which items should be archived?",
        options: [
          { id: "item-1", label: "Draft report" },
          { id: "item-2", label: "Old screenshot", description: "Captured during QA." },
        ],
        defaultSelectedOptionIds: ["item-2"],
        minSelected: 0,
        maxSelected: 2,
        acceptLabel: "Archive selected",
        rejectRequiresReason: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 2,
        },
      },
    });

    expect(parsed).toMatchObject({
      kind: "request_checkbox_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        allowDeclineReason: true,
        defaultSelectedOptionIds: ["item-2"],
        minSelected: 0,
        maxSelected: 2,
      },
    });
  });

  it("rejects invalid request_checkbox_confirmation option references and bounds", () => {
    const base = {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which items should be archived?",
        options: [
          { id: "item-1", label: "Draft report" },
          { id: "item-2", label: "Old screenshot" },
        ],
      },
    } as const;

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        options: [
          { id: "item-1", label: "Draft report" },
          { id: "item-1", label: "Duplicate" },
        ],
      },
    })).toThrow("Option ids must be unique within one checkbox confirmation");

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        defaultSelectedOptionIds: ["missing"],
      },
    })).toThrow("defaultSelectedOptionIds must reference existing option ids");

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        defaultSelectedOptionIds: ["item-1"],
        minSelected: 2,
      },
    })).toThrow("defaultSelectedOptionIds must satisfy minSelected");

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        minSelected: 2,
        maxSelected: 1,
      },
    })).toThrow("maxSelected must be greater than or equal to minSelected");
  });

  it("rejects unsafe request_checkbox_confirmation target hrefs", () => {
    const base = {
      kind: "request_checkbox_confirmation",
      payload: {
        version: 1,
        prompt: "Which items should be archived?",
        options: [{ id: "item-1", label: "Draft report" }],
        target: {
          type: "custom",
          key: "external-checklist",
          revisionId: "checklist-v1",
          label: "Checklist v1",
        },
      },
    } as const;

    for (const href of ["file:///tmp/x", "slack://channel?id=1", "vscode://file/tmp/x"]) {
      expect(() => createIssueThreadInteractionSchema.parse({
        ...base,
        payload: {
          ...base.payload,
          target: {
            ...base.payload.target,
            href,
          },
        },
      })).toThrow("href must be a root-relative path, same-page fragment, or http(s) URL");
    }
  });

  it("accepts empty checkbox selections and rejects duplicate selected option ids", () => {
    expect(acceptIssueThreadInteractionSchema.parse({ selectedOptionIds: [] })).toEqual({
      selectedOptionIds: [],
    });

    expect(() => acceptIssueThreadInteractionSchema.parse({
      selectedOptionIds: ["item-1", "item-1"],
    })).toThrow("selectedOptionIds must be unique");
  });

  it("parses request_item_verdicts payloads with defaults", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review these generated items.",
        items: [
          { id: "api", label: "API route", description: "Server submit endpoint" },
          { id: "docs", label: "Docs", previewMarkdown: "Document the route." },
        ],
      },
    });

    expect(parsed).toMatchObject({
      kind: "request_item_verdicts",
      continuationPolicy: "wake_assignee",
      payload: {
        verdicts: ["approve", "reject"],
        requireReasonOn: ["reject"],
        allowBulkApprove: true,
      },
    });
  });

  it("accepts request_item_verdicts defer when enabled explicitly", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review these generated items.",
        items: [{ id: "api", label: "API route" }],
        verdicts: ["approve", "reject", "defer"],
        requireReasonOn: ["reject", "defer"],
      },
    });

    expect(parsed).toMatchObject({
      kind: "request_item_verdicts",
      payload: {
        verdicts: ["approve", "reject", "defer"],
        requireReasonOn: ["reject", "defer"],
      },
    });
  });

  it("rejects invalid request_item_verdicts item and reason references", () => {
    const base = {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review these generated items.",
        items: [
          { id: "api", label: "API route" },
          { id: "docs", label: "Docs" },
        ],
      },
    } as const;

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        items: [],
      },
    })).toThrow();

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        items: [
          { id: "api", label: "API route" },
          { id: "api", label: "Duplicate" },
        ],
      },
    })).toThrow("Item ids must be unique within one item verdict request");

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        items: Array.from({ length: 201 }, (_value, index) => ({
          id: `item-${index}`,
          label: `Item ${index}`,
        })),
      },
    })).toThrow();

    expect(() => createIssueThreadInteractionSchema.parse({
      ...base,
      payload: {
        ...base.payload,
        verdicts: ["approve", "reject"],
        requireReasonOn: ["defer"],
      },
    })).toThrow("requireReasonOn must reference enabled verdicts");
  });

  it("rejects duplicate request_item_verdicts submit ids", () => {
    expect(() => submitIssueThreadInteractionVerdictsSchema.parse({
      verdicts: [
        { id: "api", verdict: "approve" },
        { id: "api", verdict: "reject", reason: "Needs revision" },
      ],
    })).toThrow("verdict item ids must be unique");
  });
});
