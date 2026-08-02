import type { LiveRunForIssue } from "../api/heartbeats";
import type {
  IssueChatComment,
  IssueChatTranscriptEntry,
} from "../lib/issue-chat-messages";
import type { IssueTimelineEvent } from "../lib/issue-timeline-events";
import type {
  AskUserQuestionsInteraction,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  RequestConfirmationToolActionPayload,
  RequestItemVerdictsInteraction,
  SuggestTasksInteraction,
} from "../lib/issue-thread-interactions";

export const issueThreadInteractionFixtureMeta = {
  companyId: "company-storybook",
  projectId: "project-board-ui",
  issueId: "issue-thread-interactions",
  currentUserId: "user-board",
} as const;

function createComment(overrides: Partial<IssueChatComment>): IssueChatComment {
  const createdAt = overrides.createdAt ?? new Date("2026-04-20T14:00:00.000Z");
  return {
    id: "comment-default",
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    authorType: overrides.authorAgentId ? "agent" : "user",
    authorAgentId: null,
    authorUserId: issueThreadInteractionFixtureMeta.currentUserId,
    body: "",
    presentation: null,
    metadata: null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

function createSuggestTasksInteraction(
  overrides: Partial<SuggestTasksInteraction>,
): SuggestTasksInteraction {
  return {
    id: "interaction-suggest-default",
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    kind: "suggest_tasks",
    title: "Suggested issue tree for the first interaction pass",
    summary:
      "Draft task creation stays pending until a reviewer accepts it, so the thread can preview structure without mutating the task system.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-20T14:11:00.000Z"),
    updatedAt: new Date("2026-04-20T14:11:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      defaultParentId: "PAP-1709",
      tasks: [
        {
          clientKey: "root-design",
          title: "Prototype issue-thread interaction cards",
          description:
            "Build render-only cards that sit in the issue feed and show suggested tasks before anything is persisted.",
          priority: "high",
          assigneeAgentId: "agent-codex",
          billingCode: "ui-research",
          labels: ["UI", "interaction"],
        },
        {
          clientKey: "child-stories",
          parentClientKey: "root-design",
          title: "Add Storybook coverage for acceptance and rejection states",
          description:
            "Cover pending, accepted, rejected, and collapsed-child previews in a fixture-backed story.",
          priority: "medium",
          assigneeAgentId: "agent-qa",
          labels: ["Storybook"],
        },
        {
          clientKey: "child-mixed-thread",
          parentClientKey: "root-design",
          title: "Prototype the mixed thread feed",
          description:
            "Show comments, activity, live runs, and interaction cards in one chronological feed.",
          priority: "medium",
          assigneeAgentId: "agent-codex",
          labels: ["Issue thread"],
        },
        {
          clientKey: "hidden-follow-up",
          parentClientKey: "child-mixed-thread",
          title: "Follow-up polish on spacing and answered summaries",
          description:
            "Collapse this under the visible task tree so the preview proves the hidden-descendant treatment.",
          priority: "low",
          hiddenInPreview: true,
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

function createAskUserQuestionsInteraction(
  overrides: Partial<AskUserQuestionsInteraction>,
): AskUserQuestionsInteraction {
  return {
    id: "interaction-questions-default",
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    kind: "ask_user_questions",
    title: "Resolve open UX decisions before Phase 1",
    summary:
      "This form stays local until the operator submits it, so the responsible only wakes once after the whole answer set is ready.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-20T14:18:00.000Z"),
    updatedAt: new Date("2026-04-20T14:18:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      title: "Before I wire the persistence layer, which preview behavior do you want?",
      submitLabel: "Send answers",
      questions: [
        {
          id: "collapse-depth",
          prompt: "How aggressive should the suggested-task preview collapse descendant work?",
          helpText:
            "We need enough context to review the tree without making the feed feel like a project plan.",
          selectionMode: "single",
          required: true,
          options: [
            {
              id: "visible-root",
              label: "Only collapse hidden descendants",
              description: "Keep top-level and visible child tasks expanded.",
            },
            {
              id: "collapse-all",
              label: "Collapse all descendants by default",
              description: "Show only root tasks until the operator expands the tree.",
            },
          ],
        },
        {
          id: "post-submit-summary",
          prompt: "What should the answered-state card emphasize after submission?",
          helpText: "Pick every summary treatment that would help future reviewers.",
          selectionMode: "multi",
          required: true,
          options: [
            {
              id: "answers-inline",
              label: "Inline answer pills",
              description: "Keep the exact operator choices visible under each question.",
            },
            {
              id: "summary-note",
              label: "Short markdown summary",
              description: "Add a compact narrative summary at the bottom of the card.",
            },
            {
              id: "resolver-meta",
              label: "Resolver metadata",
              description: "Show who answered and when without opening the raw thread.",
            },
          ],
        },
      ],
    },
    result: null,
    ...overrides,
  };
}

function createRequestConfirmationInteraction(
  overrides: Partial<RequestConfirmationInteraction>,
): RequestConfirmationInteraction {
  return {
    id: "interaction-confirmation-default",
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    kind: "request_confirmation",
    title: "Approve the proposed plan",
    summary:
      "The responsible is waiting on a direct board decision before continuing from the plan document.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-20T14:30:00.000Z"),
    updatedAt: new Date("2026-04-20T14:30:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Approve the plan and let the responsible start implementation?",
      acceptLabel: "Approve plan",
      rejectLabel: "Request revisions",
      rejectRequiresReason: true,
      rejectReasonLabel: "Describe the plan changes needed before approval",
      detailsMarkdown:
        "This confirmation watches the `plan` document revision so stale approvals are blocked if the plan changes.",
      supersedeOnUserComment: true,
      target: {
        type: "issue_document",
        issueId: issueThreadInteractionFixtureMeta.issueId,
        key: "plan",
        revisionId: "11111111-1111-4111-8111-111111111111",
        revisionNumber: 3,
      },
    },
    result: null,
    ...overrides,
  };
}

function createRequestCheckboxConfirmationInteraction(
  overrides: Partial<RequestCheckboxConfirmationInteraction>,
): RequestCheckboxConfirmationInteraction {
  return {
    id: "interaction-checkbox-default",
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    kind: "request_checkbox_confirmation",
    title: "Choose the stale drafts to delete",
    summary:
      "The agent found several stale draft documents and needs the board to confirm exactly which ones to remove.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-20T14:46:00.000Z"),
    updatedAt: new Date("2026-04-20T14:46:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Check the draft documents you want me to delete.",
      detailsMarkdown:
        "Only the checked items will be deleted. Leave an item unchecked to keep it for now.",
      options: [
        {
          id: "draft-march-report",
          label: "Old draft report",
          description: "Created by QA during the March test pass.",
        },
        {
          id: "draft-spec-v1",
          label: "Spec v1 (superseded)",
          description: "Replaced by the approved v2 specification.",
        },
        {
          id: "draft-scratch-notes",
          label: "Scratch notes",
          description: "Unstructured notes from the kickoff call.",
        },
        {
          id: "draft-import-sample",
          label: "Import sample fixture",
          description: "Temporary fixture used while wiring the importer.",
        },
      ],
      defaultSelectedOptionIds: [],
      minSelected: 0,
      maxSelected: null,
      acceptLabel: "Delete selected",
      rejectLabel: "Request changes",
      rejectRequiresReason: false,
    },
    result: null,
    ...overrides,
  };
}

export const pendingSuggestedTasksInteraction = createSuggestTasksInteraction({});

export const acceptedSuggestedTasksInteraction = createSuggestTasksInteraction({
  id: "interaction-suggest-accepted",
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:16:00.000Z"),
  updatedAt: new Date("2026-04-20T14:16:00.000Z"),
  result: {
    version: 1,
    createdTasks: [
      {
        clientKey: "root-design",
        issueId: "issue-created-1",
        identifier: "PAP-1713",
        title: "Prototype issue-thread interaction cards",
      },
      {
        clientKey: "child-stories",
        issueId: "issue-created-2",
        identifier: "PAP-1714",
        title: "Add Storybook coverage for acceptance and rejection states",
        parentIssueId: "issue-created-1",
        parentIdentifier: "PAP-1713",
      },
      {
        clientKey: "child-mixed-thread",
        issueId: "issue-created-3",
        identifier: "PAP-1715",
        title: "Prototype the mixed thread feed",
        parentIssueId: "issue-created-1",
        parentIdentifier: "PAP-1713",
      },
      {
        clientKey: "hidden-follow-up",
        issueId: "issue-created-4",
        identifier: "PAP-1716",
        title: "Follow-up polish on spacing and answered summaries",
        parentIssueId: "issue-created-3",
        parentIdentifier: "PAP-1715",
      },
    ],
  },
});

export const rejectedSuggestedTasksInteraction = createSuggestTasksInteraction({
  id: "interaction-suggest-rejected",
  status: "rejected",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:17:00.000Z"),
  updatedAt: new Date("2026-04-20T14:17:00.000Z"),
  result: {
    version: 1,
    rejectionReason:
      "Keep the first pass tighter. The hidden follow-on work is useful, but the acceptance story should stay focused on one visible root and one visible child.",
  },
});

export const pendingAskUserQuestionsInteraction = createAskUserQuestionsInteraction({});

export const answeredAskUserQuestionsInteraction = createAskUserQuestionsInteraction({
  id: "interaction-questions-answered",
  status: "answered",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:24:00.000Z"),
  updatedAt: new Date("2026-04-20T14:24:00.000Z"),
  result: {
    version: 1,
    answers: [
      {
        questionId: "collapse-depth",
        optionIds: ["visible-root"],
      },
      {
        questionId: "post-submit-summary",
        optionIds: ["answers-inline", "summary-note", "resolver-meta"],
      },
    ],
    summaryMarkdown: [
      "- Keep visible child tasks expanded when they are part of the main review path.",
      "- Preserve inline answer chips and resolver metadata in the answered state.",
      "- Add a short summary note so future reviewers understand the operator's intent without replaying the form.",
    ].join("\n"),
  },
});

export const commentExpiredAskUserQuestionsInteraction = createAskUserQuestionsInteraction({
  id: "interaction-questions-expired-comment",
  status: "expired",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:25:00.000Z"),
  updatedAt: new Date("2026-04-20T14:25:00.000Z"),
  result: {
    version: 1,
    answers: [],
    expirationReason: "superseded_by_comment",
    commentId: "22222222-2222-4222-8222-222222222222",
    summaryMarkdown: null,
  },
});

export const pendingRequestConfirmationInteraction = createRequestConfirmationInteraction({});

export const genericPendingRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-generic-pending",
  title: "Confirm next step",
  summary: "The responsible needs a lightweight yes or no before continuing.",
  continuationPolicy: "none",
  payload: {
    version: 1,
    prompt: "Continue with the current approach?",
  },
});

export const optionalDeclineRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-optional-decline",
  continuationPolicy: "none",
  payload: {
    version: 1,
    prompt: "Use the smaller implementation path?",
    acceptLabel: "Confirm",
    rejectLabel: "Decline",
    rejectRequiresReason: false,
    declineReasonPlaceholder: "Optional: tell the agent what you'd change.",
  },
});

