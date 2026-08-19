import type {
  CapabilityJsonValue,
  CapabilitySemanticCommand,
} from "../mock-core/capability-control-plane-types.js";
import type { CapabilityScenarioIndexEntry } from "../scenarios/scenario-explorer-types.js";
import type { CapabilityScenarioFixture } from "./scenario-fixtures.js";
import {
  CREATED_INTERACTION_REF,
  capabilityScenarioPlan,
  type CapabilityPlanStep,
} from "./scenario-plan.js";

/**
 * Conversational scripts for the Scenario chat chat.
 *
 * A 7F scenario plan is single-shot: one fake-agent script for one run. The
 * chat needs the same work split across user turns so turn grouping, per-turn
 * diffs, and per-turn verdicts are actually exercised (7I map §11). A script is
 * data, never behaviour — the mock core still decides every outcome, and a
 * scripted turn asserts nothing about what it will produce.
 *
 * Two scenarios carry authored multi-turn conversations because the acceptance
 * matrix names them; every other scenario falls back to its 7F plan as a single
 * scripted turn, which keeps the whole 49-case corpus openable in chat without
 * inventing dialogue the traceability rows do not support.
 */

/**
 * A control-plane-owned action the conversation triggers with no agent tool:
 * the board answering its own interaction is control-plane work, so the chat
 * has to be able to script it without pretending a semantic operation exists.
 */
export interface CapabilityControlPlaneCommandStep {
  kind: "control_plane_command";
  command: CapabilitySemanticCommand;
  idempotencySuffix: string;
  summary: string;
}

export type CapabilityChatStep = CapabilityPlanStep | CapabilityControlPlaneCommandStep;

export interface CapabilityChatScriptTurn {
  /** The prompt the scripted board member sends to open this turn. */
  prompt: string;
  steps: CapabilityChatStep[];
}

export interface CapabilityChatScript {
  scenarioId: string;
  /** True when the turns were authored for chat rather than derived. */
  authored: boolean;
  turns: CapabilityChatScriptTurn[];
  controlPlaneCapabilities: Array<{ operationId: string; reason: string }>;
  restraint: boolean;
}

export function capabilityChatScript(
  entry: CapabilityScenarioIndexEntry,
  fixture: CapabilityScenarioFixture,
): CapabilityChatScript {
  const plan = capabilityScenarioPlan(entry, fixture);
  const authored = AUTHORED_CHAT_SCRIPTS[entry.id]?.(entry);
  return {
    scenarioId: entry.id,
    authored: authored !== undefined,
    turns: authored ?? [{ prompt: derivedPrompt(entry), steps: plan.steps }],
    controlPlaneCapabilities: plan.controlPlaneCapabilities,
    restraint: plan.restraint,
  };
}

type ChatScriptFactory = (entry: CapabilityScenarioIndexEntry) => CapabilityChatScriptTurn[];

const AUTHORED_CHAT_SCRIPTS: Record<string, ChatScriptFactory> = {
  /*
   * Two turns that separate reading from asking: turn 1 changes no state, turn
   * 2 opens an interaction and makes the control plane schedule the
   * continuation wake — so the per-turn diff and the reconciliation row have
   * something real to show side by side.
   */
  "ix-checkbox-01": (entry) => [
    {
      prompt: "What scope options does the board already have on this task?",
      steps: [
        read("get_task_context", {}, "Read the options the board already has."),
        message(
          "The task is scoped to a subset selection and no interaction is open yet, so nothing is waiting on the board.",
        ),
      ],
    },
    {
      prompt: "Ask them to pick which scopes stay in, then park until they answer.",
      steps: [
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
        message(
          `Subset selection for ${entry.id} is parked until the continuation wake arrives.`,
        ),
      ],
    },
    {
      prompt: "Scope A and Scope C stay in — we are dropping Scope B.",
      steps: [
        {
          kind: "control_plane_command",
          idempotencySuffix: "resolve-checkbox",
          command: {
            kind: "resolve_human_input",
            interactionId: CREATED_INTERACTION_REF(1),
            outcome: "accepted",
            result: { selectedOptionIds: ["scope-a", "scope-c"] },
          },
          summary:
            "Control plane recorded the board's answer and scheduled the continuation wake — no agent tool exists for this.",
        },
        read(
          "get_task_context",
          {},
          "Re-read the task on the continuation wake before acting on the selection.",
        ),
        message(
          "The board kept Scope A and Scope C. The continuation wake is scheduled, so the next heartbeat picks the task up with the answer already attached.",
        ),
      ],
    },
  ],

  /*
   * Turn 1 succeeds, turn 2 is denied. Keeping them apart is the point: the
   * chat has to show that a denial is a recorded turn outcome with its own
   * authorization slice, not a failed session.
   */
  "ap-mcp-gate-01": (entry) => [
    {
      prompt: "Where does the MCP tool approval for this task stand?",
      steps: [
        read("get_task_context", {}, "Read the task before touching the gated capability."),
        read("list_approvals", {}, "Check the approval queue for the pending gate."),
        message(
          "The approval queue is readable with the claims this run holds, and the MCP gate is still pending a decision.",
        ),
      ],
    },
    {
      prompt: "Raise the approval request yourself and get the tool switched on.",
      steps: [
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
    },
  ],
};

/**
 * The derived prompt names the case rather than inventing dialogue: a script
 * that has not been authored for chat should read as a replay of the 7F plan,
 * not as a conversation someone actually had.
 */
function derivedPrompt(entry: CapabilityScenarioIndexEntry): string {
  return `Handle this wake: ${entry.title}`;
}

function message(text: string): CapabilityChatStep {
  return { kind: "agent_message", text };
}

function read(operationId: string, input: CapabilityJsonValue, summary: string): CapabilityChatStep {
  return { kind: "tool_call", operationId, input, summary };
}

function write(
  operationId: string,
  input: CapabilityJsonValue,
  idempotencySuffix: string,
  summary: string,
): CapabilityChatStep {
  return { kind: "tool_call", operationId, input, idempotencySuffix, summary };
}
