/**
 * PAP-17419 regression coverage for central exposure reservation/ownership
 * mediation.
 *
 * Each `describe` below is one of the five regression requirements on the
 * issue, named so a reviewer can map test → requirement without reading the
 * bodies. The scenario ports and workspace IDs mirror the PAP-17251 finding:
 * lane B held `42001/52001` under an open lease while the unrelated workspace
 * `PAP-16986-add-posthog-mcp` took the pair.
 */
import { describe, expect, it } from "vitest";

import {
  buildExposureReservationLedger,
  collectRowExposurePorts,
  describeExposurePortConflict,
  describeExposureReservationDrift,
  ExposurePortOwnershipConflictError,
  ExposurePortPairClaims,
  findExposurePairConflict,
  findExposureReservationDrift,
  isExposureAdoptionPermitted,
  type ExposureOwnerIdentity,
  type PersistedExposureRowSnapshot,
} from "./port-reservation.js";
import { allocateExposurePortPair } from "./port-pair.js";

/** The stopped-but-leased lane from the finding. */
const LEASED_WORKSPACE = "b7ce28b4-7921-4e23-8be2-8b42193bf4ad";
/** The unrelated workspace that took its pair. */
const OTHER_WORKSPACE = "9f2c1d40-1111-4222-8333-444455556666";
const LEASED_ISSUE = "17251aaa-1111-4222-8333-444455556666";

function identity(overrides: Partial<ExposureOwnerIdentity> = {}): ExposureOwnerIdentity {
  return {
    runtimeServiceId: null,
    executionWorkspaceId: null,
    projectWorkspaceId: null,
    issueId: null,
    ...overrides,
  };
}

/**
 * A lane that has been stopped AND torn down.
 *
 * `deprovisionExposure` writes a fresh `removed` status whose `listeners` array
 * is empty, so the `port` column is the only surviving record of which pair the
 * lease owns. Reproducing that faithfully is the whole point of the fixture.
 */
function stoppedTornDownRow(overrides: Partial<PersistedExposureRowSnapshot> = {}): PersistedExposureRowSnapshot {
  return {
    id: "runtime-lane-b",
    status: "stopped",
    port: 42001,
    exposure: { state: "removed", listeners: [] },
    executionWorkspaceId: LEASED_WORKSPACE,
    projectWorkspaceId: null,
    issueId: LEASED_ISSUE,
    ...overrides,
  };
}

describe("collectRowExposurePorts", () => {
  it("derives the pair from the port column when teardown erased the listeners", () => {
    expect([...collectRowExposurePorts(stoppedTornDownRow())]).toEqual([42001, 52001]);
  });

  it("ignores a legacy pinned port outside the dedicated range", () => {
    const row = stoppedTornDownRow({ port: 45439 });
    expect([...collectRowExposurePorts(row)]).toEqual([]);
  });

  it("unions declared listeners with the port-derived pair", () => {
    const row = stoppedTornDownRow({
      exposure: { state: "ready", listeners: [{ targetPort: 42001 }, { targetPort: 52001 }] },
    });
    expect([...collectRowExposurePorts(row)].sort()).toEqual([42001, 52001]);
  });
});

describe("regression 1: stopped-but-leased pair reuse is denied", () => {
  it("reserves a torn-down lane's pair while its lease is still open", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
    });

    expect(ledger.reservedPorts.has(42001)).toBe(true);
    expect(ledger.reservedPorts.has(52001)).toBe(true);
    expect(ledger.reservationByPort.get(42001)).toMatchObject({
      source: "leased_workspace",
      owner: { executionWorkspaceId: LEASED_WORKSPACE, issueId: LEASED_ISSUE },
    });
  });

  it("denies an unrelated workspace the leased pair, naming the holder", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
    });

    const conflict = findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE, runtimeServiceId: "runtime-posthog" }),
      ledger,
    });

    expect(conflict).toMatchObject({ code: "reserved_by_other_workspace", port: 42001 });
    const message = describeExposurePortConflict(conflict!);
    expect(message).toContain("42001");
    expect(message).toContain(LEASED_WORKSPACE);
    expect(message).toContain(LEASED_ISSUE);
    // The operator must be told the lane looks stopped on purpose, or the
    // report reads as a stale-row bug rather than a live reservation.
    expect(message).toContain("lease is still open");
  });

  it("lets the leaseholder's own lane reclaim its pair on restart", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
    });

    expect(findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: LEASED_WORKSPACE, runtimeServiceId: "runtime-lane-b-restart" }),
      ledger,
    })).toBeNull();
  });

  it("keeps the HMR companion reserved even when only the app port is claimed", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
    });

    // A different pair whose app port is free but whose companion is the
    // lease's HMR port can never happen with the fixed offset, so assert the
    // companion is independently defended instead.
    expect(findExposurePairConflict({
      pair: { appPort: 52001, hmrPort: 62001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger,
    })).toMatchObject({ code: "reserved_by_other_workspace", port: 52001 });
  });

  it("still reserves nothing for a row with no lease and no exposure", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [],
    });
    expect(ledger.reservedPorts.size).toBe(0);
  });
});