export const disabledDeclineReasonRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-no-decline-reason",
  continuationPolicy: "none",
  payload: {
    version: 1,
    prompt: "Close this low-risk follow-up as unnecessary?",
    acceptLabel: "Close it",
    rejectLabel: "Keep it",
    allowDeclineReason: false,
  },
});

export const acceptedRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-accepted",
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:34:00.000Z"),
  updatedAt: new Date("2026-04-20T14:34:00.000Z"),
  result: {
    version: 1,
    outcome: "accepted",
  },
});

export const planApprovalAcceptedRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-plan-accepted",
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:34:00.000Z"),
  updatedAt: new Date("2026-04-20T14:34:00.000Z"),
  payload: {
    version: 1,
    prompt: "Approve the plan and let the responsible start implementation?",
    acceptLabel: "Approve plan",
    rejectLabel: "Request changes",
    rejectRequiresReason: true,
    declineReasonPlaceholder: "Optional: what would you like revised?",
    target: {
      type: "issue_document",
      issueId: issueThreadInteractionFixtureMeta.issueId,
      key: "plan",
      revisionId: "11111111-1111-4111-8111-111111111111",
      revisionNumber: 4,
    },
  },
  result: {
    version: 1,
    outcome: "accepted",
  },
});

export const planApprovalResumeFailedRequestConfirmationInteraction = createRequestConfirmationInteraction({
  ...planApprovalAcceptedRequestConfirmationInteraction,
  id: "interaction-confirmation-plan-resume-failed",
  result: {
    version: 1,
    outcome: "accepted",
    resumeFailure: {
      status: "needs_attention",
      errorCode: "adapter_failed",
      attempt: 3,
      maxAttempts: 3,
      runId: "11111111-1111-4111-8111-222222222222",
      recoveryActionId: "33333333-3333-4333-8333-333333333333",
      updatedAt: "2026-04-20T14:45:00.000Z",
    },
  },
});

