import { describe, expect, it, vi } from "vitest";

import {
  DurableAuthorityStoreError,
  type DurableAuthorityStore,
} from "./durable-authority-store.js";
import { eventEpochCloseId } from "./event-epochs.js";
import type {
  DurableRecoveryCommittedEvent,
  DurableRecoveryIdentity,
} from "./prp-transport-types.js";
import {
  processOwnerChanges,
  processOwnerEvidence,
  type ProcessOwnerEvidence,
} from "./process-owner-evidence.js";

const identity: DurableRecoveryIdentity = {
  runnerInstanceId: "runner-owner-test",
  environmentLeaseId: "lease-owner-test",
  runId: "run-owner-test",
  normalizedSessionId: "session-owner-test",
  turnId: "turn-owner-test",
  itemId: "item-owner-test",
};
const previousEpoch = "00000000-0000-4000-8000-000000000101";
const nextEpoch = "00000000-0000-4000-8000-000000000102";
const launchId = "00000000-0000-4000-8000-000000000103";
const opaqueGeneration = "p:00000000-0000-4000-8000-000000000104";

function event(options: {
  phase?: "intent" | "spawned" | "initialization_failed";
  sourceSeq?: number;
  sourceEpoch?: string;
  launch?: string;
  previousGeneration?: number;
  attemptedGeneration?: number | string;
  owner?: DurableRecoveryIdentity;
} = {}): DurableRecoveryCommittedEvent {
  const phase = options.phase ?? "intent";
  const owner = options.owner ?? identity;
  const startup = {
    schema: "paperclip.provider_startup.v1",
    launchId: options.launch ?? launchId,
    phase,
    attemptedProcessGeneration: options.attemptedGeneration ?? 1,
    ...(options.previousGeneration !== undefined
      ? { previousProcessGeneration: options.previousGeneration }
      : {}),
    configurationFingerprint: `sha256:${"a".repeat(64)}`,
    origin: {
      runnerInstanceId: owner.runnerInstanceId,
      runId: owner.runId,
      normalizedSessionId: owner.normalizedSessionId,
      turnId: owner.turnId,
      itemId: owner.itemId,
    },
    ...(phase === "spawned" ? { processId: 1200, processGroupId: 1200 } : {}),
    processTreeRetired: false,
  };
  return {
    sourceSeq: options.sourceSeq ?? 1,
    sourceEventId: `event-${options.sourceSeq ?? 1}`,
    ...(options.sourceEpoch ? { sourceEpoch: options.sourceEpoch } : {}),
    eventType: "harness.diagnostic",
    priority: 1,
    envelope: {
      payload: {
        payload: { code: "provider_startup_ownership", startup },
      },
    },
    deliveryCount: 1,
    logicalEffectCount: 1,
  };
}

function ownerFact(options: Parameters<typeof event>[0] = {}): ProcessOwnerEvidence {
  return processOwnerEvidence(event(options), identity)!;
}

function authorityWithOwner(
  prior: ProcessOwnerEvidence,
  receiptBody: Record<string, unknown>,
) {
  const getWork = vi.fn(async () => ({
    collection: "process-owner" as const,
    id: launchId,
    body: prior as unknown as Record<string, unknown>,
    sha256: "a".repeat(64),
  }));
  const getRecord = vi.fn(async () => ({
    epoch: identity.runId,
    kind: "effect" as const,
    id: eventEpochCloseId({ runId: identity.runId, fromEpoch: previousEpoch }),
    sequence: "0",
    body: receiptBody,
  }));
  return {
    authority: { getWork, getRecord } as unknown as DurableAuthorityStore,
    getWork,
    getRecord,
  };
}

function validCloseReceipt(): Record<string, unknown> {
  return {
    schema: "paperclip.prp.event-epoch.v1",
    runId: identity.runId,
    transitionId: "00000000-0000-4000-8000-000000000105",
    fromEpoch: previousEpoch,
    nextEpoch,
    finalOrdinal: 2,
  };
}