describe("regression 2: cross-execution-workspace process adoption is denied", () => {
  it("refuses adoption when the execution workspace IDs differ", () => {
    expect(isExposureAdoptionPermitted(
      identity({ executionWorkspaceId: LEASED_WORKSPACE }),
      identity({ executionWorkspaceId: OTHER_WORKSPACE }),
    )).toBe(false);
  });

  it("refuses adoption when either side's workspace is unknown", () => {
    expect(isExposureAdoptionPermitted(
      identity({ executionWorkspaceId: null, runtimeServiceId: "runtime-unknown" }),
      identity({ executionWorkspaceId: OTHER_WORKSPACE }),
    )).toBe(false);
    expect(isExposureAdoptionPermitted(
      identity({ executionWorkspaceId: LEASED_WORKSPACE }),
      identity({ executionWorkspaceId: null }),
    )).toBe(false);
    // Two nulls are not "the same workspace"; they are two unknowns.
    expect(isExposureAdoptionPermitted(identity(), identity())).toBe(false);
  });

  it("permits the same workspace and the same runtime service", () => {
    expect(isExposureAdoptionPermitted(
      identity({ executionWorkspaceId: LEASED_WORKSPACE }),
      identity({ executionWorkspaceId: LEASED_WORKSPACE }),
    )).toBe(true);
    expect(isExposureAdoptionPermitted(
      identity({ runtimeServiceId: "runtime-lane-b" }),
      identity({ runtimeServiceId: "runtime-lane-b" }),
    )).toBe(true);
  });

  it("denies a pair whose live listener belongs to another workspace", () => {
    const conflict = findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger: buildExposureReservationLedger({}),
      listenerOwners: new Map([[42001, identity({ executionWorkspaceId: LEASED_WORKSPACE, issueId: LEASED_ISSUE })]]),
    });

    expect(conflict).toMatchObject({ code: "listener_owned_by_other_workspace", port: 42001 });
    expect(describeExposurePortConflict(conflict!)).toContain(LEASED_WORKSPACE);
  });

  it("denies a live listener it cannot attribute rather than assuming it is ours", () => {
    const conflict = findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger: buildExposureReservationLedger({}),
      listenerOwners: new Map([[52001, null]]),
    });

    expect(conflict).toMatchObject({ code: "listener_owned_by_other_workspace", port: 52001 });
    expect(describeExposurePortConflict(conflict!)).toContain("an unidentified owner");
  });

  it("throws a terminal, attributed error on the allocation path", () => {
    const conflict = findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger: buildExposureReservationLedger({
        persistedRows: [stoppedTornDownRow()],
        activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
      }),
    });
    const error = new ExposurePortOwnershipConflictError(conflict!);

    expect(error.code).toBe("exposure_port_ownership_conflict");
    expect(error.message).toContain("HTTPS exposure allocation denied");
    expect(error.message).toContain(LEASED_WORKSPACE);
  });
});