export const rejectedRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-rejected",
  status: "rejected",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:36:00.000Z"),
  updatedAt: new Date("2026-04-20T14:36:00.000Z"),
  result: {
    version: 1,
    outcome: "rejected",
    reason: "Split the migration and UI work into separate reviewable steps.",
  },
});

export const rejectedNoReasonRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-rejected-no-reason",
  status: "rejected",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:37:00.000Z"),
  updatedAt: new Date("2026-04-20T14:37:00.000Z"),
  result: {
    version: 1,
    outcome: "rejected",
    reason: null,
  },
});

// ---------------------------------------------------------------------------
// MCP tool-approval fixtures (PAP-13745). A `request_confirmation` carrying a
// `payload.toolAction` block renders as the dedicated tool-approval card. The
// pending fixtures use a live `expiresAt` so the countdown renders meaningfully
// in Storybook; the destructive one sits inside the ~5-min urgent window.
// ---------------------------------------------------------------------------

function expiresInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

const sheetsToolActionBase: RequestConfirmationToolActionPayload = {
  version: 1,
  actionRequestId: "aaaaaaa1-1111-4111-8111-1111111111a1",
  invocationId: "bbbbbbb2-2222-4222-8222-2222222222b2",
  toolName: "google_sheets.append_row",
  toolDisplayName: "Append row to spreadsheet",
  connectionId: "ccccccc3-3333-4333-8333-3333333333c3",
  applicationId: "ddddddd4-4444-4444-8444-4444444444d4",
  appDisplayName: "Google Sheets",
  risk: "write" as const,
  previewMarkdown:
    "Add **1 row** to the **Q3 Growth Leads** sheet:\n\n"
    + "| Column | Value |\n| --- | --- |\n| Name | Priya Anand |\n| Company | Northwind |\n| Stage | Qualified |\n| Owner | growth-bot |",
  argumentsSummaryJson: JSON.stringify(
    {
      spreadsheetId: "1AbC…xyz",
      range: "Leads!A2:D2",
      values: [["Priya Anand", "Northwind", "Qualified", "growth-bot"]],
      apiKey: "[redacted]",
    },
    null,
    2,
  ),
  argumentsHash: "sha256:9f2c1a7be4d0c8a3",
  expiresAt: expiresInMinutes(42),
};

