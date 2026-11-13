import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ChatCampaignCoordinator, type CampaignCoordinatorOptions, type CampaignLaunchPermit } from "./chat-campaign-coordinator.js";
import type { CampaignAttempt, CampaignScenario, ChatCampaign } from "./chat-campaign.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(fault?: CampaignCoordinatorOptions["fault"]) {
  const root = mkdtempSync(path.join(tmpdir(), "chat-two-lane-")); roots.push(root);
  const baseline = "a".repeat(40), startedAt = "2026-10-27T10:00:00.000Z";
  const selections = ["fixture.first", "fixture.second", "fixture.third", "fixture.fourth"].map(scenarioId => {
    const attempt: CampaignAttempt = {
      ordinal: 1, outcome: "running", executionId: `chat-features.codex.local.${scenarioId}`, startedAt, finishedAt: null,
      sourceRevision: baseline, workingTreeDigest: "bytes", definitionDigest: `definition-${scenarioId}`, suiteDefinitionDigest: "suite",
      graderDigest: `grader-${scenarioId}`, model: "synthetic", profile: "synthetic", environment: "local", automaticRetries: 0,
      correction: null, classification: null, observedFailure: null, evidencePaths: ["tests/runner-e2e/results/synthetic/selection.json"],
      usage: { costUsd: null, tokens: null, coverage: "not run" }, cleanup: "pending", corePrDependencies: [], databaseLane: { lane: "embedded-postgres" },
      productIdentity: { kind: "source-build", productionSourceRevision: baseline, snapshotSourceRevision: baseline,
        nativeBinarySha256: "b".repeat(64), workspaceBuildDigest: "c".repeat(64), receiptPaths: ["tests/runner-e2e/results/synthetic/build.json"], coreCandidate: false },
    };
    return { scenarioId, attempt };
  });
  const scenarios: CampaignScenario[] = selections.map(({ scenarioId, attempt }) => ({
    id: scenarioId, feature: "fixture", sourceFile: "fixture.yaml", sourceSha256: "source", scenarioSha256: "scenario", capabilities: [],
    context: "synthetic only", query: "synthetic", expected_outcome: "synthetic", owner: "fixture", readiness: "implemented", authoringStatus: "complete",
    qualifyingDefinitionDigest: attempt.definitionDigest, qualifyingGraderDigest: attempt.graderDigest, executionId: attempt.executionId, blocker: null,
    productPolicy: { lane: "source-build", sourceBaselineRevision: baseline }, attempts: [],
  }));
  const manifest: ChatCampaign = { version: 1, campaignId: "fixture", frozenAt: startedAt, baselineRevision: baseline, inventoryDigest: "inventory",
    defaultsSha256: "defaults", denominator: 4, areas: 1, capabilities: 0, requiredPasses: 4, corePrs: [], evalPr: null, scenarios };
  const manifestPath = path.join(root, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(manifest));
  const options: CampaignCoordinatorOptions = { manifestPath, controlDirectory: path.join(root, "control"), batchId: "synthetic-batch", selections, fault, evidenceRoot: root, now: () => startedAt };
  return { root, options, ledger: () => JSON.parse(readFileSync(manifestPath, "utf8")) as ChatCampaign, open: () => ChatCampaignCoordinator.open(options) };
}
function completion() {
  return { outcome: "failed" as const, finishedAt: "2026-10-27T10:00:01.000Z", definitionDigest: "", graderDigest: "",
    evidencePaths: ["tests/runner-e2e/results/synthetic/result.json"], cleanup: "passed" as const,
    usage: { costUsd: null, tokens: 123, coverage: "synthetic test receipt; no model" }, classification: "synthetic_behavior_failure",
    observedFailure: "Synthetic substantive failure", corePrDependencies: [] };
}
function result(f: ReturnType<typeof fixture>, p: CampaignLaunchPermit) {
  const plan = f.options.selections.find(x => x.scenarioId === p.scenarioId)!;
  return { ...completion(), definitionDigest: plan.attempt.definitionDigest, graderDigest: plan.attempt.graderDigest };
}
const retainFailure = async (_permit: unknown, error: unknown) => ({ evidencePath: "tests/runner-e2e/results/synthetic/failure.json", summary: error instanceof Error ? error.message : "Synthetic failure" });
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

