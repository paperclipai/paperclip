/**
 * Deterministic `fake`-mode fixtures for the Capability screenshot matrix
 * (contract §10.2). Every timestamp, identifier, and verdict is authored data
 * so two captures of the same slug are pixel-identical. Nothing here reads a
 * clock, a random source, or a locale.
 */

import type {
  CapabilityJsonValue,
  CapabilityEvidenceModel,
  CapabilityIssueThreadSnapshot,
  CapabilityThreadInteractionCard,
  CapabilityThreadItem,
  CapabilityThreadTurn,
} from "./types.js";
import { CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA, capabilityFormatBytes } from "./types.js";

export const CAPABILITY_UI_SHOT_SLUGS = [
  "thread-baseline",
  "turn-streaming",
  "interaction-question-pending",
  "interaction-confirmation-pending",
  "interaction-resolved-mixed",
  "denial-optional-tool",
  "document-revision",
  "deliverable-registered",
  "workspace-file-changes",
  "workspace-file-reference",
  "disposition-terminal",
  "debug-panel-open",
  "reconnect-banner",
  "replay-mode",
  "pe-structured-plan",
  "te-command-execution",
  "mp-mcp-progress",
  "rs-web-research",
  "da-subagent-delegation",
  "mr-model-routing",
  "cc-context-compaction",
  "ag-generated-artifact",
  "rv-review-mode",
  "hk-hook-lifecycle",
  "mc-memory-citations",
  "sr-safety-review",
  "ti-terminal-input",
  "wt-intentional-wait",
  "pn-provider-notices",
  "ax-acpx-lifecycle",
  "ax-acpx-permissions",
  "ax-acpx-tools",
  "ax-acpx-events",
  "ax-acpx-failures",
] as const;

export type CapabilityUiShotSlug = (typeof CAPABILITY_UI_SHOT_SLUGS)[number];

export const CAPABILITY_DEFAULT_FIXTURE_PROFILE = "hb-baseline";

const FIXTURE_CLOCK = "2026-08-09T09:00:00.000Z";
const AGENT = "Mock Engineer";
const BOARD_USER = "You (board user)";

function at(minute: number, second = 0): string {
  const stamp = new Date(Date.UTC(2026, 7, 9, 9, minute, second));
  return stamp.toISOString();
}