describe("regression 3: Serve mapping ownership mismatch is visible and fails closed", () => {
  it("denies a pair published by another workspace's Serve mapping", () => {
    const rows: PersistedExposureRowSnapshot[] = [
      {
        id: "runtime-posthog",
        status: "running",
        port: 42001,
        exposure: { state: "ready", listeners: [{ targetPort: 42001 }, { targetPort: 52001 }] },
        executionWorkspaceId: OTHER_WORKSPACE,
        projectWorkspaceId: null,
        issueId: null,
      },
    ];
    const ledger = buildExposureReservationLedger({
      persistedRows: rows,
      brokerMappings: [{ runtimeId: "runtime-posthog", port: 42001 }],
    });

    expect(ledger.reservationByPort.get(42001)).toMatchObject({
      source: "broker_mapping",
      owner: { executionWorkspaceId: OTHER_WORKSPACE },
    });

    const conflict = findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: LEASED_WORKSPACE }),
      ledger,
      serveMappingOwners: new Map([[42001, identity({ executionWorkspaceId: OTHER_WORKSPACE })]]),
    });
    expect(conflict).toMatchObject({ port: 42001 });
    expect(describeExposurePortConflict(conflict!)).toContain(OTHER_WORKSPACE);
  });

  it("reports a serve-mapping mismatch when the ledger alone would allow it", () => {
    const conflict = findExposurePairConflict({
      pair: { appPort: 42005, hmrPort: 52005 },
      claimant: identity({ executionWorkspaceId: LEASED_WORKSPACE }),
      ledger: buildExposureReservationLedger({}),
      serveMappingOwners: new Map([[52005, identity({ executionWorkspaceId: OTHER_WORKSPACE })]]),
    });

    expect(conflict).toMatchObject({ code: "serve_mapping_owned_by_other_workspace", port: 52005 });
    expect(describeExposurePortConflict(conflict!)).toContain("Tailscale Serve mapping");
  });

  it("surfaces a stopped/removed row whose reserved port is mapped to another runtime", () => {
    const drift = findExposureReservationDrift({
      persistedRows: [
        stoppedTornDownRow(),
        {
          id: "runtime-posthog",
          status: "running",
          port: null,
          exposure: null,
          executionWorkspaceId: OTHER_WORKSPACE,
          projectWorkspaceId: null,
          issueId: null,
        },
      ],
      brokerMappings: [{ runtimeId: "runtime-posthog", port: 42001 }],
    });

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      runtimeServiceId: "runtime-lane-b",
      port: 42001,
      reason: "serve_mapping",
      conflictingOwner: { executionWorkspaceId: OTHER_WORKSPACE },
    });
    const description = describeExposureReservationDrift(drift[0]!);
    expect(description).toContain("recorded stopped/removed");
    expect(description).toContain(OTHER_WORKSPACE);
  });

  it("surfaces a stopped/removed row whose reserved port still has a live listener", () => {
    const drift = findExposureReservationDrift({
      persistedRows: [stoppedTornDownRow()],
      livePorts: new Set([52001]),
    });

    expect(drift).toMatchObject([{ port: 52001, reason: "live_listener", conflictingOwner: null }]);
  });

  it("does not call a lane's own live listener drift", () => {
    const drift = findExposureReservationDrift({
      persistedRows: [stoppedTornDownRow()],
      livePorts: new Set([42001]),
      listenerOwners: new Map([[42001, identity({ runtimeServiceId: "runtime-lane-b" })]]),
    });

    expect(drift).toEqual([]);
  });

  it("does not report a running pre-exposure service's own in-range port as drift", () => {
    // The row is RUNNING with `exposure: null` — a pre-exposure service whose
    // configured port happens to sit inside the dedicated range. At startup its
    // surviving listener is unattributable (the in-memory runtime registry is
    // empty), which used to read as drift and quarantine the row before the
    // reconciler could adopt the service.
    const drift = findExposureReservationDrift({
      persistedRows: [stoppedTornDownRow({ status: "running", exposure: null })],
      livePorts: new Set([42001, 52001]),
    });

    expect(drift).toEqual([]);
  });

  it("still sweeps a stopped pre-exposure row's reserved pair", () => {
    const drift = findExposureReservationDrift({
      persistedRows: [stoppedTornDownRow({ exposure: null })],
      livePorts: new Set([42001]),
    });

    expect(drift).toMatchObject([{ port: 42001, reason: "live_listener", conflictingOwner: null }]);
  });

  it("does not report a healthy running lane as drift", () => {
    const drift = findExposureReservationDrift({
      persistedRows: [{
        id: "runtime-lane-a",
        status: "running",
        port: 42000,
        exposure: { state: "ready", listeners: [{ targetPort: 42000 }, { targetPort: 52000 }] },
        executionWorkspaceId: LEASED_WORKSPACE,
        projectWorkspaceId: null,
        issueId: null,
      }],
      livePorts: new Set([42000, 52000]),
      brokerMappings: [{ runtimeId: "runtime-lane-a", port: 42000 }],
    });

    expect(drift).toEqual([]);
  });
});