it("serializes racing reservation/completion writes, preserves both rows and exactly matching receipts", async () => {
  const f = fixture(), c = f.open();
  const [a, b, duplicate] = await Promise.all([c.reserve("fixture.first"), c.reserve("fixture.second"), c.reserve("fixture.first")]);
  expect(a).toEqual(duplicate); expect(a.reservationId).not.toBe(b.reservationId);
  expect(f.ledger().scenarios.slice(0, 2).map(x => x.attempts.length)).toEqual([1, 1]);
  await expect(c.reserve("fixture.third")).rejects.toThrow("Two lanes");
  let launches = 0;
  await Promise.all([a, b].map(p => c.launchOnce(p, async permit => {
    launches++; expect(permit.args).toEqual(["--id", p.executionId, "--max-parallel", "1", "--max-automatic-retries", "0"]);
  })));
  await expect(c.launchOnce(duplicate, async () => { launches++; })).rejects.toThrow("not admissible");
  await Promise.all([c.complete(a, result(f, a)), c.complete(b, result(f, b)), c.complete(a, result(f, a))]);
  expect(launches).toBe(2);
  expect(f.ledger().scenarios.slice(0, 2).map(x => x.attempts[0]?.usage.tokens)).toEqual([123, 123]);
  await expect(c.complete(a, { ...result(f, a), observedFailure: "wrong bytes" })).rejects.toThrow("content conflict");
  await c.close();
});

it("rejects a second owner even with a different batch directory and never steals stale PID locks", async () => {
  const f = fixture(), c = f.open();
  expect(() => ChatCampaignCoordinator.open({ ...f.options, controlDirectory: path.join(f.root, "other") })).toThrow();
  const filename = `${f.options.manifestPath}.coordinator-lock`, lock = JSON.parse(readFileSync(filename, "utf8"));
  writeFileSync(filename, JSON.stringify({ ...lock, pid: 2147483647, createdAt: "1900-01-01" }));
  expect(() => f.open()).toThrow();
  // Restoring this test's exact owner does not model authorizing recovery of real processes.
  writeFileSync(filename, JSON.stringify(lock)); await c.close();
});

it.each(["executionId", "definitionDigest", "graderDigest", "ordinal", "productIdentity", "databaseLane"] as const)("rejects changed reviewed %s before admission", async field => {
  const f = fixture();
  const manifest = f.ledger();
  if (field === "definitionDigest") manifest.scenarios[0]!.qualifyingDefinitionDigest = "changed";
  else if (field === "graderDigest") manifest.scenarios[0]!.qualifyingGraderDigest = "changed";
  else if (field === "executionId") manifest.scenarios[0]!.executionId = "foreign";
  else if (field === "ordinal") f.options.selections[0]!.attempt.ordinal = 2;
  else if (field === "productIdentity") f.options.selections[0]!.attempt.productIdentity = { ...f.options.selections[0]!.attempt.productIdentity!, kind: "source-build", productionSourceRevision: "f".repeat(40) } as CampaignAttempt["productIdentity"];
  else f.options.selections[0]!.attempt.databaseLane = { lane: "owned-docker-postgres", engine: "foreign" } as unknown as CampaignAttempt["databaseLane"];
  writeFileSync(f.options.manifestPath, JSON.stringify(manifest));
  const c = f.open(); await expect(c.reserve("fixture.first")).rejects.toThrow();
  expect(f.ledger().scenarios.every(x => !x.attempts.length)).toBe(true); await c.close();
});