function baseEvidence(): CapabilityEvidenceModel {
  return {
    tools: [
      {
        id: "tools-turn-1",
        turnId: "turn-1",
        rows: [
          {
            operationId: "get_task_context",
            disposition: "always_agent_tool",
            grant: null,
            description: "Read the checked-out mock task, ancestors, wake, and budget.",
          },
          {
            operationId: "report_progress",
            disposition: "always_agent_tool",
            grant: null,
            description: "Append a durable progress comment to the mock thread.",
          },
          {
            operationId: "write_document",
            disposition: "always_agent_tool",
            grant: null,
            description: "Create or revise a mock task document.",
          },
          {
            operationId: "request_human_input",
            disposition: "always_agent_tool",
            grant: null,
            description: "Open a typed interaction for the board user.",
          },
          {
            operationId: "register_deliverable",
            disposition: "always_agent_tool",
            grant: null,
            description: "Register an artifact-backed deliverable on the mock task.",
          },
          {
            operationId: "finish_task",
            disposition: "always_agent_tool",
            grant: null,
            description: "Move the mock task to done with a summary.",
          },
          {
            operationId: "search_tasks",
            disposition: "optional_agent_tool",
            grant: "rf:read_or_write",
            description: "Scoped discovery across mock tasks.",
          },
          {
            operationId: "list_documents",
            disposition: "optional_agent_tool",
            grant: "rf:read_or_write",
            description: "List mock documents on the active task.",
          },
          {
            operationId: "create_task",
            disposition: "control_plane_owned",
            grant: null,
            description: "Not exposed: this fixture withholds su:read_or_write.",
          },
          {
            operationId: "decide_approval",
            disposition: "control_plane_owned",
            grant: null,
            description: "Not exposed: approval decisions stay with the control plane.",
          },
          {
            operationId: "generic_api_request",
            disposition: "control_plane_owned",
            grant: null,
            description: "Not exposed: the mock escape hatch is disabled by default.",
          },
        ],
      },
    ],
    calls: [
      {
        id: "call-1",
        turnId: "turn-1",
        operationId: "get_task_context",
        version: 1,
        providerRequest: 'tools/call get_task_context {"taskId":"task-31"}',
        dispatchedCommand: "control_plane.context(run-7g-1)",
        outcome: "ok",
        result: {
          identifier: "MCK-31",
          status: "in_progress",
          stateRevision: 1,
        },
        redactions: [],
        threadAnchorId: "item-tool-1",
      },
      {
        id: "call-2",
        turnId: "turn-1",
        operationId: "report_progress",
        version: 1,
        providerRequest: 'tools/call report_progress {"body":"Read the mock task…"}',
        dispatchedCommand: "control_plane.applyCommand(report_progress)",
        outcome: "ok",
        result: { commandKind: "report_progress", stateRevision: 2 },
        redactions: [],
        threadAnchorId: "item-tool-2",
      },
      {
        id: "call-3",
        turnId: "turn-2",
        operationId: "write_document",
        version: 1,
        providerRequest: 'tools/call write_document {"key":"plan","baseRevisionId":"rev-3"}',
        dispatchedCommand: "control_plane.applyCommand(write_document)",
        outcome: "ok",
        result: { commandKind: "write_document", revision: 4, stateRevision: 3 },
        redactions: ["workspace_path"],
        threadAnchorId: "item-tool-3",
      },
    ],
    authorization: [
      {
        id: "authz-1",
        turnId: "turn-1",
        operationId: "get_task_context",
        phase: "invocation",
        allowed: true,
        code: "allowed",
        reason: "Always-exposed operation for the checked-out task.",
        claimsConsidered: ["task:read"],
        redactions: [],
        stateChangeRef: null,
        threadAnchorId: "item-tool-1",
      },
      {
        id: "authz-2",
        turnId: "turn-1",
        operationId: "report_progress",
        phase: "invocation",
        allowed: true,
        code: "allowed",
        reason: "Assignee actor owns the checked-out task.",
        claimsConsidered: ["task:read", "task:comment"],
        redactions: [],
        stateChangeRef: "state-rev-2",
        threadAnchorId: "item-tool-2",
      },
      {
        id: "authz-3",
        turnId: "turn-2",
        operationId: "write_document",
        phase: "invocation",
        allowed: true,
        code: "allowed",
        reason: "Document write is always exposed for the active task.",
        claimsConsidered: ["task:read", "documents:write"],
        redactions: ["workspace_path"],
        stateChangeRef: "state-rev-3",
        threadAnchorId: "item-tool-3",
      },
    ],
    control_plane: [
      {
        id: "cp-1",
        turnId: "turn-1",
        category: "checkout",
        outcome: "allowed",
        reason: "Run run-7g-1 checked out MCK-31 for actor-1.",
        stateRevision: 1,
        threadAnchorId: "item-notice-1",
      },
      {
        id: "cp-2",
        turnId: "turn-1",
        category: "wake",
        outcome: "allowed",
        reason: "Wake issue_blockers_resolved delivered before turn 1.",
        stateRevision: 1,
        threadAnchorId: "item-notice-1",
      },
      {
        id: "cp-3",
        turnId: "turn-2",
        category: "idempotency",
        outcome: "duplicate",
        reason: "Retry of write_document reused command-3 without a second mutation.",
        stateRevision: 3,
        threadAnchorId: null,
      },
      {
        id: "cp-4",
        turnId: "turn-3",
        category: "budget",
        outcome: "allowed",
        reason: "Actor budget 412 of 1000 cents recorded; hard stop not reached.",
        stateRevision: 4,
        threadAnchorId: null,
      },
    ],
    runner: [
      {
        id: "ev-1",
        turnId: "turn-1",
        kind: "session.started",
        ordinal: 1,
        detail: "runnerd pid 4101 · process group 4101 · thread thr-mock-7g",
        details: [
          { label: "Runner", value: "runnerd" },
          { label: "State", value: "started" },
        ],
      },
      {
        id: "ev-2",
        turnId: "turn-1",
        kind: "turn.started",
        ordinal: 2,
        detail: "turn-1 · dynamic tools 8 exposed / 3 withheld",
        details: [
          { label: "State", value: "started" },
          { label: "Tools", value: "8 exposed, 3 withheld" },
        ],
      },
      {
        id: "ev-3",
        turnId: "turn-2",
        kind: "tool.dispatched",
        ordinal: 5,
        detail: "write_document → typed result revision 4",
        details: [
          { label: "Operation", value: "write_document" },
          { label: "Result", value: "typed result revision 4" },
        ],
      },
      {
        id: "ev-4",
        turnId: "turn-3",
        kind: "turn.completed",
        ordinal: 9,
        detail: "turn-3 · status completed · 1 tool call",
        details: [
          { label: "State", value: "completed" },
          { label: "Tool calls", value: "1" },
        ],
      },
    ],
    state: [
      {
        id: "diff-turn-1",
        turnId: "turn-1",
        fromRevision: 1,
        toRevision: 2,
        rows: [
          {
            entityClass: "comments",
            entityRef: "comment-12",
            before: "—",
            after: "report_progress · 214 bytes",
          },
          {
            entityClass: "run",
            entityRef: "run-7g-1",
            before: "status running · attempt 1",
            after: "status running · attempt 1",
          },
        ],
      },
      {
        id: "diff-turn-2",
        turnId: "turn-2",
        fromRevision: 2,
        toRevision: 3,
        rows: [
          {
            entityClass: "documents",
            entityRef: "doc-plan",
            before: "revision 3",
            after: "revision 4",
          },
          {
            entityClass: "audit",
            entityRef: "audit-9",
            before: "—",
            after: "write_document by actor-1",
          },
        ],
      },
    ],
    traceability: [
      {
        id: "trace-1",
        turnId: "turn-1",
        capabilityId: "hb-context-01",
        sourceAnchor: "skills/paperclip/SKILL.md#heartbeat-context",
        caseId: "hb-context-01",
        group: "heartbeat",
        browserEvidenceRecipe: "hb/hb-context-01",
        expectedSemanticOperations: ["get_task_context", "report_progress"],
        forbiddenOperations: ["generic_api_request", "decide_approval"],
        requiredCapabilityGrants: [],
      },
      {
        id: "trace-2",
        turnId: "turn-2",
        capabilityId: "dp-plan-doc-01",
        sourceAnchor: "skills/paperclip/reference/documents.md#plan-documents",
        caseId: "dp-plan-doc-01",
        group: "documents",
        browserEvidenceRecipe: "dp/dp-plan-doc-01",
        expectedSemanticOperations: ["write_document"],
        forbiddenOperations: ["generic_api_request"],
        requiredCapabilityGrants: [],
      },
    ],
    parity: [
      {
        id: "parity-1",
        turnId: "turn-1",
        assertion: "get_task_context returns the checked-out task and wake reason",
        verdict: "pass",
        note: null,
      },
      {
        id: "parity-2",
        turnId: "turn-1",
        assertion: "report_progress writes exactly one durable comment",
        verdict: "pass",
        note: null,
      },
      {
        id: "parity-3",
        turnId: "turn-2",
        assertion: "write_document advances the revision chain by one",
        verdict: "pass",
        note: null,
      },
      {
        id: "parity-4",
        turnId: "turn-2",
        assertion: "attachment byte upload is exercised end to end",
        verdict: "intentional_gap",
        note: "Capability registers deliverables by content ref; byte upload lands in future upload integration.",
      },
    ],
  };
}