function createToolActionConfirmationInteraction(
  overrides: Partial<RequestConfirmationInteraction> & {
    toolAction?: Partial<RequestConfirmationToolActionPayload>;
  },
): RequestConfirmationInteraction {
  const { toolAction: toolActionOverrides, payload, ...rest } = overrides;
  return createRequestConfirmationInteraction({
    id: "interaction-tool-action-default",
    title: undefined,
    summary: undefined,
    createdByAgentId: "agent-codex",
    payload: {
      version: 1,
      prompt: "Approve running this tool call?",
      acceptLabel: "Approve & run",
      rejectLabel: "Decline",
      ...payload,
      toolAction: { ...sheetsToolActionBase, ...toolActionOverrides },
    },
    ...rest,
  });
}

export const pendingToolActionWriteInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-pending-write",
});

export const pendingToolActionDestructiveInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-pending-destructive",
  toolAction: {
    actionRequestId: "aaaaaaa5-5555-4555-8555-5555555555a5",
    invocationId: "bbbbbbb6-6666-4666-8666-6666666666b6",
    toolName: "google_sheets.delete_rows",
    toolDisplayName: "Delete rows from spreadsheet",
    risk: "destructive",
    previewMarkdown:
      "**Permanently delete 12 rows** (rows 30–41) from the **Q3 Growth Leads** sheet. "
      + "This cannot be undone.",
    argumentsSummaryJson: JSON.stringify(
      { spreadsheetId: "1AbC…xyz", range: "Leads!A30:D41", rowCount: 12 },
      null,
      2,
    ),
    argumentsHash: "sha256:1c4e77aa90b3f2d1",
    expiresAt: expiresInMinutes(4),
  },
});

