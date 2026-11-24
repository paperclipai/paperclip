import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DurablePrpControlPlane, inspectDurablePrpCheckpointRunner, type DurablePrpCheckpoint } from "./durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "./prp-transport-types.js";

const identity: DurableRecoveryIdentity = {
  runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "source-run",
  normalizedSessionId: "session", turnId: "turn", itemId: "item",
};
const parked = { version: "0.4.0", digest: `sha256:${"a".repeat(64)}` };

async function withCore(test: (core: DurablePrpControlPlane, checkpoints: DurablePrpCheckpoint[]) => Promise<void>, persist = false) {
  const root = mkdtempSync(resolve(tmpdir(), "runner-relaunched-build-"));
  const core = new DurablePrpControlPlane({ stateDirectory: root, identity, expectedRunnerVersion: parked.version,
    expectedRunnerDigest: parked.digest, authorityRunId: identity.runId });
  const checkpoints: DurablePrpCheckpoint[] = [];
  if (persist) core.setCheckpointPersistence(async checkpoint => { checkpoints.push(checkpoint); });
  try { await test(core, checkpoints); } finally { await core.stop(); rmSync(root, { recursive: true, force: true }); }
}

const ticketRecord = (core: DurablePrpControlPlane) => Object.values(core.store.state.tickets).at(-1)!;

it("accepts a resume-compatible relaunched build for the claim's ticket and later tickets", async () => withCore(async core => {
  const ticket = core.issueBootstrapTicket();
  const relaunched = { version: "0.4.1", digest: `sha256:${"b".repeat(64)}` };
  core.acceptRelaunchedRunner(ticket, relaunched);
  expect(ticketRecord(core)).toMatchObject({ runnerVersion: relaunched.version, runnerDigest: relaunched.digest, usedAt: null });
  core.acceptRelaunchedRunner(ticket, relaunched);
  core.issueBootstrapTicket();
  expect(ticketRecord(core)).toMatchObject({ runnerVersion: relaunched.version, runnerDigest: relaunched.digest });
}));

it("records the relaunched build in the next checkpoint", async () => withCore(async (core, checkpoints) => {
  const relaunched = { version: "0.5.0", digest: `sha256:${"c".repeat(64)}` };
  core.acceptRelaunchedRunner(core.issueBootstrapTicket(), relaunched);
  await core.flushCheckpoint();
  expect(checkpoints.at(-1)).toMatchObject({ runnerVersion: relaunched.version, runnerDigest: relaunched.digest });
}, true));

it("leaves the parked build in place for the same build", async () => withCore(async core => {
  const ticket = core.issueBootstrapTicket();
  core.acceptRelaunchedRunner(ticket, parked);
  expect(ticketRecord(core)).toMatchObject({ runnerVersion: parked.version, runnerDigest: parked.digest });
}));

it.each([
  ["an older version", { version: "0.3.9", digest: `sha256:${"b".repeat(64)}` }],
  ["a prerelease of the same version", { version: "0.4.0-rc.1", digest: `sha256:${"b".repeat(64)}` }],
  ["an unparseable version", { version: "latest", digest: `sha256:${"b".repeat(64)}` }],
  ["a malformed digest", { version: "0.4.1", digest: "sha256:short" }],
  ["a version the control plane cannot store", { version: "0.4.1+build.2", digest: `sha256:${"b".repeat(64)}` }],
])("refuses %s and keeps the parked build", async (_name, runner) => withCore(async core => {
  const ticket = core.issueBootstrapTicket();
  expect(() => core.acceptRelaunchedRunner(ticket, runner)).toThrow("native_runner_relaunched_build_unaccepted");
  expect(ticketRecord(core)).toMatchObject({ runnerVersion: parked.version, runnerDigest: parked.digest });
}));

it("refuses a ticket that is unknown or already used", async () => withCore(async core => {
  const relaunched = { version: "0.4.1", digest: `sha256:${"b".repeat(64)}` };
  expect(() => core.acceptRelaunchedRunner("bootstrap_unknown", relaunched)).toThrow("native_runner_relaunched_build_unaccepted");
  const ticket = core.issueBootstrapTicket();
  ticketRecord(core).usedAt = new Date().toISOString();
  expect(() => core.acceptRelaunchedRunner(ticket, relaunched)).toThrow("native_runner_relaunched_build_unaccepted");
}));

it("records the parked build in the checkpoint header for a later claim", async () => withCore(async (core, checkpoints) => {
  await core.flushCheckpoint();
  expect(inspectDurablePrpCheckpointRunner(checkpoints.at(-1)!.records.get("header")!)).toEqual(parked);
  expect(inspectDurablePrpCheckpointRunner("{}")).toBeNull();
}, true));

it("checks a reported build against the parked build, not only the build Core expects", async () => withCore(async core => {
  const ticket = core.issueBootstrapTicket();
  const newerParked = { version: "0.4.1", digest: `sha256:${"c".repeat(64)}` };
  expect(() => core.acceptRelaunchedRunner(ticket, parked, newerParked)).toThrow("native_runner_relaunched_build_unaccepted");
  const relaunched = { version: "0.4.2", digest: `sha256:${"d".repeat(64)}` };
  core.acceptRelaunchedRunner(ticket, relaunched, newerParked);
  expect(ticketRecord(core)).toMatchObject({ runnerVersion: relaunched.version, runnerDigest: relaunched.digest });
}));

it("accepts only the build Core already expects when the parked build is unknown", async () => withCore(async core => {
  const ticket = core.issueBootstrapTicket();
  core.acceptRelaunchedRunner(ticket, parked, null);
  expect(() => core.acceptRelaunchedRunner(ticket, { version: "0.4.1", digest: `sha256:${"b".repeat(64)}` }, null))
    .toThrow("native_runner_relaunched_build_unaccepted");
  expect(ticketRecord(core)).toMatchObject({ runnerVersion: parked.version, runnerDigest: parked.digest });
}));
