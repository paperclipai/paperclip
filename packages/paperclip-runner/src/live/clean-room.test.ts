import { describe, expect, it } from "vitest";

import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../semantic-tools/catalog.js";
import {
  createCapabilitySemanticPolicyContext,
  exposedCapabilitySemanticDescriptors,
} from "../semantic-tools/policy.js";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import {
  assertCapabilityCleanRoomSeedIsBlank,
  createCapabilityCleanRoomIdentity,
  createCapabilityCleanRoomSeed,
  createCapabilityCleanRoomSessionInput,
  CAPABILITY_CLEAN_ROOM_CLAIMS,
  CAPABILITY_CLEAN_ROOM_SCENARIO,
  CAPABILITY_CLEAN_ROOM_WITHHELD_CLAIMS,
} from "./clean-room.js";

async function exposedOperations(): Promise<Set<string>> {
  const { identity, input } = createCapabilityCleanRoomSessionInput({ workingDirectory: "/tmp/none" });
  const port = new CapabilityMockControlPlaneAdapter(input.seed);
  await port.start();
  const context = await port.openFixtureRun({
    identity: {
      runId: "run-clean-room",
      sessionId: "session-clean-room",
      companyId: identity.companyId,
      issueId: identity.taskId,
      agentId: identity.actorId,
    },
    backendKind: "runner",
    sourceInstanceId: "capability-clean-room-test",
    capabilities: input.capabilities ?? [],
  });
  const policy = createCapabilitySemanticPolicyContext(
    context,
    CAPABILITY_CLEAN_ROOM_SCENARIO,
    input.explicitClaims ?? [],
  );
  const exposed = new Set(
    exposedCapabilitySemanticDescriptors(policy).map((descriptor) => descriptor.operationId),
  );
  await port.stop();
  return exposed;
}

describe("Capability clean-room seed", () => {
  it("seeds only a company, an agent, and one blank work issue", () => {
    const identity = createCapabilityCleanRoomIdentity({ token: "abc12345", sequence: 4242 });
    const state = createCapabilityCleanRoomSeed(identity);

    expect(state.company.id).toBe("company-cleanroom-abc12345");
    expect(state.actors).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.identifier).toBe("MCK-4242");
    expect(state.tasks[0]?.status).toBe("todo");
    expect(state.tasks[0]?.description).toBeNull();
    expect(state.comments).toEqual([]);
    expect(state.documents).toEqual([]);
    expect(state.interactions).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.blockers).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(() => assertCapabilityCleanRoomSeedIsBlank(state)).not.toThrow();
  });

  it("refuses a seed that carries a transcript or any other prior record", () => {
    const identity = createCapabilityCleanRoomIdentity({ token: "abc12345", sequence: 1 });
    const seeded = createCapabilityCleanRoomSeed(identity);
    seeded.comments.push({
      id: "comment-1",
      taskId: identity.taskId,
      authorActorId: identity.actorId,
      body: "a scripted opening line",
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    expect(() => assertCapabilityCleanRoomSeedIsBlank(seeded)).toThrow(/must be blank; seeded: comments/);
  });

  it("mints a distinct mock tenant on every open", () => {
    const identities = Array.from({ length: 8 }, () => createCapabilityCleanRoomIdentity());
    expect(new Set(identities.map((identity) => identity.companyId)).size).toBe(8);
    expect(new Set(identities.map((identity) => identity.actorId)).size).toBe(8);
    expect(new Set(identities.map((identity) => identity.taskId)).size).toBe(8);
    for (const identity of identities) {
      expect(identity.identifier.startsWith("MCK-")).toBe(true);
    }
  });
});

describe("Capability clean-room exposure profile", () => {
  it("is deterministic and independent of the conversation", async () => {
    expect(await exposedOperations()).toEqual(await exposedOperations());
  });

  it("exposes the read, comment, document, interaction, and delegation tools", async () => {
    const exposed = await exposedOperations();
    for (const operationId of [
      "get_task_context",
      "report_progress",
      "write_document",
      "request_human_input",
      "register_deliverable",
      "create_task",
      "search_tasks",
      "request_approval",
      "finish_task",
    ]) {
      expect(exposed, `expected ${operationId} to be exposed`).toContain(operationId);
    }
  });

  it("withholds the grants that keep a denial reachable in an unscripted chat", async () => {
    const exposed = await exposedOperations();
    for (const operationId of [
      "decide_approval",
      "control_workspace_service",
      "generic_api_request",
    ]) {
      expect(exposed, `expected ${operationId} to be withheld`).not.toContain(operationId);
    }
    for (const claim of CAPABILITY_CLEAN_ROOM_WITHHELD_CLAIMS) {
      expect(CAPABILITY_CLEAN_ROOM_CLAIMS).not.toContain(claim);
    }
  });

  it("only names claims the accepted catalog actually requires", () => {
    const catalogClaims = new Set(
      CAPABILITY_SEMANTIC_TOOL_CATALOG.flatMap((descriptor) => descriptor.requiredClaims),
    );
    for (const claim of [...CAPABILITY_CLEAN_ROOM_CLAIMS, ...CAPABILITY_CLEAN_ROOM_WITHHELD_CLAIMS]) {
      // `control_plane:*` claims are enforced at the mock command boundary
      // rather than by a catalog descriptor, so they are exempt.
      if (claim.startsWith("control_plane:")) continue;
      expect(catalogClaims, `unknown claim ${claim}`).toContain(claim);
    }
  });
});