it("uses fresh ledger reads and rejects changed reserved identity or tampered matching-completion ledger", async () => {
  const f = fixture(), c = f.open(), p = await c.reserve("fixture.first");
  await c.launchOnce(p, async () => undefined);
  const m = f.ledger(); m.scenarios[1]!.blocker = "independent metadata preserved"; writeFileSync(f.options.manifestPath, JSON.stringify(m));
  await c.complete(p, result(f, p));
  expect(f.ledger().scenarios[1]!.blocker).toBe("independent metadata preserved");
  const changed = f.ledger(); changed.scenarios[0]!.attempts[0]!.usage.tokens = 999; writeFileSync(f.options.manifestPath, JSON.stringify(changed));
  await expect(c.complete(p, result(f, p))).rejects.toThrow("differs from receipt"); await c.close();
});

it.each(["intent", "manifest", "state"] as const)("fails closed at the real filesystem %s crash boundary without replaying a launch", async stage => {
  const f = fixture(actual => { if (actual === stage) throw new Error("synthetic crash"); }), c = f.open();
  await expect(c.reserve("fixture.first")).rejects.toThrow("synthetic crash");
  expect(() => f.open()).toThrow(); // crash lock is retained
  expect(() => JSON.parse(readFileSync(f.options.manifestPath, "utf8"))).not.toThrow();
  // Synthetic owner-death reconciliation: no child was invoked in this test.
  unlinkSync(`${f.options.manifestPath}.coordinator-lock`); f.options.fault = undefined;
  const restarted = f.open(), state = await restarted.snapshot();
  expect(state.stop?.reason).toBe("coordinator_failure");
  await expect(restarted.reserve("fixture.second")).rejects.toThrow("stopped");
  expect(f.ledger().scenarios[0]!.attempts.length).toBe(stage === "intent" ? 0 : 1);
  await restarted.close();
});

it("retains launch uncertainty both before spawn and after a child returns, never automatically relaunches", async () => {
  const f = fixture(), c = f.open(), p = await c.reserve("fixture.first");
  let launches = 0;
  await expect(c.launchOnce(p, async () => { launches++; throw new Error("spawn boundary uncertain"); })).rejects.toThrow("uncertain");
  await expect(c.launchOnce(p, async () => { launches++; })).rejects.toThrow();
  await c.close();
  const restarted = f.open(); expect((await restarted.snapshot()).stop?.reason).toBe("coordinator_failure");
  await expect(restarted.launchOnce(p, async () => { launches++; })).rejects.toThrow();
  expect(launches).toBe(1); await restarted.close();
});

it("runs at most two independent children and drains the entire wave before stop-before-refill", async () => {
  const f = fixture(), c = f.open(), gate = deferred(), secondStarted = deferred();
  const launched: string[] = []; let active = 0, maximum = 0;
  const run = c.run({
    retainFailure, launchOnly: async p => { launched.push(p.scenarioId); maximum = Math.max(maximum, ++active);
      if (p.scenarioId === "fixture.first") await secondStarted.promise;
      if (p.scenarioId === "fixture.second") { secondStarted.release(); await gate.promise; } active--; return p.scenarioId; },
    readCompletion: async (p, id) => ({ completion: result(f, p), ...(id === "fixture.first" ? { stop: { reason: "secret_leak" as const, detail: "actual synthetic secret match" } } : {}) }),
  });
  await secondStarted.promise;
  await expect(c.close()).rejects.toThrow("in flight");
  gate.release(); const state = await run;
  expect(maximum).toBe(2); expect(launched.sort()).toEqual(["fixture.first", "fixture.second"]);
  expect(Object.values(state.entries).every(x => x.phase === "completed")).toBe(true);
  expect(state.stop?.reason).toBe("secret_leak"); expect(f.ledger().scenarios[2]!.attempts).toEqual([]);
  await c.close(); const restarted = f.open(); await expect(restarted.reserve("fixture.third")).rejects.toThrow("stopped"); await restarted.close();
});

it("does not classify a caller-verified safe bound-only ZIP omission as a secret leak", async () => {
  const f = fixture(), c = f.open(); let launches = 0;
  const state = await c.run({ retainFailure, launchOnly: async () => { launches++; }, readCompletion: async p => ({ completion: { ...result(f, p), observedFailure: "Reporter privacy violation: independently verified safe bound-only ZIP omission, no secret match" } }) });
  expect(launches).toBe(4); expect(state.stop).toBeNull(); await c.close();
});

