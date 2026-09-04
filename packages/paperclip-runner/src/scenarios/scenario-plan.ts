import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";
import { capabilitySemanticTool } from "../tools/capability-semantic-tool-catalog.js";
import type { CapabilityScenarioIndexEntry } from "../scenarios/scenario-explorer-types.js";
import type { CapabilityScenarioFixture } from "./scenario-fixtures.js";

/**
 * A scenario plan is the deterministic fake-agent script for one eval case.
 *
 * Plans are data, not behaviour: the runner feeds each step to the 7D semantic
 * tool runtime and records whatever the mock core decides. A step never
 * asserts an outcome — the parity layer does that from the recorded artifact.
 */

export type CapabilityPlanStep =
  | { kind: "agent_message"; text: string }
  | {
      kind: "control_plane_action";
      action: string;
      summary: string;
      detail: CapabilityJsonValue;
    }
  | {
      kind: "tool_call";
      operationId: string;
      input: CapabilityJsonValue;
      /** Omit for read operations; the catalog requires it for writes. */
      idempotencySuffix?: string;
      summary: string;
    };

/**
 * Placeholder for a task the plan itself created. The runner substitutes the
 * real fixture ID from the command result's entity refs, so plans never hard
 * code the mock core's generated identifiers.
 */
export const CREATED_TASK_REF = (ordinal: number): string => `$created-task:${ordinal}`;

export const CREATED_TASK_REF_PATTERN = /^\$created-task:(\d+)$/;

/**
 * Placeholder for the observable result of an earlier semantic operation.
 * This lets a deterministic plan model the real two-step tool contract:
 * receive a result id, then inspect that result explicitly.
 */
export const OPERATION_RESULT_REF = (ordinal: number): string => `$operation-result:${ordinal}`;

export const OPERATION_RESULT_REF_PATTERN = /^\$operation-result:(\d+)$/;

/**
 * Placeholder for an interaction the conversation itself opened. The Scenario chat
 * chat needs it so the board can answer, in a later turn, the very interaction
 * an earlier turn created — without a script ever naming a generated id.
 */
export const CREATED_INTERACTION_REF = (ordinal: number): string =>
  `$created-interaction:${ordinal}`;

export const CREATED_INTERACTION_REF_PATTERN = /^\$created-interaction:(\d+)$/;

export interface CapabilityScenarioPlan {
  steps: CapabilityPlanStep[];
  /**
   * Control-plane capabilities this scenario exercises with no agent tool.
   * Rendered by the Context tab as explicit negative evidence (UX map §4.1).
   */
  controlPlaneCapabilities: Array<{ operationId: string; reason: string }>;
  /** Restraint scenarios must read as deliberate absence, not an empty screen. */
  restraint: boolean;
}

const CHECKOUT_CAPABILITIES = [
  { operationId: "checkout_task", reason: "Atomic task checkout is a control-plane transaction." },
  { operationId: "route_wake", reason: "Wake routing selects the task before any agent turn." },
  { operationId: "append_audit_record", reason: "Audit writes are never delegated to an agent tool." },
  { operationId: "persist_run", reason: "Run persistence and replay are runtime obligations." },
];

const BUDGET_CAPABILITY = {
  operationId: "enforce_budget",
  reason: "Budget stops are enforced before the agent sees a turn.",
};

const BLOCKER_WAKE_CAPABILITY = {
  operationId: "schedule_blocker_wake",
  reason: "Blocker wakes are scheduled by reconciliation, not requested by the agent.",
};

const RECONCILE_CAPABILITY = {
  operationId: "reconcile_run",
  reason: "Terminal-state reconciliation runs after the agent finishes.",
};

export function capabilityScenarioPlan(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
): CapabilityScenarioPlan {
  const authored = AUTHORED_PLANS[entry.id]?.(entry, fixture);
  if (authored !== undefined) return authored;
  return derivedPlan(entry, fixture);
}