export const runningToolActionInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-running",
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T15:02:00.000Z"),
  updatedAt: new Date("2026-04-20T15:02:00.000Z"),
  result: {
    version: 1,
    outcome: "accepted",
    toolAction: {
      version: 1,
      status: "approved",
      updatedAt: "2026-04-20T15:02:00.000Z",
    },
  },
});

export const executedToolActionInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-executed",
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T15:02:00.000Z"),
  updatedAt: new Date("2026-04-20T15:02:12.000Z"),
  result: {
    version: 1,
    outcome: "accepted",
    toolAction: {
      version: 1,
      status: "executed",
      resultSummary: "Row 42 added to “Q3 Growth Leads”.",
      resultHref: "https://docs.google.com/spreadsheets/d/1AbCxyz/edit#gid=0&range=A42",
      updatedAt: "2026-04-20T15:02:12.000Z",
    },
  },
});

export const failedToolActionInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-failed",
  status: "accepted",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T15:02:00.000Z"),
  updatedAt: new Date("2026-04-20T15:02:09.000Z"),
  result: {
    version: 1,
    outcome: "accepted",
    toolAction: {
      version: 1,
      status: "failed",
      errorCode: "insufficient_permission",
      errorMessage:
        "The caller does not have permission to edit this spreadsheet (Google API 403). "
        + "Ask the sheet owner to grant edit access to the connected account.",
      updatedAt: "2026-04-20T15:02:09.000Z",
    },
  },
});

export const declinedToolActionInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-declined",
  status: "rejected",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T15:01:00.000Z"),
  updatedAt: new Date("2026-04-20T15:01:00.000Z"),
  result: {
    version: 1,
    outcome: "rejected",
    reason: "We don't add leads to this sheet manually — use the CRM sync instead.",
  },
});

export const expiredToolActionInteraction = createToolActionConfirmationInteraction({
  id: "interaction-tool-action-expired",
  status: "expired",
  updatedAt: new Date("2026-04-20T16:00:00.000Z"),
  resolvedAt: new Date("2026-04-20T16:00:00.000Z"),
  toolAction: {
    expiresAt: "2026-04-20T16:00:00.000Z",
  },
  result: {
    version: 1,
    outcome: "superseded_by_comment",
    toolAction: {
      version: 1,
      status: "expired",
      updatedAt: "2026-04-20T16:00:00.000Z",
    },
  },
});

export const commentExpiredRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-expired-comment",
  status: "expired",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T14:38:00.000Z"),
  updatedAt: new Date("2026-04-20T14:38:00.000Z"),
  result: {
    version: 1,
    outcome: "superseded_by_comment",
    commentId: "22222222-2222-4222-8222-222222222222",
  },
});

export const staleTargetRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-expired-target",
  status: "expired",
  resolvedByAgentId: "agent-codex",
  resolvedAt: new Date("2026-04-20T14:40:00.000Z"),
  updatedAt: new Date("2026-04-20T14:40:00.000Z"),
  payload: {
    version: 1,
    prompt: "Approve the plan and let the responsible start implementation?",
    acceptLabel: "Approve plan",
    rejectLabel: "Request revisions",
    rejectRequiresReason: true,
    target: {
      type: "issue_document",
      issueId: issueThreadInteractionFixtureMeta.issueId,
      key: "plan",
      revisionId: "44444444-4444-4444-8444-444444444444",
      revisionNumber: 4,
    },
  },
  result: {
    version: 1,
    outcome: "stale_target",
    staleTarget: {
      type: "issue_document",
      issueId: issueThreadInteractionFixtureMeta.issueId,
      key: "plan",
      revisionId: "11111111-1111-4111-8111-111111111111",
      revisionNumber: 3,
    },
  },
});

export const failedRequestConfirmationInteraction = createRequestConfirmationInteraction({
  id: "interaction-confirmation-failed",
  status: "failed",
  updatedAt: new Date("2026-04-20T14:42:00.000Z"),
});

export const pendingRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({});