it("durably stops on cleanup failure before completion commit or admission, including a crash", async () => {
  let fail = false;
  const f = fixture(stage => { if (fail && stage === "intent") throw new Error("completion crash"); });
  const c = f.open(), p = await c.reserve("fixture.first"); await c.launchOnce(p, async () => undefined); fail = true;
  await expect(c.complete(p, { ...result(f, p), cleanup: "failed" })).rejects.toThrow("completion crash");
  expect(JSON.parse(readFileSync(path.join(f.options.controlDirectory, "state.json"), "utf8")).stop.reason).toBe("cleanup_failure");
  expect(existsSync(path.join(f.options.controlDirectory, "pending.json"))).toBe(true);
});

it("does not relaunch completed entries when a clean parent resumes remaining selections", async () => {
  const f = fixture(), c = f.open(), p = await c.reserve("fixture.first");
  await c.launchOnce(p, async () => undefined); await c.complete(p, result(f, p)); await c.close();
  const next = f.open(), launched: string[] = [];
  await next.run({ retainFailure, launchOnly: async permit => { launched.push(permit.scenarioId); }, readCompletion: async permit => ({ completion: result(f, permit) }) });
  expect(launched.sort()).toEqual(["fixture.fourth", "fixture.second", "fixture.third"]); await next.close();
});

it("rejects an outside writer during commit and retains the recovery lock instead of overwriting", async () => {
  const f = fixture(stage => { if (stage === "intent") {
    const manifest = f.ledger(); manifest.evalPr = "unexpected writer"; writeFileSync(f.options.manifestPath, JSON.stringify(manifest));
  } });
  const c = f.open(); await expect(c.reserve("fixture.first")).rejects.toThrow("outside coordinator");
  expect(f.ledger().evalPr).toBe("unexpected writer"); expect(f.ledger().scenarios[0]!.attempts.length).toBe(0);
  unlinkSync(`${f.options.manifestPath}.coordinator-lock`); f.options.fault = undefined;
  expect(() => f.open()).toThrow("Unrecognized manifest");
  expect(existsSync(`${f.options.manifestPath}.coordinator-lock`)).toBe(true);
});

it("rejects a forged permit and modified native reservation before accepting result evidence", async () => {
  const f = fixture(), c = f.open(), p = await c.reserve("fixture.first");
  await expect(c.launchOnce({ ...p, args: [...p.args, "--all"] }, async () => undefined)).rejects.toThrow("not admissible");
  await c.launchOnce(p, async () => undefined);
  const m = f.ledger(); m.scenarios[0]!.attempts[0]!.model = "wrong model"; writeFileSync(f.options.manifestPath, JSON.stringify(m));
  await expect(c.complete(p, result(f, p))).rejects.toThrow("Reserved attempt changed"); await c.close();
});

it("persists a queued explicit stop before admitting the next queued reservation", async () => {
  const f = fixture(), c = f.open();
  const stopped = c.stop("shared_infrastructure", "synthetic real host failure");
  await expect(c.reserve("fixture.first")).rejects.toThrow("stopped"); await stopped;
  expect(f.ledger().scenarios.every(x => !x.attempts.length)).toBe(true); await c.close();
});