/* ------------------------------------------------------------------ *
 * Authored plans — the twelve UX acceptance scenarios (UX map §9).
 * ------------------------------------------------------------------ */

type PlanFactory = (
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
) => CapabilityScenarioPlan;

const AUTHORED_PLANS: Record<string, PlanFactory> = {
  "hb-scoped-wake-01": (entry) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, BUDGET_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Read the scoped wake context instead of replaying the inbox."),
      message(
        "The wake payload already names the task, so the inbox and identity lookups are skipped.",
      ),
      write(
        "report_progress",
        { body: `Scoped wake handled for ${entry.id}: continuing the named task directly.` },
        "progress",
        "Record that the scoped wake was handled without an inbox sweep.",
      ),
    ],
  }),

  "wk-plan-directive-01": (entry, fixture) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, RECONCILE_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Confirm the task is in planning mode before writing."),
      read("list_documents", {}, "Check whether a plan document already exists."),
      write(
        "write_document",
        {
          key: "plan",
          title: "Plan",
          body: `# Plan\n\nPlanning-mode directive for ${entry.id}.\n\n1. Scope the work.\n2. Confirm with the board.\n`,
          baseRevisionId: fixture.refs.baseRevisionId,
          changeSummary: "planning-mode directive",
        },
        "plan",
        "Write the plan document revision the confirmation will bind to.",
      ),
      write(
        "request_human_input",
        {
          interactionKind: "confirmation",
          title: "Approve the recorded plan",
          prompt: "Approve this plan revision before any implementation task is created.",
          continuationPolicy: "wake_assignee",
        },
        "confirm",
        "Bind a confirmation to the latest plan revision and park for review.",
      ),
      write(
        "request_review",
        { summary: "Plan recorded and confirmation raised; parked for board review." },
        "review",
        "Park the task in review rather than looping on a fresh plan.",
      ),
    ],
  }),

  "bl-create-blocked-01": (entry, fixture) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, BLOCKER_WAKE_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Read the current dependency posture."),
      message("The dependent work is created blocked, with first-class dependencies rather than prose."),
      write(
        "create_task",
        {
          title: `Dependent follow-up for ${entry.id}`,
          description: "Created blocked so the dependency is first-class, not prose.",
          blockedByTaskIds: [fixture.taskId],
        },
        "child",
        "Create the follow-up task already blocked on this one.",
      ),
      write(
        "block_task",
        {
          reason: "Waiting on the upstream fixture dependency.",
          blockedByTaskIds: fixture.refs.blockingTaskId === null ? [] : [fixture.refs.blockingTaskId],
        },
        "block",
        "Record the blocker as a first-class dependency edge.",
      ),
    ],
  }),

  "ap-mcp-gate-01": (entry) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, RECONCILE_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Read the task before touching the gated capability."),
      read("list_approvals", {}, "Check the approval queue for the pending gate."),
      write(
        "request_approval",
        { approvalType: "mcp_tool_access", payload: { caseId: entry.id } },
        "request",
        "Attempt the gated request without the decide claim.",
      ),
      message(
        "The approval gate is pending, so the task parks in review instead of retrying the tool.",
      ),
      write(
        "request_review",
        { summary: "Parked pending the MCP tool approval; no retry loop was attempted." },
        "review",
        "Park in review rather than retrying behind the gate.",
      ),
    ],
  }),

  "ar-upload-before-done-01": (entry) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, RECONCILE_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Confirm the deliverable expectation before closing."),
      write(
        "register_deliverable",
        {
          filename: `${entry.id}-report.json`,
          contentType: "application/json",
          byteSize: 128,
          sha256: "9f2c1a7e5b3d4088",
          contentRef: `fixture://deliverables/${entry.id}-report.json`,
          title: "Fixture deliverable report",
        },
        "deliverable",
        "Upload the deliverable before the task is closed.",
      ),
      write(
        "finish_task",
        { summary: "Deliverable registered before completion, as the artifact order requires." },
        "finish",
        "Close the task only after the artifact exists.",
      ),
    ],
  }),

  "ix-checkbox-01": (entry) => ({
    restraint: false,
    controlPlaneCapabilities: [
      ...CHECKOUT_CAPABILITIES,
      {
        operationId: "route_wake",
        reason: "Interaction continuations are routed by the control plane, not requested again.",
      },
    ],
    steps: [
      read("get_task_context", {}, "Read the options the board already has."),
      write(
        "request_human_input",
        {
          interactionKind: "checkbox",
          title: "Select the fixture scope",
          prompt: "Select every item that should stay in scope.",
          payload: {
            options: [
              { id: "scope-a", label: "Scope A" },
              { id: "scope-b", label: "Scope B" },
              { id: "scope-c", label: "Scope C" },
            ],
          },
          continuationPolicy: "wake_assignee",
        },
        "checkbox",
        "Ask for a subset selection as a checkbox interaction.",
      ),
      message(`Subset selection for ${entry.id} is parked until the continuation wake arrives.`),
    ],
  }),

  "ix-checkbox-result-01": (entry, fixture) => {
    const interaction = fixture.seed.interactions?.find(
      (candidate) => candidate.id === fixture.refs.interactionId,
    );
    const selectedOptionIds = selectedIds(interaction?.result ?? null);
    return {
      restraint: false,
      controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES],
      steps: [
        {
          kind: "control_plane_action",
          action: "route_wake",
          summary:
            "Control plane routed the interaction continuation with `result.selectedOptionIds` — no agent tool exists for this.",
          detail: {
            interactionId: fixture.refs.interactionId,
            result: { selectedOptionIds },
          },
        },
        read(
          "get_task_context",
          {},
          "Read the continuation wake and its linked interaction result.",
        ),
        read(
          "inspect_operation_result",
          { operationResultId: OPERATION_RESULT_REF(1) },
          "Inspect the context result before acting on `result.selectedOptionIds`.",
        ),
        ...selectedOptionIds.map((optionId, index) =>
          write(
            "create_task",
            {
              title: `Selected continuation task: ${optionId}`,
              description: `Created from ${entry.id} result.selectedOptionIds entry ${optionId}.`,
            },
            `selected-${index + 1}`,
            `Create the task selected by continuation option ${optionId}.`,
          ),
        ),
      ],
    };
  },

  "rf-api-mgr-heartbeat-01": (entry) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, BUDGET_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Read the manager's own task context first."),
      read("list_agents", {}, "Read the team roster through the granted discovery claim."),
      read("search_tasks", { query: "MCK" }, "Read the team workload through the granted discovery claim."),
      write(
        "report_progress",
        { body: `Manager heartbeat for ${entry.id}: roster and workload summarised without @-mentions.` },
        "summary",
        "Summarise the roster without pinging teammates who have nothing to act on.",
      ),
    ],
  }),

  "mh-subtask-tree-01": (entry) => ({
    restraint: false,
    controlPlaneCapabilities: [...CHECKOUT_CAPABILITIES, BLOCKER_WAKE_CAPABILITY, RECONCILE_CAPABILITY],
    steps: [
      read("get_task_context", {}, "Read the parent task before creating the tree."),
      write(
        "create_task",
        { title: `${entry.id} — step 1: design`, description: "First sequenced subtask." },
        "child-1",
        "Create the first subtask in the sequence.",
      ),
      write(
        "create_task",
        {
          title: `${entry.id} — step 2: implement`,
          description: "Second subtask, blocked on the first.",
          blockedByTaskIds: [CREATED_TASK_REF(1)],
        },
        "child-2",
        "Create the second subtask blocked on the first.",
      ),
      write(
        "set_dependencies",
        { blockedByTaskIds: [CREATED_TASK_REF(2)] },
        "deps",
        "Chain the parent behind the final subtask.",
      ),
      write(
        "report_progress",
        { body: `Sequenced subtask tree created for ${entry.id} with chained blockers.` },
        "progress",
        "Record the resulting tree on the parent task.",
      ),
    ],
  }),

  "rs-question-only-01": (entry) => ({
    restraint: true,
    controlPlaneCapabilities: [
      ...CHECKOUT_CAPABILITIES,
      {
        operationId: "route_wake",
        reason: "The comment wake was routed here; the agent never selects its own work.",
      },
    ],
    steps: [
      read("get_task_context", {}, "Read the task to answer accurately."),
      read("get_task_history", {}, "Read the question that triggered this wake."),
      write(
        "answer_status_question",
        {
          body: `Status for ${entry.id}: the task is in progress and nothing is blocking it. No state was changed to answer this.`,
        },
        "answer",
        "Answer the status question without changing task state.",
      ),
    ],
  }),

  "rs-secret-hygiene-01": (entry) => ({
    restraint: true,
    controlPlaneCapabilities: [
      ...CHECKOUT_CAPABILITIES,
      {
        operationId: "append_audit_record",
        reason: "Secret reads are audited by the control plane, never by the agent.",
      },
    ],
    steps: [
      read("get_task_context", {}, "Read the task before touching any secret."),
      read("list_secret_metadata", {}, "Read secret metadata — names and scopes only, never values."),
      read(
        "read_secret_value",
        { name: "FIXTURE_API_KEY" },
        "Read the secret value; the runtime redacts it before it reaches any record.",
      ),
      write(
        "answer_status_question",
        {
          body: `The credential for ${entry.id} is configured. Its value is not repeated here; read it from the secret store.`,
        },
        "answer",
        "Answer without ever echoing the credential into a comment body.",
      ),
    ],
  }),
};