export const boundedRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({
    id: "interaction-checkbox-bounded",
    title: "Pick the regions to deploy first",
    summary: "Choose between two and three regions for the Phase 1 rollout.",
    payload: {
      version: 1,
      prompt: "Which regions should we deploy to initially?",
      detailsMarkdown: "Select at least 2 and at most 3 regions.",
      options: [
        { id: "us-west", label: "US West (Oregon)", description: "Lowest latency for our primary user base." },
        { id: "us-east", label: "US East (Virginia)", description: "Redundancy and east coast coverage." },
        { id: "eu-west", label: "EU West (Ireland)", description: "GDPR compliance and European users." },
        { id: "ap-southeast", label: "AP Southeast (Singapore)", description: "Asia-Pacific expansion." },
      ],
      defaultSelectedOptionIds: ["us-west", "us-east"],
      minSelected: 2,
      maxSelected: 3,
      acceptLabel: "Confirm regions",
      rejectLabel: "Reconsider",
      rejectRequiresReason: true,
      rejectReasonLabel: "What should change about the region set?",
    },
  });

export const acceptedRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({
    id: "interaction-checkbox-accepted",
    status: "accepted",
    resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
    resolvedAt: new Date("2026-04-20T14:49:00.000Z"),
    updatedAt: new Date("2026-04-20T14:49:00.000Z"),
    result: {
      version: 1,
      outcome: "accepted",
      selectedOptionIds: ["draft-march-report", "draft-spec-v1"],
    },
  });

const manyOptionList = Array.from({ length: 100 }, (_, index) => {
  const number = index + 1;
  return {
    id: `record-${number}`,
    label: `Customer record #${number}`,
    description: number % 4 === 0
      ? "Flagged as a possible duplicate during the last import."
      : undefined,
  };
});

export const manyOptionsRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({
    id: "interaction-checkbox-many",
    title: "Select the customer records to archive",
    summary: "The cleanup job found 100 stale customer records. Confirm which ones to archive.",
    payload: {
      version: 1,
      prompt: "Check every customer record you want archived.",
      detailsMarkdown: "The list scrolls. Use Select all / Clear selection to move quickly.",
      options: manyOptionList,
      defaultSelectedOptionIds: [],
      minSelected: 0,
      maxSelected: null,
      acceptLabel: "Archive selected",
      rejectLabel: "Request changes",
      rejectRequiresReason: false,
    },
  });

export const acceptedManyRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({
    id: "interaction-checkbox-many-accepted",
    status: "accepted",
    title: "Select the customer records to archive",
    resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
    resolvedAt: new Date("2026-04-20T14:52:00.000Z"),
    updatedAt: new Date("2026-04-20T14:52:00.000Z"),
    payload: manyOptionsRequestCheckboxConfirmationInteraction.payload,
    result: {
      version: 1,
      outcome: "accepted",
      selectedOptionIds: manyOptionList.slice(0, 42).map((option) => option.id),
    },
  });

export const rejectedRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({
    id: "interaction-checkbox-rejected",
    status: "rejected",
    resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
    resolvedAt: new Date("2026-04-20T14:50:00.000Z"),
    updatedAt: new Date("2026-04-20T14:50:00.000Z"),
    result: {
      version: 1,
      outcome: "rejected",
      reason: "Don't delete anything yet — let me confirm with the data owner first.",
    },
  });

export const staleTargetRequestCheckboxConfirmationInteraction =
  createRequestCheckboxConfirmationInteraction({
    id: "interaction-checkbox-stale",
    status: "expired",
    resolvedByAgentId: "agent-codex",
    resolvedAt: new Date("2026-04-20T14:51:00.000Z"),
    updatedAt: new Date("2026-04-20T14:51:00.000Z"),
    payload: {
      version: 1,
      prompt: "Check the draft documents you want me to delete.",
      acceptLabel: "Delete selected",
      rejectLabel: "Request changes",
      options: [
        { id: "draft-march-report", label: "Old draft report" },
        { id: "draft-spec-v1", label: "Spec v1 (superseded)" },
      ],
      target: {
        type: "issue_document",
        issueId: issueThreadInteractionFixtureMeta.issueId,
        key: "plan",
        revisionId: "44444444-4444-4444-8444-444444444444",
        revisionNumber: 4,
      },
    },
    result: {
      version: 1,
      outcome: "stale_target",
      staleTarget: {
        type: "issue_document",
        issueId: issueThreadInteractionFixtureMeta.issueId,
        key: "plan",
        revisionId: "11111111-1111-4111-8111-111111111111",
        revisionNumber: 3,
      },
    },
  });