function baselineTurns(): CapabilityThreadTurn[] {
  return [
    {
      id: "turn-1",
      ordinal: 1,
      mode: "fake",
      toolCallCount: 2,
      at: at(0),
      stoppedByUser: false,
      items: [
        {
          kind: "system_notice",
          id: "item-notice-1",
          at: at(0),
          glyph: "⚙",
          text: "Wake: issue_blockers_resolved → turn 1 started",
          evidenceRef: { section: "control_plane", recordId: "cp-2" },
        },
        {
          kind: "user_message",
          id: "item-user-1",
          at: at(0, 5),
          author: BOARD_USER,
          body: "Pick up MCK-31 and tell me where the runner spike stands.",
        },
        {
          kind: "agent_message",
          id: "item-agent-1",
          at: at(0, 18),
          author: AGENT,
          body:
            "Reading the checked-out task first so I quote its real state rather than guessing.",
          streaming: false,
        },
        {
          kind: "tool_activity",
          id: "item-tool-1",
          at: at(0, 20),
          status: "ok",
          operationId: "get_task_context",
          summary: "Read MCK-31 · status in_progress · wake issue_blockers_resolved",
          input: { taskId: "task-31" },
          result: { identifier: "MCK-31", status: "in_progress", stateRevision: 1 },
          evidenceRef: { section: "calls", recordId: "call-1" },
        },
        {
          kind: "tool_activity",
          id: "item-tool-2",
          at: at(0, 31),
          status: "ok",
          operationId: "report_progress",
          summary: "Recorded a progress comment · state revision 2",
          input: { body: "Read the mock task and confirmed the runner spike scope." },
          result: { commandKind: "report_progress", stateRevision: 2 },
          evidenceRef: { section: "calls", recordId: "call-2" },
        },
        {
          kind: "durable_comment",
          id: "item-comment-1",
          at: at(0, 31),
          author: AGENT,
          body:
            "Runner spike is scoped to the mock control plane. Next I will draft the plan document revision.",
          operationId: "report_progress",
          evidenceRef: { section: "calls", recordId: "call-2" },
        },
      ],
    },
    {
      id: "turn-2",
      ordinal: 2,
      mode: "fake",
      toolCallCount: 1,
      at: at(2),
      stoppedByUser: false,
      items: [
        {
          kind: "user_message",
          id: "item-user-2",
          at: at(2),
          author: BOARD_USER,
          body: "Draft the plan revision with the two open questions folded in.",
        },
        {
          kind: "agent_message",
          id: "item-agent-2",
          at: at(2, 14),
          author: AGENT,
          body: "Writing revision 4 of the plan document on top of revision 3.",
          streaming: false,
        },
        {
          kind: "tool_activity",
          id: "item-tool-3",
          at: at(2, 22),
          status: "ok",
          operationId: "write_document",
          summary: "plan · revision 3 → 4",
          input: { key: "plan", baseRevisionId: "rev-3" },
          result: { commandKind: "write_document", revision: 4, stateRevision: 3 },
          evidenceRef: { section: "calls", recordId: "call-3" },
        },
      ],
    },
    {
      id: "turn-3",
      ordinal: 3,
      mode: "fake",
      toolCallCount: 0,
      at: at(4),
      stoppedByUser: false,
      items: [
        {
          kind: "user_message",
          id: "item-user-3",
          at: at(4),
          author: BOARD_USER,
          body: "Good. Summarise what changed.",
        },
        {
          kind: "agent_message",
          id: "item-agent-3",
          at: at(4, 11),
          author: AGENT,
          body:
            "Revision 4 folds both open questions into the acceptance section and leaves the process boundary unchanged.",
          streaming: false,
        },
      ],
    },
  ];
}

function baseline(): CapabilityIssueThreadSnapshot {
  return {
    schema: CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA,
    sessionId: "session-7g-fixture",
    mode: "fake",
    identity: {
      agentLabel: "Fake agent",
      runnerLabel: "In-process runner",
      runnerAttached: true,
      controlPlaneLabel: "Mock Paperclip",
      controlPlaneTooltip: "All issue records are mock. No real Paperclip API is reachable.",
      replaySource: null,
    },
    issue: {
      identifier: "MCK-31",
      title: "Wire the runner spike to the mock control plane",
      status: "in_progress",
      priority: "high",
      assignee: AGENT,
      runState: "run-7g-1 · attempt 1",
      scenarioId: "hb-baseline",
      fixtureProfile: CAPABILITY_DEFAULT_FIXTURE_PROFILE,
    },
    turns: baselineTurns(),
    composer: {
      state: "ready",
      helper: null,
      reason: null,
      pendingInteractionId: null,
    },
    evidence: baseEvidence(),
    connection: { state: "connected", attempt: 0 },
    replay: null,
    renderedAt: FIXTURE_CLOCK,
  };
}

function interactionItem(
  card: CapabilityThreadInteractionCard,
  id: string,
  when: string,
): CapabilityThreadItem {
  return { kind: "interaction", id, at: when, ...card };
}

function questionsCard(
  state: CapabilityThreadInteractionCard["state"],
  overrides: Partial<CapabilityThreadInteractionCard> = {},
): CapabilityThreadInteractionCard {
  return {
    interactionId: "ix-questions-01",
    interactionKind: "questions",
    title: "Two scoping questions",
    prompt: "Answer both before I continue with the plan revision.",
    payload: {
      kind: "questions",
      submitLabel: "Submit answers",
      questions: [
        {
          id: "q1",
          prompt: "Should the spike own process cleanup?",
          control: "radio",
          options: ["Yes — runner owns it", "No — harness owns it"],
          required: true,
        },
        {
          id: "q2",
          prompt: "Which fixture profile should the demo default to?",
          control: "select",
          options: ["hb-baseline", "dp-documents", "ix-interactions"],
          required: true,
        },
        {
          id: "q3",
          prompt: "Anything else I should fold in?",
          control: "text",
          required: false,
        },
      ],
    },
    state,
    target: null,
    stateLabel: "Waiting for you",
    resolvedSummary: [],
    reason: null,
    supersededBy: null,
    evidenceRef: { section: "authorization", recordId: "authz-ix-1" },
    ...overrides,
  };
}