describe("regression 4: concurrent allocators return unique pairs", () => {
  it("claims both ports of a pair or neither", () => {
    const claims = new ExposurePortPairClaims();
    expect(claims.claim({ appPort: 42000, hmrPort: 52000 }, 0)).toBe(true);
    // Overlapping on either port is refused, and the refusal must not leave a
    // partial hold behind.
    expect(claims.claim({ appPort: 42000, hmrPort: 52000 }, 0)).toBe(false);
    expect(claims.claim({ appPort: 42001, hmrPort: 52000 }, 0)).toBe(false);
    expect([...claims.activePorts(0)].sort()).toEqual([42000, 52000]);
  });

  it("expires a claim after its TTL so a crashed start cannot burn the range", () => {
    const claims = new ExposurePortPairClaims(1_000);
    expect(claims.claim({ appPort: 42000, hmrPort: 52000 }, 0)).toBe(true);
    expect(claims.claim({ appPort: 42000, hmrPort: 52000 }, 500)).toBe(false);
    expect(claims.claim({ appPort: 42000, hmrPort: 52000 }, 1_001)).toBe(true);
  });

  it("hands two concurrent allocators distinct pairs", async () => {
    const claims = new ExposurePortPairClaims();
    const allocate = () => allocateExposurePortPair({
      isPortAvailable: async () => true,
      claimPair: (pair) => claims.claim(pair),
    });

    const [first, second, third] = await Promise.all([allocate(), allocate(), allocate()]);

    expect(first).toEqual({ appPort: 42000, hmrPort: 52000 });
    expect(second).toEqual({ appPort: 42001, hmrPort: 52001 });
    expect(third).toEqual({ appPort: 42002, hmrPort: 52002 });
  });

  it("gives concurrent allocators distinct pairs even when both prefer the same port", async () => {
    const claims = new ExposurePortPairClaims();
    const allocate = () => allocateExposurePortPair({
      isPortAvailable: async () => true,
      preferredAppPort: 42007,
      claimPair: (pair) => claims.claim(pair),
    });

    const [first, second] = await Promise.all([allocate(), allocate()]);

    expect(first.appPort).toBe(42007);
    expect(second.appPort).not.toBe(42007);
    expect(second.hmrPort).not.toBe(first.hmrPort);
  });

  it("does not claim a pair it rejects for availability", async () => {
    const claims = new ExposurePortPairClaims();
    await allocateExposurePortPair({
      isPortAvailable: async (port) => port !== 42000 && port !== 52000,
      claimPair: (pair) => claims.claim(pair),
    });

    // 42000 was probed and refused; holding it would waste the port for a full TTL.
    expect(claims.activePorts()).toEqual(new Set([42001, 52001]));
  });

  it("folds live claims into a ledger so a second allocator sees them", () => {
    const claims = new ExposurePortPairClaims();
    claims.claim({ appPort: 42000, hmrPort: 52000 }, 0);
    const ledger = buildExposureReservationLedger({ inFlightClaimedPorts: claims.activePorts(0) });

    expect(findExposurePairConflict({
      pair: { appPort: 42000, hmrPort: 52000 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger,
    })).toMatchObject({ code: "reserved_by_other_workspace" });
  });
});

describe("regression 5: release/teardown makes the pair reusable, sparing manual mappings", () => {
  it("frees the pair once the lease is released", () => {
    const row = stoppedTornDownRow();
    const leased = buildExposureReservationLedger({
      persistedRows: [row],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
    });
    expect(leased.reservedPorts.has(42001)).toBe(true);

    // Lease released: the workspace is archived/closed, so it no longer appears.
    const released = buildExposureReservationLedger({
      persistedRows: [row],
      activeExecutionWorkspaceIds: [],
    });

    expect(released.reservedPorts.has(42001)).toBe(false);
    expect(findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger: released,
    })).toBeNull();
  });

  it("releases an in-process claim on teardown", () => {
    const claims = new ExposurePortPairClaims();
    claims.claim({ appPort: 42001, hmrPort: 52001 }, 0);
    claims.release({ appPort: 42001, hmrPort: 52001 });

    expect(claims.activePorts(0).size).toBe(0);
    expect(claims.claim({ appPort: 42001, hmrPort: 52001 }, 0)).toBe(true);
  });

  it("keeps quarantined ports out of circulation after release", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [],
      quarantinedPorts: [42001],
    });

    const conflict = findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger,
    });
    expect(conflict).toMatchObject({ code: "quarantined_port" });
    expect(describeExposurePortConflict(conflict!)).toContain("quarantined");
  });

  it("never reserves or reports a manual/unknown mapping the broker does not own", () => {
    // The broker's `list()` structurally cannot return unknown/manual entries,
    // so a manual mapping on 42010 reaches neither the ledger nor drift. Assert
    // the absence explicitly: a release path that started reserving or
    // reporting them would be the PAP-17285 regression coming back.
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [],
      brokerMappings: [],
    });
    expect(ledger.reservedPorts.has(42010)).toBe(false);

    expect(findExposureReservationDrift({
      persistedRows: [stoppedTornDownRow({ port: 42010 })],
      brokerMappings: [],
    })).toEqual([]);
  });

  it("lets a fresh workspace take the released pair end to end", async () => {
    const claims = new ExposurePortPairClaims();
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [],
      inFlightClaimedPorts: claims.activePorts(),
    });

    const pair = await allocateExposurePortPair({
      isPortAvailable: async (port) => port >= 42001,
      reserved: ledger.reservedPorts,
      preferredAppPort: 42001,
      claimPair: (candidate) => claims.claim(candidate),
    });

    expect(pair).toEqual({ appPort: 42001, hmrPort: 52001 });
    expect(findExposurePairConflict({
      pair,
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger,
    })).toBeNull();
  });
});