// --- Per-item verdicts (C3, PAP-13249) ---------------------------------

function createRequestItemVerdictsInteraction(
  overrides: Partial<RequestItemVerdictsInteraction>,
): RequestItemVerdictsInteraction {
  return {
    id: "interaction-verdicts-default",
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    kind: "request_item_verdicts",
    title: "Review 5 blog posts",
    summary:
      "This task drafted five blog posts. Approve the ones that are ready and reject the rest with a reason — each decision fans out on its own.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-20T15:02:00.000Z"),
    updatedAt: new Date("2026-04-20T15:02:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Review the 5 blog posts this task drafted.",
      detailsMarkdown:
        "Each approved post publishes immediately; rejected posts go back for a revision pass with your reason attached.",
      items: [
        {
          id: "post-spring-recap",
          label: "Spring launch recap",
          description: "820 words · product marketing",
          previewMarkdown: "**Spring launch recap** — a warm retrospective on the Q1 launch and what shipped.",
          href: "/PAP/issues/PAP-9001",
        },
        {
          id: "post-changelog-digest",
          label: "Monthly changelog digest",
          description: "540 words · engineering",
          previewMarkdown: "A tidy digest of the month's shipped changes, grouped by area.",
          href: "/PAP/issues/PAP-9002",
        },
        {
          id: "post-founder-note",
          label: "Founder's note on reliability",
          description: "1,100 words · leadership",
          previewMarkdown: "A candid note on the reliability push and the road ahead.",
          href: "/PAP/issues/PAP-9003",
        },
        {
          id: "post-customer-story",
          label: "Customer story: Northwind",
          description: "760 words · customer marketing",
          previewMarkdown: "How Northwind cut review time in half with the new workflow.",
          href: "/PAP/issues/PAP-9004",
        },
        {
          id: "post-hiring-push",
          label: "We're hiring: platform engineers",
          description: "420 words · recruiting",
          previewMarkdown: "An open call for platform engineers to join the team.",
          href: "/PAP/issues/PAP-9005",
        },
      ],
      verdicts: ["approve", "reject"],
      requireReasonOn: ["reject"],
      reasonLabel: "Why reject?",
      allowBulkApprove: true,
      supersedeOnUserComment: true,
    },
    result: null,
    ...overrides,
  };
}

/** S1 — expanded, all pending. */
export const pendingRequestItemVerdictsInteraction = createRequestItemVerdictsInteraction({});

/** S3/S4 — partial: two items applied (one approved, one rejected), three still actionable. */
export const partialRequestItemVerdictsInteraction = createRequestItemVerdictsInteraction({
  id: "interaction-verdicts-partial",
  updatedAt: new Date("2026-04-20T15:08:00.000Z"),
  result: {
    version: 1,
    outcome: "resolved",
    complete: false,
    items: [
      {
        id: "post-spring-recap",
        verdict: "approve",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:08:00.000Z"),
      },
      {
        id: "post-changelog-digest",
        verdict: "reject",
        reason: "Tone is off-brand — too dry. Warm it up and re-submit.",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:08:00.000Z"),
      },
    ],
  },
});

/** S5 — complete: every item has a terminal verdict. */
export const completeRequestItemVerdictsInteraction = createRequestItemVerdictsInteraction({
  id: "interaction-verdicts-complete",
  status: "answered",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T15:14:00.000Z"),
  updatedAt: new Date("2026-04-20T15:14:00.000Z"),
  result: {
    version: 1,
    outcome: "resolved",
    complete: true,
    items: [
      {
        id: "post-spring-recap",
        verdict: "approve",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:08:00.000Z"),
      },
      {
        id: "post-changelog-digest",
        verdict: "reject",
        reason: "Tone is off-brand — too dry. Warm it up and re-submit.",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:08:00.000Z"),
      },
      {
        id: "post-founder-note",
        verdict: "approve",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:14:00.000Z"),
      },
      {
        id: "post-customer-story",
        verdict: "approve",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:14:00.000Z"),
      },
      {
        id: "post-hiring-push",
        verdict: "reject",
        reason: "Hold the recruiting post until the req is approved.",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:14:00.000Z"),
      },
    ],
  },
});