it("retains the original passing measurement while invalidating only qualification from a hash-bound closure review", async () => {
  const f = fixture(), c = f.open(), p = await c.reserve("fixture.first"); await c.launchOnce(p, async () => undefined);
  const original = f.options.selections[0]!.attempt;
  const previous = { definitionDigest: original.definitionDigest, graderDigest: original.graderDigest };
  const next = { definitionDigest: "new-normalized-selected-closure", graderDigest: "new-normalized-grader" };
  const evidencePath = "tests/runner-e2e/results/synthetic/identity-review.json";
  const filename = path.join(f.root, evidencePath); mkdirSync(path.dirname(filename), { recursive: true });
  const bytes = JSON.stringify({ id: p.scenarioId, ordinal: p.ordinal, previous, next }); writeFileSync(filename, bytes);
  const review = { evidencePath, receiptSha256: createHash("sha256").update(bytes).digest("hex"), previous, next };
  const passed = { ...result(f, p), outcome: "passed" as const, evidencePaths: [evidencePath] };
  await expect(c.complete(p, passed, undefined, { ...review, next: previous })).rejects.toThrow("Invalid qualifying");
  await expect(c.complete(p, passed, undefined, { ...review, receiptSha256: "wrong" })).rejects.toThrow("receipt mismatch");
  await c.complete(p, passed, undefined, review);
  const row = f.ledger().scenarios[0]!;
  expect(row.qualifyingDefinitionDigest).toBeNull(); expect(row.qualifyingGraderDigest).toBeNull();
  expect(row.attempts[0]).toMatchObject({ outcome: "passed", definitionDigest: original.definitionDigest, graderDigest: original.graderDigest });
  await c.close();
});

it("recovers a committed completion after interruption without duplicating the attempt or restarting any child", async () => {
  let fault = false;
  const f = fixture(stage => { if (fault && stage === "manifest") throw new Error("after completion commit"); });
  const c = f.open(), p = await c.reserve("fixture.first"); await c.launchOnce(p, async () => undefined); fault = true;
  await expect(c.complete(p, result(f, p))).rejects.toThrow("completion commit");
  unlinkSync(`${f.options.manifestPath}.coordinator-lock`); f.options.fault = undefined;
  const restarted = f.open(); await restarted.complete(p, result(f, p));
  expect(f.ledger().scenarios[0]!.attempts).toHaveLength(1);
  expect((await restarted.snapshot()).stop?.reason).toBe("coordinator_failure");
  await expect(restarted.launchOnce(p, async () => { throw new Error("must not launch"); })).rejects.toThrow("not admissible");
  await restarted.close();
});

it("stamps each real reservation time rather than preparation time, retaining exact later-wave identity", async () => {
  const f = fixture(); let clock = "2026-10-27T10:00:00.100Z";
  f.options.now = () => clock;
  const c = f.open(), first = await c.reserve("fixture.first");
  expect(f.ledger().scenarios[0]!.attempts[0]!.startedAt).toBe(clock);
  await c.launchOnce(first, async () => undefined); await c.complete(first, result(f, first));
  clock = "2026-10-27T10:15:00.000Z";
  const later = await c.reserve("fixture.third");
  expect(f.ledger().scenarios[2]!.attempts[0]!.startedAt).toBe(clock);
  const entry = (await c.snapshot()).entries[later.reservationId]!;
  expect(entry.reservedAttempt.startedAt).toBe(clock);
  await c.launchOnce(later, async () => undefined);
  await c.complete(later, { ...result(f, later), finishedAt: "2026-10-27T10:16:00.000Z" }); await c.close();
  // Regenerated preparation timestamps are not a new reviewed selection identity.
  for (const plan of f.options.selections) plan.attempt.startedAt = "2026-10-27T09:00:00.000Z";
  const restarted = f.open(); expect((await restarted.snapshot()).entries[later.reservationId]!.reservedAttempt.startedAt).toBe(clock);
  await restarted.close();
});

it("retains actionable sanitized completion failure evidence while draining the peer and stopping refill", async () => {
  const f = fixture(), c = f.open(); const retained: string[] = [];
  const state = await c.run({ launchOnly: async p => p.scenarioId,
    readCompletion: async (p, id) => { if (id === "fixture.first") throw new Error("Synthetic result source digest differs from reserved digest"); return { completion: result(f, p) }; },
    retainFailure: async (p, error, phase) => { retained.push(`${p?.scenarioId}:${phase}`); return retainFailure(p, error); },
  });
  expect(retained).toEqual(["fixture.first:completion"]);
  expect(state.failures[0]).toMatchObject({ scenarioId: "fixture.first", phase: "completion", summary: "Synthetic result source digest differs from reserved digest" });
  expect(state.stop?.detail).toContain("failure.json"); expect(f.ledger().scenarios[2]!.attempts).toEqual([]); await c.close();
});