describe("reservation precedence", () => {
  it("reports the strongest available evidence for a contested port", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
      inMemoryRuntimes: [{
        runtimeServiceId: "runtime-lane-b",
        executionWorkspaceId: LEASED_WORKSPACE,
        projectWorkspaceId: null,
        issueId: LEASED_ISSUE,
        ports: [42001],
      }],
      brokerMappings: [{ runtimeId: "runtime-lane-b", port: 42001 }],
    });

    // Running in this process beats a Serve mapping, which beats the lease.
    expect(ledger.reservationByPort.get(42001)?.source).toBe("in_memory_runtime");
    expect(ledger.reservationByPort.get(52001)?.source).toBe("leased_workspace");
  });

  it("quarantine outranks every other claim", () => {
    const ledger = buildExposureReservationLedger({
      persistedRows: [stoppedTornDownRow()],
      activeExecutionWorkspaceIds: [LEASED_WORKSPACE],
      quarantinedPorts: [42001],
    });

    expect(ledger.reservationByPort.get(42001)?.source).toBe("quarantine");
    // Even the leaseholder cannot take a quarantined port back.
    expect(findExposurePairConflict({
      pair: { appPort: 42001, hmrPort: 52001 },
      claimant: identity({ executionWorkspaceId: LEASED_WORKSPACE }),
      ledger,
    })).toMatchObject({ code: "quarantined_port" });
  });

  it("names an unresolvable broker runtime rather than reporting no holder", () => {
    const ledger = buildExposureReservationLedger({
      brokerMappings: [{ runtimeId: "runtime-vanished", port: 42003 }],
    });

    const conflict = findExposurePairConflict({
      pair: { appPort: 42003, hmrPort: 52003 },
      claimant: identity({ executionWorkspaceId: OTHER_WORKSPACE }),
      ledger,
    });
    expect(describeExposurePortConflict(conflict!)).toContain("runtime-vanished");
  });
});
