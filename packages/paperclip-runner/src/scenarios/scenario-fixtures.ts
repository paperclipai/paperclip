import type {
  CapabilityFixtureSeed,
  CapabilityFixtureTask,
} from "../mock-core/capability-control-plane-types.js";
import type { CapabilityScenarioIndexEntry } from "../scenarios/scenario-explorer-types.js";
import type { CapabilitySeedKind } from "./scenario-index.js";

/**
 * Deterministic fixture seeds for the Capability scenario explorer.
 *
 * Every seed is pure data derived from the scenario entry — no clock, no
 * randomness, no host state — so two runs of the same scenario produce byte
 * identical artifacts (UX map §7 determinism contract).
 */

const COMPANY_ID = "company-1";
const ACTOR_ID = "actor-1";
const PEER_ACTOR_ID = "actor-2";
const TASK_ID = "task-1";
const FIXTURE_EPOCH_MS = Date.UTC(2026, 7, 9);

const ROLE_NAMES: Record<string, string> = {
  engineer: "Mock Engineer",
  manager: "Mock Engineering Manager",
  reviewer: "Mock Reviewer",
  board: "Mock Board Member",
};

function at(offsetSeconds: number): string {
  return new Date(FIXTURE_EPOCH_MS - 3_600_000 + offsetSeconds * 1_000).toISOString();
}