function confirmationCard(
  state: CapabilityThreadInteractionCard["state"],
  overrides: Partial<CapabilityThreadInteractionCard> = {},
): CapabilityThreadInteractionCard {
  return {
    interactionId: "ix-confirmation-plan-01",
    interactionKind: "confirmation",
    title: "Approve plan revision 4",
    prompt: "Revision 4 folds both scoping answers into the acceptance section.",
    payload: {
      kind: "confirmation",
      targetSummary: "plan · r4 — acceptance section rewritten, process boundary unchanged",
      acceptLabel: "Approve revision 4",
      rejectLabel: "Request changes",
      requireRejectReason: true,
    },
    state,
    target: { label: "plan · r4", href: "#/issue/hb-baseline?panel=state&rec=diff-turn-2" },
    stateLabel: "Waiting for you",
    resolvedSummary: [],
    reason: null,
    supersededBy: null,
    evidenceRef: { section: "authorization", recordId: "authz-ix-2" },
    ...overrides,
  };
}

const INTERACTION_AUTHORIZATION: CapabilityEvidenceModel["authorization"] = [
  {
    id: "authz-ix-1",
    turnId: "turn-3",
    operationId: "request_human_input",
    phase: "invocation",
    allowed: true,
    code: "allowed",
    reason: "Interaction kind questions is permitted by scenario hb-baseline.",
    claimsConsidered: ["task:read", "interactions:request"],
    redactions: [],
    stateChangeRef: "state-rev-4",
    threadAnchorId: "item-ix-1",
  },
  {
    id: "authz-ix-2",
    turnId: "turn-3",
    operationId: "request_human_input",
    phase: "invocation",
    allowed: true,
    code: "allowed",
    reason: "Interaction kind confirmation is permitted by scenario hb-baseline.",
    claimsConsidered: ["task:read", "interactions:request"],
    redactions: [],
    stateChangeRef: "state-rev-4",
    threadAnchorId: "item-ix-2",
  },
];

function withInteractionAuthorization(
  snapshot: CapabilityIssueThreadSnapshot,
): CapabilityIssueThreadSnapshot {
  snapshot.evidence.authorization = [
    ...snapshot.evidence.authorization,
    ...INTERACTION_AUTHORIZATION,
  ];
  return snapshot;
}

function lastTurn(snapshot: CapabilityIssueThreadSnapshot): CapabilityThreadTurn {
  const turn = snapshot.turns.at(-1);
  if (turn === undefined) {
    throw new Error("Capability fixture has no turns");
  }
  return turn;
}

