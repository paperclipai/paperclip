import { randomInt, randomUUID } from "node:crypto";

import {
  createCapabilityFixtureState,
  type CapabilityFixtureState,
} from "../mock-core/capability-control-plane-types.js";
import type { CapabilitySemanticScenarioPolicy } from "../semantic-tools/types.js";
import { capabilityFixtureRunCapabilities } from "../scenarios/fixture-run-capabilities.js";
import type { CreateCapabilityLiveSessionInput } from "./live-session.js";

/**
 * Clean-room chat seed and policy (Capability plan revision 5, track 7M).
 *
 * The scenario explorer seeds a recorded eval case: a transcript, scripted tool
 * calls, parity verdicts, and fixture evidence. The clean room deliberately
 * seeds none of that. It creates the smallest mock tenant that can scope a
 * runner session — one company, one agent, one blank work issue — and hands it
 * to the same real runnerd + real Codex loop the scenario path uses. What the
 * model then does is driven only by the free-form conversation.
 *
 * Every clean-room open mints fresh identities. That is the mechanism behind
 * `New chat` and `Reset`: a new tenant is a new tenant, not a cleared view of
 * the old one, so the prior session's authority can be retired without any
 * chance of the next chat inheriting its records.
 */

export const CAPABILITY_CLEAN_ROOM_SCENARIO_ID = "capability-clean-room" as const;

/**
 * Model-visible grants. This is the deterministic, inspectable half of the
 * clean room: the exposure profile is fixed, the calls are not.
 *
 * The three omissions are load-bearing rather than accidental:
 * `governance:approvals:decide` (the agent proposes, the board decides),
 * `workspace:control` (no service lifecycle from a chat), and
 * `test:generic_api_request` (the escape hatch stays off). Each produces a
 * typed denial with a named code if the model reaches for it, which is what
 * makes "denied" demonstrable in a chat nobody scripted.
 */
export const CAPABILITY_CLEAN_ROOM_CLAIMS: readonly string[] = Object.freeze([
  "control_plane:interactions",
  "control_plane:wakes",
  "delegation:tasks:create",
  "dependencies:write",
  "discovery:agents:read",
  "discovery:tasks:read",
  "governance:approvals:comment",
  "governance:approvals:read",
  "governance:approvals:request",
  "workspace:read",
]);

/** Grants that stay withheld so a denial is always reachable. */
export const CAPABILITY_CLEAN_ROOM_WITHHELD_CLAIMS: readonly string[] = Object.freeze([
  "governance:approvals:decide",
  "test:generic_api_request",
  "workspace:control",
]);

export const CAPABILITY_CLEAN_ROOM_SCENARIO: CapabilitySemanticScenarioPolicy = Object.freeze({
  id: CAPABILITY_CLEAN_ROOM_SCENARIO_ID,
  claims: CAPABILITY_CLEAN_ROOM_CLAIMS,
  allowedInteractionKinds: [
    "questions",
    "confirmation",
    "checkbox",
    "suggest_tasks",
    "item_verdicts",
  ] as const,
  enableGenericApiRequest: false,
});

export interface CapabilityCleanRoomIdentity {
  /** Short opaque token that separates one clean room from the next. */
  token: string;
  /** Mock issue number. Rendered as `MCK-<sequence>` in the header. */
  sequence: number;
  companyId: string;
  actorId: string;
  taskId: string;
  identifier: string;
}

export interface CapabilityCleanRoomIdentityInput {
  token?: string;
  sequence?: number;
}

export function createCapabilityCleanRoomIdentity(
  input: CapabilityCleanRoomIdentityInput = {},
): CapabilityCleanRoomIdentity {
  const token = (input.token ?? randomUUID().replaceAll("-", "").slice(0, 8)).toLowerCase();
  const sequence = input.sequence ?? randomInt(1_000, 10_000);
  return {
    token,
    sequence,
    companyId: `company-cleanroom-${token}`,
    actorId: `actor-cleanroom-${token}`,
    taskId: `task-cleanroom-${token}`,
    identifier: `MCK-${sequence}`,
  };
}