function task(overrides: Partial<CapabilityFixtureTask> & { id: string; identifier: string; title: string }): CapabilityFixtureTask {
  return {
    companyId: COMPANY_ID,
    description: null,
    status: "todo",
    priority: "medium",
    workMode: "standard",
    parentId: null,
    assigneeActorId: null,
    checkoutRunId: null,
    executionRunId: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

export interface CapabilityScenarioFixture {
  seed: CapabilityFixtureSeed;
  taskId: string;
  actorId: string;
  /** Fixture entities the plan may reference by ID. */
  refs: {
    approvalId: string | null;
    documentKey: string | null;
    baseRevisionId: string | null;
    interactionId: string | null;
    blockingTaskId: string | null;
    serviceId: string | null;
    peerActorId: string | null;
  };
}

export function capabilityScenarioFixture(entry: CapabilityScenarioIndexEntry): CapabilityScenarioFixture {
  const seedKind = entry.seedKind as CapabilitySeedKind;
  const activeTask = task({
    id: TASK_ID,
    identifier: "MCK-102",
    title: entry.title,
    description: `Capability fixture task for eval case ${entry.id}.`,
    status: "todo",
    priority: entry.group === "hb" ? "high" : "medium",
    workMode: entry.taskMode,
    assigneeActorId: ACTOR_ID,
  });
  const seed: CapabilityFixtureSeed = {
    epochMs: FIXTURE_EPOCH_MS,
    company: {
      id: COMPANY_ID,
      name: "Mock Paperclip Company",
      issuePrefix: "MCK",
      status: "active",
      budgetId: "budget-company-1",
    },
    actors: [
      {
        id: ACTOR_ID,
        companyId: COMPANY_ID,
        name: ROLE_NAMES[entry.actorRole] ?? ROLE_NAMES.engineer!,
        role: entry.actorRole,
        status: "active",
        budgetId: "budget-actor-1",
        capabilityGrants: entry.scenarioClaims,
      },
    ],
    tasks: [activeTask],
  };
  const refs: CapabilityScenarioFixture["refs"] = {
    approvalId: null,
    documentKey: null,
    baseRevisionId: null,
    interactionId: null,
    blockingTaskId: null,
    serviceId: null,
    peerActorId: null,
  };

  applySeedKind(seedKind, seed, refs, entry);
  return { seed, taskId: TASK_ID, actorId: ACTOR_ID, refs };
}

function applySeedKind(
  seedKind: CapabilitySeedKind,
  seed: CapabilityFixtureSeed,
  refs: CapabilityScenarioFixture["refs"],
  entry: CapabilityScenarioIndexEntry,
): void {
  switch (seedKind) {
    case "baseline":
      return;
    case "comment_wake":
      seed.comments = [
        {
          id: "comment-seed-1",
          taskId: TASK_ID,
          authorActorId: null,
          body: "What is the current status of this task, and is anything blocking it?",
          createdAt: at(0),
        },
      ];
      return;
    case "approval_pending":
      refs.approvalId = "approval-seed-1";
      seed.approvals = [
        {
          id: refs.approvalId,
          companyId: COMPANY_ID,
          taskIds: [TASK_ID],
          type: "mcp_tool_access",
          status: "pending",
          requestedByActorId: PEER_ACTOR_ID,
          payload: { tool: "vendor_api", scope: "read" },
          decisionNote: null,
          comments: [],
          createdAt: at(0),
          decidedAt: null,
        },
      ];
      addPeerActor(seed);
      return;
    case "approval_decided":
      refs.approvalId = "approval-seed-1";
      seed.approvals = [
        {
          id: refs.approvalId,
          companyId: COMPANY_ID,
          taskIds: [TASK_ID],
          type: "spend_authorisation",
          status: "pending",
          requestedByActorId: PEER_ACTOR_ID,
          payload: { amountCents: 4_200, vendor: "fixture-vendor" },
          decisionNote: null,
          comments: [
            {
              id: "approval-comment-seed-1",
              authorActorId: PEER_ACTOR_ID,
              body: "Requested for the fixture vendor renewal.",
              createdAt: at(30),
            },
          ],
          createdAt: at(0),
          decidedAt: null,
        },
      ];
      addPeerActor(seed);
      return;
    case "blocker_graph": {
      refs.blockingTaskId = "task-blocker-1";
      seed.tasks = [
        ...(seed.tasks ?? []),
        task({
          id: refs.blockingTaskId,
          identifier: "MCK-103",
          title: "Upstream fixture dependency",
          status: "in_progress",
          assigneeActorId: PEER_ACTOR_ID,
        }),
        task({
          id: "task-blocker-2",
          identifier: "MCK-104",
          title: "Cancelled fixture dependency",
          status: "cancelled",
          assigneeActorId: PEER_ACTOR_ID,
        }),
      ];
      seed.blockers = [
        { id: "blocker-seed-1", taskId: TASK_ID, blockedByTaskId: refs.blockingTaskId, createdAt: at(0) },
      ];
      addPeerActor(seed);
      return;
    }
    case "children_done":
      refs.blockingTaskId = "task-child-1";
      seed.tasks = [
        ...(seed.tasks ?? []),
        task({
          id: refs.blockingTaskId,
          identifier: "MCK-105",
          title: "Completed fixture child",
          status: "done",
          parentId: TASK_ID,
          assigneeActorId: PEER_ACTOR_ID,
          completedAt: at(60),
        }),
      ];
      addPeerActor(seed);
      return;
    case "interaction_pending":
      refs.interactionId = "interaction-seed-1";
      const selectedOptionIds =
        entry.id === "ix-checkbox-result-01"
          ? ["selected-task-1", "selected-task-2", "selected-task-3", "selected-task-4"]
          : ["accept"];
      seed.interactions = [
        {
          id: refs.interactionId,
          taskId: TASK_ID,
          kind: "confirmation",
          status: "answered",
          title: "Confirm the fixture plan",
          prompt: "Does the recorded plan match the intended scope?",
          payload: { options: ["accept", "revise"] },
          targetRevisionId: null,
          continuationPolicy: "wake_assignee",
          result: { outcome: "accepted", selectedOptionIds },
          createdAt: at(0),
          resolvedAt: at(120),
        },
      ];
      return;
    case "document_draft":
      refs.documentKey = "plan";
      refs.baseRevisionId = "document-revision-seed-1";
      seed.documents = [
        {
          id: "document-seed-1",
          taskId: TASK_ID,
          key: refs.documentKey,
          title: "Plan",
          format: "markdown",
          latestRevisionId: refs.baseRevisionId,
          revisions: [
            {
              id: refs.baseRevisionId,
              documentId: "document-seed-1",
              revision: 1,
              body: "# Plan\n\nInitial fixture draft awaiting review.\n",
              changeSummary: "seed revision",
              createdAt: at(0),
            },
          ],
        },
      ];
      return;
    case "deliverable_pending":
      seed.comments = [
        {
          id: "comment-seed-1",
          taskId: TASK_ID,
          authorActorId: null,
          body: "Attach the generated report to the task before closing it.",
          createdAt: at(0),
        },
      ];
      return;
    case "workspace_service":
      refs.serviceId = "service-seed-1";
      seed.workspaceServices = [
        {
          id: refs.serviceId,
          taskId: TASK_ID,
          name: "preview",
          status: "stopped",
          url: null,
          lastTransitionAt: at(0),
        },
      ];
      return;
    case "second_actor":
      refs.peerActorId = PEER_ACTOR_ID;
      addPeerActor(seed);
      return;
    case "budget_tight":
      seed.budgets = [
        { id: "budget-company-1", scope: "company", scopeId: COMPANY_ID, limitCents: 10_000, spentCents: 9_800, hardStop: true },
        { id: "budget-actor-1", scope: "actor", scopeId: ACTOR_ID, limitCents: 1_000, spentCents: 940, hardStop: true },
      ];
      return;
    case "checkout_conflict":
      seed.tasks = [
        ...(seed.tasks ?? []),
        task({
          id: "task-locked-1",
          identifier: "MCK-106",
          title: "Task already checked out by another run",
          status: "in_progress",
          assigneeActorId: PEER_ACTOR_ID,
          checkoutRunId: "run-other-1",
          executionRunId: "run-other-1",
          startedAt: at(0),
        }),
      ];
      addPeerActor(seed);
      return;
    case "skill_test":
      seed.comments = [
        {
          id: "comment-seed-1",
          taskId: TASK_ID,
          authorActorId: null,
          body: `Skill-test harness case ${entry.id}: record the structured result in the output document.`,
          createdAt: at(0),
        },
      ];
      return;
  }
}

function addPeerActor(seed: CapabilityFixtureSeed): void {
  if (seed.actors?.some((actor) => actor.id === PEER_ACTOR_ID) === true) return;
  seed.actors = [
    ...(seed.actors ?? []),
    {
      id: PEER_ACTOR_ID,
      companyId: COMPANY_ID,
      name: "Mock Teammate",
      role: "engineer",
      status: "active",
      budgetId: "budget-actor-2",
      capabilityGrants: [],
    },
  ];
  seed.budgets = [
    ...(seed.budgets ?? [
      { id: "budget-company-1", scope: "company", scopeId: COMPANY_ID, limitCents: 10_000, spentCents: 0, hardStop: true },
      { id: "budget-actor-1", scope: "actor", scopeId: ACTOR_ID, limitCents: 1_000, spentCents: 0, hardStop: true },
    ]),
    { id: "budget-actor-2", scope: "actor", scopeId: PEER_ACTOR_ID, limitCents: 1_000, spentCents: 0, hardStop: true },
  ];
}

export const CAPABILITY_FIXTURE_EPOCH_MS = FIXTURE_EPOCH_MS;
export const CAPABILITY_FIXTURE_TASK_ID = TASK_ID;
export const CAPABILITY_FIXTURE_ACTOR_ID = ACTOR_ID;
export const CAPABILITY_FIXTURE_PEER_ACTOR_ID = PEER_ACTOR_ID;