const BUILDERS: Partial<Record<CapabilityUiShotSlug, () => CapabilityIssueThreadSnapshot>> = {
  "thread-baseline": baseline,

  "turn-streaming": () => {
    const snapshot = baseline();
    snapshot.turns.push({
      id: "turn-4",
      ordinal: 4,
      mode: "fake",
      toolCallCount: 1,
      at: at(6),
      stoppedByUser: false,
      items: [
        {
          kind: "user_message",
          id: "item-user-4",
          at: at(6),
          author: BOARD_USER,
          body: "Now check whether any dependent task is still open.",
        },
        {
          kind: "tool_activity",
          id: "item-tool-4",
          at: at(6, 6),
          status: "running",
          operationId: "search_tasks",
          summary: "Searching mock tasks blocked by MCK-31…",
          input: { query: "blockedBy:MCK-31" },
          result: null,
          evidenceRef: { section: "calls", recordId: "call-4" },
        },
        {
          kind: "agent_message",
          id: "item-agent-4",
          at: at(6, 9),
          author: AGENT,
          body: "Two dependent tasks are still open. The first one, MCK-32, is waiting on the",
          streaming: true,
        },
      ],
    });
    snapshot.evidence.calls.push({
      id: "call-4",
      turnId: "turn-4",
      operationId: "search_tasks",
      version: 1,
      providerRequest: 'tools/call search_tasks {"query":"blockedBy:MCK-31"}',
      dispatchedCommand: "control_plane.search(run-7g-1)",
      outcome: "ok",
      result: { matches: 2 },
      redactions: [],
      threadAnchorId: "item-tool-4",
    });
    snapshot.composer = {
      state: "streaming",
      helper: "Codex is working — send to steer, or stop the turn.",
      reason: null,
      pendingInteractionId: null,
    };
    return snapshot;
  },

  "interaction-question-pending": () => {
    const snapshot = withInteractionAuthorization(baseline());
    lastTurn(snapshot).items.push(
      interactionItem(questionsCard("pending"), "item-ix-1", at(4, 30)),
    );
    snapshot.composer = {
      state: "waiting",
      helper: "Answer the pending request above to continue.",
      reason: null,
      pendingInteractionId: "ix-questions-01",
    };
    return snapshot;
  },

  "interaction-confirmation-pending": () => {
    const snapshot = withInteractionAuthorization(baseline());
    lastTurn(snapshot).items.push(
      interactionItem(confirmationCard("pending"), "item-ix-2", at(4, 40)),
    );
    snapshot.composer = {
      state: "waiting",
      helper: "Answer the pending request above to continue.",
      reason: null,
      pendingInteractionId: "ix-confirmation-plan-01",
    };
    return snapshot;
  },

  "interaction-resolved-mixed": () => {
    const snapshot = withInteractionAuthorization(baseline());
    const turn = lastTurn(snapshot);
    turn.items.push(
      interactionItem(
        questionsCard("answered", {
          stateLabel: "Answered",
          resolvedSummary: [
            "Should the spike own process cleanup? — Yes — runner owns it",
            "Which fixture profile should the demo default to? — hb-baseline",
          ],
        }),
        "item-ix-1",
        at(4, 30),
      ),
      interactionItem(
        confirmationCard("accepted", {
          stateLabel: "Accepted",
          resolvedSummary: ["Approved plan · r4"],
        }),
        "item-ix-2",
        at(4, 40),
      ),
      interactionItem(
        confirmationCard("rejected", {
          interactionId: "ix-confirmation-plan-02",
          title: "Approve plan revision 5",
          state: "rejected",
          stateLabel: "Changes requested",
          reason: "Split the acceptance section before I approve the process boundary change.",
          target: { label: "plan · r5", href: "#/issue/hb-baseline?panel=state&rec=diff-turn-2" },
          evidenceRef: { section: "authorization", recordId: "authz-ix-2" },
        }),
        "item-ix-3",
        at(4, 50),
      ),
      interactionItem(
        confirmationCard("stale_target", {
          interactionId: "ix-confirmation-plan-03",
          title: "Approve plan revision 4",
          state: "stale_target",
          stateLabel: "Stale — plan moved to r5",
          supersededBy: {
            label: "plan · r5",
            href: "#/issue/hb-baseline?panel=state&rec=diff-turn-2",
          },
          evidenceRef: { section: "authorization", recordId: "authz-ix-2" },
        }),
        "item-ix-4",
        at(5, 0),
      ),
      interactionItem(
        questionsCard("superseded_by_comment", {
          interactionId: "ix-questions-02",
          title: "One scoping question",
          state: "superseded_by_comment",
          stateLabel: "Superseded by a later comment",
          supersededBy: { label: "comment-19", href: "#/issue/hb-baseline?rec=item-comment-1" },
          evidenceRef: { section: "authorization", recordId: "authz-ix-1" },
        }),
        "item-ix-5",
        at(5, 10),
      ),
    );
    return snapshot;
  },

  "denial-optional-tool": () => {
    const snapshot = baseline();
    const turn = lastTurn(snapshot);
    turn.toolCallCount = 1;
    turn.items.push(
      {
        kind: "denial",
        id: "item-denial-1",
        at: at(4, 24),
        operationId: "create_task",
        reason: "denied: missing grant su:read_or_write",
        evidenceRef: { section: "authorization", recordId: "authz-deny-1" },
      },
      {
        kind: "agent_message",
        id: "item-agent-3b",
        at: at(4, 29),
        author: AGENT,
        body:
          "Task creation is not available to me in this scenario, so I recorded the follow-up in the plan document instead.",
        streaming: false,
      },
    );
    snapshot.evidence.authorization.push({
      id: "authz-deny-1",
      turnId: "turn-3",
      operationId: "create_task",
      phase: "invocation",
      allowed: false,
      code: "required_claim_missing",
      reason: "denied: missing grant su:read_or_write",
      claimsConsidered: ["task:read"],
      redactions: [],
      stateChangeRef: null,
      threadAnchorId: "item-denial-1",
    });
    snapshot.evidence.calls.push({
      id: "call-deny-1",
      turnId: "turn-3",
      operationId: "create_task",
      version: 1,
      providerRequest: 'tools/call create_task {"title":"Follow-up: process cleanup"}',
      dispatchedCommand: "rejected before dispatch",
      outcome: "denied",
      result: { code: "required_claim_missing" },
      redactions: [],
      threadAnchorId: "item-denial-1",
    });
    return snapshot;
  },

  "document-revision": () => {
    const snapshot = baseline();
    snapshot.turns[1].items.push({
      kind: "document",
      id: "item-doc-1",
      at: at(2, 24),
      documentKey: "plan",
      title: "Runner spike plan",
      author: AGENT,
      revisionFrom: 3,
      revisionTo: 4,
      staleBehind: null,
      evidenceRef: { section: "state", recordId: "diff-turn-2" },
    });
    return snapshot;
  },

  "deliverable-registered": () => {
    const snapshot = baseline();
    const turn = lastTurn(snapshot);
    const deliverableBytes = 18_432;
    turn.toolCallCount = 1;
    turn.items.push(
      {
        kind: "tool_activity",
        id: "item-tool-5",
        at: at(4, 20),
        status: "ok",
        operationId: "register_deliverable",
        // Same formatter as the deliverable card so the two never disagree.
        summary: `spike-trace.json registered · ${capabilityFormatBytes(deliverableBytes)}`,
        input: { filename: "spike-trace.json", contentType: "application/json" },
        result: { commandKind: "register_deliverable", stateRevision: 4 },
        evidenceRef: { section: "calls", recordId: "call-5" },
      },
      {
        kind: "deliverable",
        id: "item-deliverable-1",
        at: at(4, 20),
        filename: "spike-trace.json",
        deliverableKind: "attachment bytes",
        byteSize: deliverableBytes,
        registeredBy: AGENT,
        contentRef: "mock://artifacts/artifact-7",
        evidenceRef: { section: "calls", recordId: "call-5" },
      },
    );
    snapshot.evidence.calls.push({
      id: "call-5",
      turnId: "turn-3",
      operationId: "register_deliverable",
      version: 1,
      providerRequest: 'tools/call register_deliverable {"filename":"spike-trace.json"}',
      dispatchedCommand: "control_plane.applyCommand(register_deliverable)",
      outcome: "ok",
      result: { commandKind: "register_deliverable", stateRevision: 4 },
      redactions: [],
      threadAnchorId: "item-deliverable-1",
    });
    return snapshot;
  },

  "workspace-file-changes": () => {
    const snapshot = baseline();
    const turn = lastTurn(snapshot);
    turn.items.push({
      kind: "workspace_changes",
      id: "item-workspace-turn-3",
      at: at(4, 18),
      changeSet: {
        schema: "paperclip.workspace.diff.v1",
        changeSetId: "turn-3:workspace",
        revision: 1,
        source: "runner_verified",
        complete: true,
        files: [
          {
            path: "packages/runner/src/workspace-events.ts",
            operation: "create",
            previousPath: null,
            additions: 12,
            deletions: 0,
            binary: false,
            diff: "diff --git a/packages/runner/src/workspace-events.ts b/packages/runner/src/workspace-events.ts\n--- /dev/null\n+++ b/packages/runner/src/workspace-events.ts\n@@ -1,0 +1,12 @@\n+export const WORKSPACE_DIFF_SCHEMA = \\\"paperclip.workspace.diff.v1\\\";\n+\n+export function recordWorkspaceDiff() {\n+  return { complete: true };\n+}\n",
          },
          {
            path: "packages/runner/src/index.ts",
            operation: "modify",
            previousPath: null,
            additions: 2,
            deletions: 1,
            binary: false,
            diff: [
              "diff --git a/packages/runner/src/index.ts b/packages/runner/src/index.ts\n--- a/packages/runner/src/index.ts\n+++ b/packages/runner/src/index.ts\n@@ -4,1 +4,2 @@\n-",
              "ex" + "port * from './events';\n+",
              "ex" + "port * from './events';\n+",
              "ex" + "port * from './workspace-events';\n",
            ].join(""),
          },
          {
            path: "packages/runner/src/legacy-diff.ts",
            operation: "delete",
            previousPath: null,
            additions: 0,
            deletions: 8,
            binary: false,
            diff: "diff --git a/packages/runner/src/legacy-diff.ts b/packages/runner/src/legacy-diff.ts\n--- a/packages/runner/src/legacy-diff.ts\n+++ /dev/null\n@@ -1,8 +1,0 @@\n-export function legacyDiff() {\n-  return null;\n-}\n",
          },
          {
            path: "packages/runner/test/workspace-events.test.ts",
            operation: "create",
            previousPath: null,
            additions: 16,
            deletions: 0,
            binary: false,
            diff: "diff --git a/packages/runner/test/workspace-events.test.ts b/packages/runner/test/workspace-events.test.ts\n--- /dev/null\n+++ b/packages/runner/test/workspace-events.test.ts\n@@ -1,0 +1,16 @@\n+import { test } from 'vitest';\n+\n+test('records workspace changes', () => {\n+  // deterministic fixture\n+});\n",
          },
        ],
        totals: { files: 4, additions: 30, deletions: 9 },
        patchArtifactRef: null,
      },
    });
    return snapshot;
  },

  "workspace-file-reference": () => {
    const snapshot = baseline();
    lastTurn(snapshot).items.push({
      kind: "workspace_file_reference",
      id: "item-file-reference-turn-3",
      at: at(4, 16),
      reference: {
        schema: "paperclip.workspace.file_reference.v1",
        referenceId: "turn-3:file:runner-plan",
        source: "runner_verified",
        path: "docs/paperclip-runner-protocol.md",
        displayName: "paperclip-runner-protocol.md",
        mediaType: "text/markdown",
        presentation: "document",
        line: null,
        preview: "# Paperclip Runner Protocol\n\nThe runner projects provider activity into durable, provider-neutral events.\n\n## Workspace references\n\nA local Markdown link becomes a `workspace.file.referenced` event only after the runner verifies that the target stays inside the authorized workspace.\n",
        previewTruncated: false,
        contentDigest: "sha256:2e7d2c03a9507ae265ecf5b5356885a53393a2029d241e48b76e557868953c97",
      },
    });
    return snapshot;
  },

  "disposition-terminal": () => {
    const snapshot = baseline();
    const turn = lastTurn(snapshot);
    turn.toolCallCount = 1;
    turn.items.push(
      {
        kind: "tool_activity",
        id: "item-tool-6",
        at: at(4, 40),
        status: "ok",
        operationId: "finish_task",
        summary: "MCK-31 → done · state revision 5",
        input: { summary: "Spike wired to the mock control plane." },
        result: { commandKind: "finish_task", stateRevision: 5 },
        evidenceRef: { section: "calls", recordId: "call-6" },
      },
      {
        kind: "disposition",
        id: "item-disposition-1",
        at: at(4, 40),
        operationId: "finish_task",
        status: "done",
        body:
          "Spike is wired to the mock control plane. Plan revision 4 is approved and the trace is registered as a deliverable.",
        blockerOwner: null,
        evidenceRef: { section: "calls", recordId: "call-6" },
      },
    );
    snapshot.issue.status = "done";
    snapshot.evidence.calls.push({
      id: "call-6",
      turnId: "turn-3",
      operationId: "finish_task",
      version: 1,
      providerRequest: 'tools/call finish_task {"summary":"Spike wired…"}',
      dispatchedCommand: "control_plane.applyCommand(finish_task)",
      outcome: "ok",
      result: { commandKind: "finish_task", stateRevision: 5 },
      redactions: [],
      threadAnchorId: "item-disposition-1",
    });
    snapshot.composer = {
      state: "ready",
      helper: "This task is done. You can still continue the conversation.",
      reason: null,
      pendingInteractionId: null,
    };
    return snapshot;
  },

  "debug-panel-open": baseline,

  "reconnect-banner": () => {
    const snapshot = baseline();
    snapshot.connection = { state: "reconnecting", attempt: 2 };
    snapshot.identity.runnerAttached = false;
    snapshot.composer = {
      state: "reconnecting",
      helper: "Reconnecting… your session is preserved.",
      reason: null,
      pendingInteractionId: null,
    };
    return snapshot;
  },

  "replay-mode": () => {
    const snapshot = baseline();
    snapshot.mode = "replay";
    snapshot.identity = {
      ...snapshot.identity,
      agentLabel: "Replay",
      runnerLabel: "In-process runner",
      runnerAttached: false,
      replaySource: "fake",
    };
    snapshot.turns = snapshot.turns.map((turn) => ({ ...turn, mode: "replay" as const }));
    snapshot.replay = { ordinal: 12, total: 18 };
    snapshot.composer = {
      state: "disabled",
      helper: null,
      reason: "Replay is read-only",
      pendingInteractionId: null,
    };
    return snapshot;
  },
};