/** S6 — superseded by a later comment after two items were already applied. */
export const supersededRequestItemVerdictsInteraction = createRequestItemVerdictsInteraction({
  id: "interaction-verdicts-superseded",
  status: "expired",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt: new Date("2026-04-20T15:16:00.000Z"),
  updatedAt: new Date("2026-04-20T15:16:00.000Z"),
  result: {
    version: 1,
    outcome: "superseded_by_comment",
    complete: false,
    commentId: "33333333-3333-4333-8333-333333333333",
    items: [
      {
        id: "post-spring-recap",
        verdict: "approve",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:08:00.000Z"),
      },
      {
        id: "post-changelog-digest",
        verdict: "reject",
        reason: "Tone is off-brand — too dry. Warm it up and re-submit.",
        resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
        resolvedAt: new Date("2026-04-20T15:08:00.000Z"),
      },
    ],
  },
});

/** S7 — long list (24 items) that virtualizes/paginates in the expanded view. */
const manyVerdictItems = Array.from({ length: 24 }, (_, index) => {
  const number = index + 1;
  return {
    id: `draft-post-${number}`,
    label: `Draft post #${number}`,
    description: `${300 + number * 17} words · auto-generated series`,
  };
});

export const manyItemsRequestItemVerdictsInteraction = createRequestItemVerdictsInteraction({
  id: "interaction-verdicts-many",
  title: "Review 24 generated posts",
  summary: "A batch-generation task produced 24 posts. Decide them in passes; the card stays until all are decided.",
  payload: {
    version: 1,
    prompt: "Review the 24 posts this batch produced.",
    detailsMarkdown: "The expanded list scrolls. Approve all to accept the batch, or decide item by item.",
    items: manyVerdictItems,
    verdicts: ["approve", "reject"],
    requireReasonOn: ["reject"],
    reasonLabel: "Why reject?",
    allowBulkApprove: true,
    supersedeOnUserComment: true,
  },
});

export const issueThreadInteractionComments: IssueChatComment[] = [
  createComment({
    id: "comment-thread-board",
    body: "Pressure-test first-class issue-thread interactions before we touch persistence. I want to see the cards in the real feed, not in a disconnected mock.",
    createdAt: new Date("2026-04-20T14:02:00.000Z"),
    updatedAt: new Date("2026-04-20T14:02:00.000Z"),
  }),
  createComment({
    id: "comment-thread-agent",
    authorAgentId: "agent-codex",
    authorUserId: null,
    body: "I found the existing issue chat surface and I am adding prototype-only interaction records so the Storybook review can happen before persistence work.",
    createdAt: new Date("2026-04-20T14:09:00.000Z"),
    updatedAt: new Date("2026-04-20T14:09:00.000Z"),
    runId: "run-thread-interaction",
    runAgentId: "agent-codex",
  }),
];

export const issueThreadInteractionEvents: IssueTimelineEvent[] = [
  {
    id: "event-thread-checkout",
    createdAt: new Date("2026-04-20T14:01:00.000Z"),
    actorType: "user",
    actorId: issueThreadInteractionFixtureMeta.currentUserId,
    statusChange: {
      from: "todo",
      to: "in_progress",
    },
  },
];

export const issueThreadInteractionLiveRuns: LiveRunForIssue[] = [
  {
    id: "run-thread-live",
    status: "running",
    invocationSource: "manual",
    triggerDetail: null,
    startedAt: "2026-04-20T14:26:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-20T14:26:00.000Z",
    agentId: "agent-codex",
    agentName: "CodexCoder",
    adapterType: "codex_local",
  },
];

export const issueThreadInteractionTranscriptsByRunId = new Map<
  string,
  readonly IssueChatTranscriptEntry[]
>([
  [
    "run-thread-live",
    [
      {
        kind: "assistant",
        ts: "2026-04-20T14:26:02.000Z",
        text: "Wiring the prototype interaction cards into the same issue feed that already renders comments and live runs.",
      },
      {
        kind: "thinking",
        ts: "2026-04-20T14:26:04.000Z",
        text: "Need to keep the payload shapes local to the UI layer so Phase 0 stays non-persistent.",
      },
    ],
  ],
]);

export const mixedIssueThreadInteractions = [
  acceptedSuggestedTasksInteraction,
  pendingRequestConfirmationInteraction,
  pendingAskUserQuestionsInteraction,
];