describe("provider process owner evidence", () => {
  it("accepts opaque generation startup only with its predecessor and compatible launch UUIDs", () => {
    const opaque = processOwnerEvidence(
      event({
        attemptedGeneration: opaqueGeneration,
        previousGeneration: Number.MAX_SAFE_INTEGER,
      }),
      identity,
    );
    expect(opaque?.startup).toMatchObject({
      attemptedProcessGeneration: opaqueGeneration,
      previousProcessGeneration: Number.MAX_SAFE_INTEGER,
    });

    // Retained startup launch IDs are UUID-shaped identities, not process
    // generation tokens; accept a valid older UUID version as native parsing does.
    expect(
      processOwnerEvidence(
        event({ launch: "00000000-0000-1000-8000-000000000103" }),
        identity,
      ),
    ).not.toBeNull();
    expect(() =>
      processOwnerEvidence(
        event({ attemptedGeneration: opaqueGeneration }),
        identity,
      ),
    ).toThrow(DurableAuthorityStoreError);
    expect(() =>
      processOwnerEvidence(
        event({ attemptedGeneration: "p:malformed", previousGeneration: 1 }),
        identity,
      ),
    ).toThrow(DurableAuthorityStoreError);
  });

  it("rejects evidence whose startup origin belongs to a different task identity", () => {
    for (const key of [
      "runnerInstanceId",
      "runId",
      "normalizedSessionId",
      "turnId",
      "itemId",
    ] as const) {
      const foreign = { ...identity, [key]: `other-${identity[key]}` };
      expect(() => processOwnerEvidence(event({ owner: foreign }), identity)).toThrow(
        DurableAuthorityStoreError,
      );
    }
  });

  it("rejects advancement that changes the launch or its recorded predecessor", async () => {
    const prior = ownerFact({
      phase: "intent",
      attemptedGeneration: opaqueGeneration,
      previousGeneration: Number.MAX_SAFE_INTEGER,
    });
    const differentLaunch = ownerFact({
      phase: "spawned",
      attemptedGeneration: opaqueGeneration,
      previousGeneration: Number.MAX_SAFE_INTEGER,
      launch: "00000000-0000-4000-8000-000000000106",
    });
    const validSuccessor = ownerFact({
      phase: "spawned",
      attemptedGeneration: opaqueGeneration,
      previousGeneration: Number.MAX_SAFE_INTEGER,
    });
    const differentPredecessor: ProcessOwnerEvidence = {
      ...validSuccessor,
      startup: {
        ...validSuccessor.startup,
        previousProcessGeneration: Number.MAX_SAFE_INTEGER - 1,
      },
    };
    const { authority } = authorityWithOwner(prior, validCloseReceipt());

    await expect(
      processOwnerChanges(authority, [differentLaunch], {
        runId: identity.runId,
      }),
    ).rejects.toMatchObject({ code: "invalid_authority" });
    await expect(
      processOwnerChanges(authority, [differentPredecessor], {
        runId: identity.runId,
      }),
    ).rejects.toMatchObject({ code: "invalid_authority" });
  });

  it("advances maintenance ownership only through the current run's exact raw epoch close", async () => {
    const prior = ownerFact({ phase: "intent", sourceSeq: 2, sourceEpoch: previousEpoch });
    const next = ownerFact({ phase: "spawned", sourceSeq: 1, sourceEpoch: nextEpoch });
    const { authority, getRecord } = authorityWithOwner(prior, validCloseReceipt());

    const changes = await processOwnerChanges(authority, [next], {
      runId: identity.runId,
      sourceEpoch: nextEpoch,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      collection: "process-owner",
      id: launchId,
      expectedSha256: "a".repeat(64),
      body: next,
    });
    expect(getRecord).toHaveBeenCalledWith(
      identity.runId,
      "effect",
      eventEpochCloseId({ runId: identity.runId, fromEpoch: previousEpoch }),
    );
  });

  it("rejects a rollover backed by a close receipt from another raw run", async () => {
    const prior = ownerFact({ phase: "intent", sourceSeq: 2, sourceEpoch: previousEpoch });
    const next = ownerFact({ phase: "spawned", sourceSeq: 1, sourceEpoch: nextEpoch });
    const receipt = { ...validCloseReceipt(), runId: "other-run" };
    const { authority } = authorityWithOwner(prior, receipt);

    await expect(
      processOwnerChanges(authority, [next], {
        runId: identity.runId,
        sourceEpoch: nextEpoch,
      }),
    ).rejects.toMatchObject({ code: "invalid_authority" });
  });

  it("rejects maintenance facts outside the current raw run and epoch", async () => {
    const prior = ownerFact({ phase: "intent", sourceSeq: 2, sourceEpoch: previousEpoch });
    const next = ownerFact({ phase: "spawned", sourceSeq: 1, sourceEpoch: nextEpoch });
    const { authority, getRecord } = authorityWithOwner(prior, validCloseReceipt());

    await expect(
      processOwnerChanges(authority, [next], {
        runId: "another-run",
        sourceEpoch: nextEpoch,
      }),
    ).rejects.toMatchObject({ code: "invalid_authority" });
    await expect(
      processOwnerChanges(authority, [next], {
        runId: identity.runId,
        sourceEpoch: previousEpoch,
      }),
    ).rejects.toMatchObject({ code: "invalid_authority" });
    expect(getRecord).not.toHaveBeenCalled();
  });
});