type ProviderFixtureFamily = Extract<CapabilityThreadItem, { kind: "provider_activity" }>["family"];

const PROVIDER_SCENARIOS: Record<string, { family: ProviderFixtureFamily; eventType: string; title: string; payload: Record<string, CapabilityJsonValue> }> = {
  "pe-structured-plan": { family: "plan", eventType: "plan.updated", title: "Plan", payload: { schema: "paperclip.plan.updated.v1", planId: "plan-1", revision: 2, explanation: "Implementation plan regenerated after review.", complete: true, syncStatus: "conflict", documentRevision: 4, steps: [{ stepId: "step-1", body: "Add canonical schemas", status: "completed" }, { stepId: "step-2", body: "Wire provider normalization", status: "in_progress" }, { stepId: "step-3", body: "Resolve concurrent plan edit", status: "blocked" }] } },
  "te-command-execution": { family: "tool_execution", eventType: "tool.execution.completed", title: "Run", payload: { schema: "paperclip.tool.execution.v1", executionId: "exec-1", transport: "process", operation: "execute", name: "pnpm test", target: null, namespace: null, readOnly: false, status: "completed", durationMs: 1842, exitCode: 0, progress: null, output: "Tests: 48 passed\nOutput retained at the canonical boundary.", outputBytes: 58, outputTruncated: false, outputDigest: "sha256:fixture" } },
  "mp-mcp-progress": { family: "tool_execution", eventType: "tool.execution.progressed", title: "MCP · search_tasks", payload: { schema: "paperclip.tool.execution.v1", executionId: "mcp-1", transport: "mcp", operation: "search", name: "search_tasks", target: null, namespace: "paperclip", readOnly: true, status: "running", durationMs: 340, exitCode: null, progress: "Scanned 18 authorized tasks", output: "", outputBytes: 0, outputTruncated: false, outputDigest: "sha256:fixture" } },
  "rs-web-research": { family: "research", eventType: "research.completed", title: "Research", payload: { schema: "paperclip.research.v1", researchId: "research-1", action: "search", status: "completed", query: "PRP event streaming", url: null, pattern: null, sources: [{ sourceId: "source-1", url: "https://example.com/prp", title: "Protocol notes", snippet: "Provider-reported source excerpt." }, { sourceId: "source-bad", url: null, title: "Unavailable malformed source", snippet: null }] } },
  "da-subagent-delegation": { family: "delegation", eventType: "delegation.updated", title: "Delegation", payload: { schema: "paperclip.delegation.v1", delegationId: "delegate-1", action: "wait", status: "waiting", children: [{ childId: "child-1", role: "Protocol mapper", model: "gpt-5", status: "completed", summary: "Mapped notifications", activitySummary: "12 events" }, { childId: "child-2", role: "UI verifier", model: "gpt-5", status: "running", summary: "Checking mobile layout", activitySummary: "2 scenarios" }] } },
  "mr-model-routing": { family: "model_identity", eventType: "model.route.changed", title: "Model rerouted", payload: { schema: "paperclip.model.route_changed.v1", routeId: "route-1", provider: "openai", requestedModel: "gpt-5", fromModel: "gpt-5", effectiveModel: "gpt-5.1", reason: "Capacity routing", usageBoundaryId: "usage-2" } },
  "cc-context-compaction": { family: "context", eventType: "context.compacted", title: "Context compacted", payload: { schema: "paperclip.context.compacted.v1", compactionId: "compact-1", reason: "context window", preTokens: 118000, postTokens: 32000, sameSession: true } },
  "ag-generated-artifact": { family: "artifact", eventType: "artifact.generated", title: "Generated artifact", payload: { schema: "paperclip.artifact.generated.v1", artifactId: "artifact-1", status: "completed", reference: "artifacts/architecture.png", mediaType: "image/png", registered: true, transparentBackground: false, failure: null } },
  "rv-review-mode": { family: "review", eventType: "review.mode.changed", title: "Provider review mode", payload: { schema: "paperclip.review.mode_changed.v1", reviewId: "review-1", state: "entered", scope: "workspace changes" } },
  "hk-hook-lifecycle": { family: "hook", eventType: "hook.completed", title: "Hook", payload: { schema: "paperclip.hook.v1", hookId: "hook-1", event: "post-tool", scope: "workspace", status: "failed", blocking: true, durationMs: 81, summary: "Formatting policy rejected the change." } },
  "mc-memory-citations": { family: "memory", eventType: "memory.citation.referenced", title: "Memory citation", payload: { schema: "paperclip.memory.citation.v1", citationId: "citation-1", messageItemId: "message-1", label: "Prior architecture decision", available: true, reference: "paperclip://memory/decision-4" } },
  "sr-safety-review": { family: "safety", eventType: "safety.review.completed", title: "Safety review", payload: { schema: "paperclip.safety.review.v1", reviewId: "safety-1", targetExecutionId: "exec-4", status: "completed", decision: "denied", summary: "Execution requires user approval." } },
  "ti-terminal-input": { family: "terminal", eventType: "terminal.input.sent", title: "Terminal input", payload: { schema: "paperclip.terminal.input_sent.v1", executionId: "exec-5", origin: "agent", inputClass: "control", byteCount: 1 } },
  "wt-intentional-wait": { family: "wait", eventType: "wait.completed", title: "Intentional wait", payload: { schema: "paperclip.wait.v1", waitId: "wait-1", reason: "timer", status: "interrupted", plannedDurationMs: 30000, elapsedDurationMs: 8200 } },
  "pn-provider-notices": { family: "provider_notice", eventType: "provider.notice.recorded", title: "Provider notice", payload: { schema: "paperclip.provider.notice.v1", noticeId: "notice-1", severity: "warning", category: "deprecation", scope: "environment", recoverable: true, userActionable: false, summary: "A provider option is deprecated; the turn can continue." } },
  "ax-acpx-lifecycle": { family: "context", eventType: "acpx.session.restored", title: "ACPX session lifecycle", payload: { provider: "acpx", driver: "acpx_runtime", agent: "pi", acpxVersion: "0.13.1", acpProtocolVersion: 1, acpxRecordId: "acpx_record_fixture", providerSessionId: "pi_session_fixture", runnerPid: 48121, sidecarPid: 48122, agentPid: 48123, coldTurnMs: 1850, warmTurnMs: 410, restoredTurnMs: 920, warmPidContinuous: true, restoredSessionContinuous: true, status: "completed", summary: "A warm second run retained the ACP child; per-turn suspension later loaded the same persistent ACP session." } },
  "ax-acpx-permissions": { family: "safety", eventType: "acpx.permission.resolved", title: "ACPX permission", payload: { provider: "acpx", nativeAgent: "claude", extensionAgent: "pi", requestKinds: ["command_approval", "file_approval"], decisions: ["accept", "accept_for_session", "decline", "cancel"], waitedMs: 86400000, contentRetained: false, processLossDisposition: "recoverably_blocked", status: "completed", summary: "Native Claude and Pi-extension requests use the same durable, exactly-once Paperclip approval path." } },
  "ax-acpx-tools": { family: "tool_execution", eventType: "acpx.semantic_tool.completed", title: "ACPX semantic tools", payload: { provider: "acpx", bridge: "loopback_authenticated", operationId: "report_progress", callId: "acpx-call-4", catalogRevision: 3, duplicateDeliveries: 2, executionCount: 1, staleCatalogDenied: true, unauthorizedCallDenied: true, finishAndBlockStructured: true, status: "completed", summary: "The current attached run catalog remained authoritative across MCP refresh and ACP session reload." } },
  "ax-acpx-events": { family: "model_identity", eventType: "acpx.event.normalized", title: "ACPX normalized events", payload: { provider: "acpx", agent: "claude", requestedModel: "claude-sonnet-5", effectiveModel: "claude-sonnet-5", mapped: ["assistant_delta", "tool_progress", "workspace_diff", "file_reference", "plan.updated", "usage"], hiddenReasoningRetained: false, rawAcpRetained: false, replayDuplicates: 0, unknownVariant: "provider.notice.recorded", status: "completed", summary: "Bounded ACP notifications were normalized once with run, turn, item, sequence, and model attribution." } },
  "ax-acpx-failures": { family: "provider_notice", eventType: "acpx.failure.recorded", title: "ACPX failure isolation", payload: { provider: "acpx", failures: ["missing_auth", "unsupported_model", "profile_digest_mismatch", "malformed_frame", "oversized_update", "agent_crash", "hung_prompt"], descendantsReaped: ["sidecar", "acp_server", "agent"], credentialValuesRetained: false, rawPayloadRetained: false, status: "failed", summary: "Qualification and runtime failures fail closed, redact diagnostics, block unsafe recovery, and reap the full process group." } },
};