export interface CapabilityCleanRoomSeedOptions {
  epochMs?: number;
}

/**
 * The minimum records a runner session needs to be scoped at all: a company to
 * own it, an agent to act as, and one blank issue to act on.
 */
export function createCapabilityCleanRoomSeed(
  identity: CapabilityCleanRoomIdentity,
  options: CapabilityCleanRoomSeedOptions = {},
): CapabilityFixtureState {
  return createCapabilityFixtureState({
    ...(options.epochMs === undefined ? {} : { epochMs: options.epochMs }),
    company: {
      id: identity.companyId,
      name: "Mock Paperclip (clean room)",
      issuePrefix: "MCK",
      status: "active",
      budgetId: `budget-${identity.companyId}`,
    },
    actors: [
      {
        id: identity.actorId,
        companyId: identity.companyId,
        name: "Mock Agent",
        role: "engineer",
        status: "active",
        budgetId: `budget-${identity.actorId}`,
        capabilityGrants: [],
      },
    ],
    tasks: [
      {
        id: identity.taskId,
        companyId: identity.companyId,
        identifier: identity.identifier,
        title: "Clean-room chat",
        description: null,
        status: "todo",
        priority: "medium",
        workMode: "standard",
        parentId: null,
        assigneeActorId: identity.actorId,
        checkoutRunId: null,
        executionRunId: null,
        startedAt: null,
        completedAt: null,
      },
    ],
  });
}

/** Record classes that a clean room must not start with. */
const SEEDED_RECORD_KEYS = [
  "comments",
  "documents",
  "interactions",
  "approvals",
  "artifacts",
  "workProducts",
  "blockers",
  "workspaceServices",
  "wakes",
  "faults",
] as const satisfies ReadonlyArray<keyof CapabilityFixtureState>;

/**
 * Fails closed if a clean room was handed anything to remember. A blank thread
 * is an acceptance criterion, so it is checked at the seam that creates the
 * session rather than trusted to stay true.
 */
export function assertCapabilityCleanRoomSeedIsBlank(state: CapabilityFixtureState): void {
  const seeded = SEEDED_RECORD_KEYS.filter((key) => (state[key] as unknown[]).length > 0);
  if (seeded.length > 0) {
    throw new Error(`Capability clean-room seed must be blank; seeded: ${seeded.join(", ")}`);
  }
  if (state.tasks.length !== 1 || state.actors.length !== 1) {
    throw new Error("Capability clean-room seed must hold exactly one actor and one task");
  }
}

export interface CapabilityCleanRoomSessionOptions {
  workingDirectory: string;
  identity?: CapabilityCleanRoomIdentity;
  epochMs?: number;
  turnTimeoutMs?: number;
}

export interface CapabilityCleanRoomSessionInput {
  identity: CapabilityCleanRoomIdentity;
  input: CreateCapabilityLiveSessionInput;
}

/**
 * Builds the `CapabilityLiveSessionService.create` input for one clean room. The
 * run holds the adapter claims the mock command boundary needs, while the model
 * only ever sees the scenario claims — the union widens the port, never the
 * tool catalog.
 */
export function createCapabilityCleanRoomSessionInput(
  options: CapabilityCleanRoomSessionOptions,
): CapabilityCleanRoomSessionInput {
  const identity = options.identity ?? createCapabilityCleanRoomIdentity();
  const seed = createCapabilityCleanRoomSeed(identity, {
    ...(options.epochMs === undefined ? {} : { epochMs: options.epochMs }),
  });
  assertCapabilityCleanRoomSeedIsBlank(seed);
  return {
    identity,
    input: {
      seed,
      workingDirectory: options.workingDirectory,
      scenario: CAPABILITY_CLEAN_ROOM_SCENARIO,
      capabilities: capabilityFixtureRunCapabilities(CAPABILITY_CLEAN_ROOM_CLAIMS),
      explicitClaims: [...CAPABILITY_CLEAN_ROOM_CLAIMS],
      companyId: identity.companyId,
      actorId: identity.actorId,
      taskId: identity.taskId,
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    },
  };
}