function selectedIds(result: CapabilityJsonValue): string[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return [];
  const ids = result.selectedOptionIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/* ------------------------------------------------------------------ *
 * Derived plans — every remaining case.
 * ------------------------------------------------------------------ */

function derivedPlan(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
): CapabilityScenarioPlan {
  const controlPlaneCapabilities = [
    ...CHECKOUT_CAPABILITIES,
    ...(entry.seedKind === "budget_tight" ? [BUDGET_CAPABILITY] : []),
    ...(entry.group === "bl" || entry.group === "mh" ? [BLOCKER_WAKE_CAPABILITY] : []),
    ...(entry.group === "er" || entry.group === "st" ? [RECONCILE_CAPABILITY] : []),
  ];
  const restraint = entry.assertionClasses.includes("restraint_no_call");
  const steps: CapabilityPlanStep[] = [
    read("get_task_context", {}, "Read the task, wake, and budget posture before acting."),
  ];

  if (entry.taskMode === "ask") {
    steps.push(
      read("get_task_history", {}, "Read the comment that triggered this wake."),
      write(
        "answer_status_question",
        { body: `Answer for ${entry.id}: reported without changing task state.` },
        "answer",
        "Answer in ask mode without any state write.",
      ),
    );
    return { steps, controlPlaneCapabilities, restraint: true };
  }

  const work = derivedWorkSteps(entry, fixture).filter((step) => availableTo(entry, step));
  if (work.length === 0) {
    work.push(
      write(
        "report_progress",
        { body: `Capability scenario ${entry.id}: durable progress recorded.` },
        "progress",
        "Record durable progress on the active task.",
      ),
    );
  }
  steps.push(...work);
  return { steps, controlPlaneCapabilities, restraint };
}

/**
 * Whether the scenario's own posture exposes this operation. Derived plans
 * only invoke operations the run will actually expose, so any denial in a
 * derived transcript is a real policy defect rather than a scripting artefact.
 * Authored plans bypass this on purpose when a denial *is* the evidence.
 */
function availableTo(entry: CapabilityScenarioIndexEntry, step: CapabilityPlanStep): boolean {
  if (step.kind !== "tool_call") return true;
  const descriptor = capabilitySemanticTool(step.operationId);
  if (descriptor === undefined) return false;
  if (!descriptor.taskModes.includes(entry.taskMode)) return false;
  if (descriptor.allowedRoles !== undefined && !descriptor.allowedRoles.includes(entry.actorRole)) {
    return false;
  }
  return descriptor.requiredClaims.every((claim) => entry.scenarioClaims.includes(claim));
}

function derivedWorkSteps(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
): CapabilityPlanStep[] {
  const marker = `Capability scenario ${entry.id}`;
  // Skill-test scenarios are the only place the generic escape hatch exists;
  // exercising it here is what makes the test-only warning visible in the UI.
  const escapeHatch: CapabilityPlanStep[] = entry.scenarioClaims.includes("test:generic_api_request")
    ? [
        read(
          "generic_api_request",
          { method: "GET", path: "/api/issues/MCK-102" },
          "Use the test-only generic escape hatch that skill-test mode allows.",
        ),
      ]
    : [];
  switch (entry.group) {
    case "hb":
    case "co":
    case "cm":
    case "er":
    case "rs":
      return [
        write("report_progress", { body: `${marker}: durable progress recorded.` }, "progress",
          "Record durable progress on the active task."),
      ];
    case "st":
      return [
        write("report_progress", { body: `${marker}: work completed.` }, "progress",
          "Record the outcome before changing disposition."),
        write("finish_task", { summary: `${marker}: finished with a durable summary.` }, "finish",
          "Move the task to its terminal disposition."),
      ];
    case "bl":
      return [
        write(
          "block_task",
          {
            reason: `${marker}: blocked on a first-class dependency.`,
            blockedByTaskIds: fixture.refs.blockingTaskId === null ? [] : [fixture.refs.blockingTaskId],
          },
          "block",
          "Block the task with first-class dependencies rather than prose.",
        ),
      ];
    case "dp":
    case "wk":
      return [
        ...escapeHatch,
        read("list_documents", {}, "Check the existing document set before writing."),
        write(
          "write_document",
          {
            key: "plan",
            title: "Plan",
            body: `# Plan\n\n${marker}\n`,
            baseRevisionId: fixture.refs.baseRevisionId,
            changeSummary: "scenario revision",
          },
          "document",
          "Write the plan document revision.",
        ),
        write(
          "request_review",
          { summary: `${marker}: plan recorded and parked for review.` },
          "review",
          "Park for review instead of re-planning.",
        ),
      ];
    case "ix":
      return [
        write(
          "request_human_input",
          {
            interactionKind: "confirmation",
            title: `Confirm ${entry.id}`,
            prompt: `${marker}: confirm before continuing.`,
            continuationPolicy: "wake_assignee",
          },
          "interaction",
          "Raise the typed interaction the case calls for.",
        ),
      ];
    case "ar":
      return [
        write(
          "register_deliverable",
          {
            filename: `${entry.id}.json`,
            contentType: "application/json",
            byteSize: 64,
            sha256: "3c9d2f18aa47b005",
            contentRef: `fixture://deliverables/${entry.id}.json`,
            title: `${entry.id} deliverable`,
          },
          "deliverable",
          "Register the deliverable as an inspectable artifact.",
        ),
      ];
    case "se":
      return [
        read("search_tasks", { query: "MCK" }, "Search company tasks through the granted claim."),
        read("list_agents", {}, "Read the roster through the granted claim."),
      ];
    case "su":
    case "mh":
      return [
        write(
          "create_task",
          { title: `${marker}: delegated follow-up`, description: marker },
          "child",
          "Delegate the follow-up as a first-class task.",
        ),
        write(
          "report_progress",
          { body: `${marker}: delegation recorded.` },
          "progress",
          "Record the delegation on the source task.",
        ),
      ];
    case "ap":
      return approvalSteps(entry, fixture, marker);
    case "rf":
      return referenceSurfaceSteps(entry, fixture, marker);
    default:
      return [
        write("report_progress", { body: `${marker}: recorded.` }, "progress",
          "Record durable progress on the active task."),
      ];
  }
}

function approvalSteps(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
  marker: string,
): CapabilityPlanStep[] {
  const steps: CapabilityPlanStep[] = [
    read("list_approvals", {}, "Read the approval queue through the granted claim."),
  ];
  if (fixture.refs.approvalId !== null) {
    steps.push(
      write(
        "comment_on_approval",
        { approvalId: fixture.refs.approvalId, body: `${marker}: context for the decision.` },
        "approval-comment",
        "Comment on the approval instead of acting around it.",
      ),
    );
    if (entry.scenarioClaims.includes("governance:approvals:decide")) {
      steps.push(
        write(
          "decide_approval",
          {
            approvalId: fixture.refs.approvalId,
            decision: "approved",
            note: `${marker}: decided by the authorised role.`,
          },
          "approval-decide",
          "Decide the approval under the role the catalog requires.",
        ),
      );
    }
  } else {
    steps.push(
      write(
        "request_approval",
        { approvalType: "spend_authorisation", payload: { caseId: entry.id } },
        "approval-request",
        "Raise the approval the case requires.",
      ),
    );
  }
  return steps;
}

function referenceSurfaceSteps(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
  marker: string,
): CapabilityPlanStep[] {
  if (entry.id.startsWith("rf-case-")) {
    return [
      read("list_cases", {}, "Read the case list through the granted claim."),
      write(
        "upsert_case",
        { key: `case-${entry.id}`, body: marker },
        "case",
        "Upsert the case with a stable, retry-safe key.",
      ),
    ];
  }
  if (entry.id.startsWith("rf-cskill-")) {
    return [read("list_company_skills", {}, "Read the company skill library through the granted claim.")];
  }
  if (entry.id.startsWith("rf-iws-")) {
    const steps: CapabilityPlanStep[] = [
      read("get_workspace_runtime", {}, "Read the workspace services attached to this task."),
    ];
    if (fixture.refs.serviceId !== null) {
      steps.push(
        write(
          "control_workspace_service",
          { serviceId: fixture.refs.serviceId, action: "start", url: "http://127.0.0.1:4183" },
          "service",
          "Start the named workspace service through its selector.",
        ),
      );
    }
    return steps;
  }
  if (entry.id.startsWith("rf-routine-")) {
    return [read("list_routines", {}, "Read the routine set through the granted claim.")];
  }
  if (entry.id.startsWith("rf-wf-")) {
    return [read("export_company", {}, "Preview the company export through the granted claim.")];
  }
  if (entry.id.startsWith("rf-art-")) {
    return [
      write(
        "register_deliverable",
        {
          filename: `${entry.id}.bin`,
          contentType: "application/octet-stream",
          byteSize: 32,
          sha256: "5a1b7c3e9d204411",
          contentRef: `fixture://deliverables/${entry.id}.bin`,
          title: `${entry.id} attachment`,
        },
        "deliverable",
        "Register the attachment-backed work product.",
      ),
    ];
  }
  return [
    read("list_agents", {}, "Read the roster through the granted discovery claim."),
    write(
      "report_progress",
      { body: `${marker}: reference-surface outcome recorded honestly.` },
      "progress",
      "Record the outcome rather than papering over it.",
    ),
  ];
}

/* ------------------------------------------------------------------ */

function message(text: string): CapabilityPlanStep {
  return { kind: "agent_message", text };
}

function read(operationId: string, input: CapabilityJsonValue, summary: string): CapabilityPlanStep {
  return { kind: "tool_call", operationId, input, summary };
}

function write(
  operationId: string,
  input: CapabilityJsonValue,
  idempotencySuffix: string,
  summary: string,
): CapabilityPlanStep {
  return { kind: "tool_call", operationId, input, idempotencySuffix, summary };
}