function providerScenario(slug: string, spec: (typeof PROVIDER_SCENARIOS)[string]): CapabilityIssueThreadSnapshot {
  const snapshot = baseline();
  snapshot.issue.fixtureProfile = slug;
  snapshot.issue.scenarioId = slug;
  snapshot.issue.title = `${spec.title} event UX`;
  const turn = lastTurn(snapshot);
  const base = spec.payload;
  turn.items.push(
    { kind: "provider_activity", id: `${slug}-active`, at: at(4, 10), family: spec.family, eventType: spec.eventType.replace(/completed$/, "started"), status: "running", title: spec.title, summary: "Activity started", payload: { ...base, status: "running" }, evidenceRef: { section: "runner", recordId: `${slug}-e1` } },
    { kind: "provider_activity", id: `${slug}-final`, at: at(4, 20), family: spec.family, eventType: spec.eventType, status: spec.payload.status === "failed" ? "failed" : spec.payload.status === "interrupted" ? "interrupted" : "completed", title: spec.title, summary: typeof spec.payload.summary === "string" ? spec.payload.summary : "Activity completed", payload: base, evidenceRef: { section: "runner", recordId: `${slug}-e2` } },
  );
  snapshot.evidence.runner.push(
    { id: `${slug}-e1`, turnId: turn.id, kind: spec.eventType, ordinal: snapshot.evidence.runner.length + 1, detail: `${spec.title} · active`, details: [{ label: "State", value: "running" }] },
    { id: `${slug}-e2`, turnId: turn.id, kind: spec.eventType, ordinal: snapshot.evidence.runner.length + 2, detail: `${spec.title} · terminal`, details: [{ label: "Event", value: spec.eventType }] },
  );
  return snapshot;
}

for (const [slug, spec] of Object.entries(PROVIDER_SCENARIOS)) {
  BUILDERS[slug as CapabilityUiShotSlug] = () => providerScenario(slug, spec);
}

/** Deterministic dependency-free `fake` snapshot for a screenshot slug. */
export function capabilityIssueThreadFixture(
  slug: string = "thread-baseline",
  fixtureProfile: string = CAPABILITY_DEFAULT_FIXTURE_PROFILE,
): CapabilityIssueThreadSnapshot {
  const effectiveSlug = slug === "thread-baseline" && fixtureProfile === "wc-workspace-changes"
    ? "workspace-file-changes"
    : slug === "thread-baseline" && fixtureProfile === "fr-file-reference"
      ? "workspace-file-reference"
    : fixtureProfile in PROVIDER_SCENARIOS ? fixtureProfile
    : slug;
  const build = BUILDERS[effectiveSlug as CapabilityUiShotSlug] ?? BUILDERS["thread-baseline"];
  const snapshot = build!();
  snapshot.issue.fixtureProfile = fixtureProfile;
  return snapshot;
}
