import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { appendCampaignCleanupResolution, campaignCleanupResolved, campaignRevalidationIdentity, campaignSummary, completeCampaignAttempt, freezeChatCampaign, reserveCampaignAttempt, validateFrozenCampaign, type CampaignAttempt, campaignProductIdentityEligible, type CampaignPublishedIdentity, campaignAttemptProcessed } from "./chat-campaign.js";
const root = new URL("../../", import.meta.url).pathname;
const base = "8373d7867963674ff960d2345d0d28086f799bc7";
it("resolves only complete hash-bound later resource absence without rewriting the original failure", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "chat-cleanup-resolution-"));
  try {
    const prefix = "tests/runner-e2e/results/cleanup-fixture/";
    mkdirSync(path.join(directory, prefix), { recursive: true });
    const save = (name: string, value: unknown) => {
      const text = JSON.stringify(value); const relative = prefix + name;
      writeFileSync(path.join(directory, relative), text);
      return { path: relative, sha256: createHash("sha256").update(text).digest("hex") };
    };
    const a = attempt(1, "fixture-execution"); a.outcome = "failed"; a.cleanup = "failed"; a.finishedAt = a.startedAt;
    const ownership = save("owned.json", { executionId: a.executionId, ordinal: 1, kind: "container", id: "owned-container", owned: true, nonce: "fixture-nonce" });
    const noResources = (scope: string) => save(`${scope}-not-admitted.json`, { executionId: a.executionId, ordinal: 1, scope, notAdmitted: true, observedAt: a.startedAt });
    const original = save("original.json", { schemaVersion: 1, kind: "campaign-admitted-resource-inventory", executionId: a.executionId, ordinal: 1, recordedAt: a.startedAt, cleanup: "failed",
      resources: [{ kind: "container", id: "owned-container", ownershipEvidence: ownership }], notAdmittedScopes: { processes: noResources("processes"), proxy: noResources("proxy") } });
    a.evidencePaths = [original.path];
    const observedAt = new Date(Date.parse(a.startedAt) + 1000).toISOString();
    const absence = save("absence.json", { kind: "container", id: "owned-container", absent: true, ownershipEvidenceSha256: ownership.sha256, observedAt });
    const inventory = save("inventory.json", { executionId: a.executionId, ordinal: 1, complete: true, completeScopes: ["processes", "database", "proxy"],
      resources: [{ kind: "container", id: "owned-container", ownershipEvidence: ownership }] });
    const body = { schemaVersion: 1, executionId: a.executionId, ordinal: 1, originalCleanup: "failed", observedAt, verifierSourceRevision: base,
      originalEvidence: original, inventory, resources: [{ kind: "container", id: "owned-container", absenceEvidence: absence }] };
    const closed = save("resolution.json", body); const resolution = { at: observedAt, receiptPath: closed.path, receiptSha256: closed.sha256 };
    const before = JSON.stringify(a);
    expect(campaignCleanupResolved(a, directory)).toBe(false);
    appendCampaignCleanupResolution(a, resolution, directory);
    expect(campaignCleanupResolved(a, directory)).toBe(true);
    const { cleanupResolutions: _, ...unchanged } = a;
    expect(JSON.stringify(unchanged)).toBe(before);
    expect(() => appendCampaignCleanupResolution(a, resolution, directory)).toThrow("distinct");
    for (const wrong of [
      { ...body, executionId: "foreign" }, { ...body, resources: [] },
      { ...body, inventory: save("partial.json", { executionId: a.executionId, ordinal: 1, complete: false, resources: [] }) },
      { ...body, inventory: save("empty.json", { executionId: a.executionId, ordinal: 1, complete: true, completeScopes: ["processes", "database", "proxy"], resources: [] }), resources: [] },
      { ...body, resources: [{ kind: "container", id: "foreign", absenceEvidence: absence }] },
    ]) {
      const ref = save("wrong.json", wrong);
      expect(campaignCleanupResolved({ ...a, cleanupResolutions: [{ at: observedAt, receiptPath: ref.path, receiptSha256: ref.sha256 }] }, directory)).toBe(false);
    }
    const foreignOwnership = save("foreign-owned.json", { executionId: "foreign", ordinal: 1, kind: "container", id: "owned-container", owned: true });
    const foreignOriginal = save("foreign-original.json", { schemaVersion: 1, kind: "campaign-admitted-resource-inventory", executionId: a.executionId, ordinal: 1, recordedAt: a.startedAt, cleanup: "failed",
      resources: [{ kind: "container", id: "owned-container", ownershipEvidence: foreignOwnership }], notAdmittedScopes: { processes: noResources("processes"), proxy: noResources("proxy") } });
    const foreignInventory = save("foreign-inventory.json", { executionId: a.executionId, ordinal: 1, complete: true, completeScopes: ["processes", "database", "proxy"], resources: [{ kind: "container", id: "owned-container", ownershipEvidence: foreignOwnership }] });
    const foreignResolution = save("foreign-resolution.json", { ...body, originalEvidence: foreignOriginal, inventory: foreignInventory });
    expect(campaignCleanupResolved({ ...a, evidencePaths: [foreignOriginal.path], cleanupResolutions: [{ at: observedAt, receiptPath: foreignResolution.path, receiptSha256: foreignResolution.sha256 }] }, directory)).toBe(false);
    writeFileSync(path.join(directory, absence.path), JSON.stringify({ absent: false }));
    expect(campaignCleanupResolved(a, directory)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
function attempt(ordinal: 1 | 2, executionId: string): CampaignAttempt {
  return { productIdentity: { kind: "source-build", productionSourceRevision: base, snapshotSourceRevision: base, nativeBinarySha256: "a".repeat(64), workspaceBuildDigest: "b".repeat(64), receiptPaths: ["tests/runner-e2e/results/fixture/source-receipt.json"], coreCandidate: false }, ordinal, outcome: "running", executionId, startedAt: new Date().toISOString(), finishedAt: null,
    sourceRevision: base, workingTreeDigest: "fixture", definitionDigest: "fixture", suiteDefinitionDigest: "fixture", graderDigest: "fixture",
    model: "fixture", profile: "fixture", environment: "local", automaticRetries: 0,
    correction: ordinal === 2 ? "Demonstrated fixture defect corrected" : null, classification: null, observedFailure: null,
    evidencePaths: [], usage: { costUsd: null, coverage: "unknown", tokens: null }, cleanup: "pending", corePrDependencies: [] };
}
it("freezes all intended requests and keeps unrun scenarios in the denominator", () => {
  const campaign = freezeChatCampaign(root, base);
  expect(campaign.scenarios).toHaveLength(244);
  expect(campaign.areas).toBe(35);
  expect(campaign.capabilities).toBe(191);
  expect(campaign.scenarios.every(scenario => scenario.query && scenario.context && scenario.expected_outcome)).toBe(true);
  expect(campaignSummary(campaign)).toMatchObject({ denominator: 244, unrun: 244, finalPassed: 0, requiredPasses: 196, mergeEligible: false });
});
it("preserves failures and enforces one correction cycle with no retries after passing", () => {
  const scenario = freezeChatCampaign(root, base).scenarios.find(scenario => scenario.id === "tasks.create-backlog")!;
  const first = attempt(1, scenario.executionId!);
  reserveCampaignAttempt(scenario, first);
  expect(() => reserveCampaignAttempt(scenario, attempt(2, scenario.executionId!))).toThrow("still running");
  first.outcome = "failed";
  expect(() => reserveCampaignAttempt(scenario, { ...attempt(2, scenario.executionId!), correction: null })).toThrow("recorded correction");
  const second = attempt(2, scenario.executionId!);
  reserveCampaignAttempt(scenario, second);
  second.outcome = "passed";
  expect(scenario.attempts[0]!.outcome).toBe("failed");
  expect(() => reserveCampaignAttempt(scenario, attempt(2, scenario.executionId!))).toThrow("budget exhausted");
  const fresh = freezeChatCampaign(root, base).scenarios.find(scenario => scenario.id === "tasks.create-backlog")!;
  const pass = attempt(1, fresh.executionId!);
  reserveCampaignAttempt(fresh, pass); pass.outcome = "passed";
  expect(() => reserveCampaignAttempt(fresh, attempt(2, fresh.executionId!))).toThrow("cannot be rerun");
});
it("excludes unmerged core-dependent and unclean results from the merge numerator", () => {
  const campaign = freezeChatCampaign(root, base);
  const scenario = campaign.scenarios.find(scenario => scenario.id === "tasks.create-backlog")!;
  scenario.qualifyingDefinitionDigest = "fixture"; scenario.qualifyingGraderDigest = "fixture";
  const result = attempt(1, scenario.executionId!); reserveCampaignAttempt(scenario, result);
  result.outcome = "passed";
  expect(campaignSummary(campaign).finalPassed).toBe(0);
  result.cleanup = "passed"; result.corePrDependencies = ["https://github.com/example/core/pull/1"];
  expect(campaignSummary(campaign).finalPassed).toBe(0);
  result.corePrDependencies = [];
  expect(campaignSummary(campaign).finalPassed).toBe(1);
  scenario.qualifyingDefinitionDigest = "new revision";
  expect(campaignSummary(campaign).finalPassed).toBe(0);
});

it("rejects missing evidence and definition drift before accepting a retained outcome", () => {
  const campaign = freezeChatCampaign(root, base);
  const scenario = campaign.scenarios.find(scenario => scenario.id === "tasks.create-backlog")!;
  scenario.qualifyingDefinitionDigest = "fixture"; scenario.qualifyingGraderDigest = "fixture";
  const reserved = attempt(1, scenario.executionId!); reserveCampaignAttempt(scenario, reserved);
  const completion = { outcome: "passed" as const, finishedAt: new Date().toISOString(), definitionDigest: "fixture", graderDigest: "fixture",
    evidencePaths: [] as string[], cleanup: "passed" as const, usage: reserved.usage, classification: null, observedFailure: null, corePrDependencies: [] };
  expect(() => completeCampaignAttempt(scenario, completion)).toThrow("requires evidence");
  expect(() => completeCampaignAttempt(scenario, { ...completion, definitionDigest: "changed" })).toThrow("changed during attempt");
  expect(() => completeCampaignAttempt(scenario, { ...completion, evidencePaths: ["tests/runner-e2e/results/../private.json"] })).toThrow("sanitized result paths");
  completeCampaignAttempt(scenario, { ...completion, evidencePaths: ["tests/runner-e2e/results/fixture/result.json"] });
  expect(campaignSummary(campaign).finalPassed).toBe(1);
  scenario.qualifyingDefinitionDigest = "new revision";
  expect(campaignSummary(campaign).finalPassed).toBe(0);
});

it("detects catalog tampering while permitting honest readiness and ownership updates", () => {
  const campaign = freezeChatCampaign(root, base);
  campaign.scenarios[0]!.owner = "another-worker";
  campaign.scenarios[0]!.blocker = "external prerequisite missing";
  expect(() => validateFrozenCampaign(campaign, root)).not.toThrow();
  campaign.scenarios[0]!.expected_outcome = "A weaker outcome";
  expect(() => validateFrozenCampaign(campaign, root)).toThrow("Frozen scenario content changed");
});

it("does not turn partial implementations or automatic retries into valid campaign attempts", () => {
  const scenario = freezeChatCampaign(root, base).scenarios.find(scenario => scenario.id === "tasks.create-backlog")!;
  scenario.readiness = "partial";
  expect(() => reserveCampaignAttempt(scenario, attempt(1, scenario.executionId!))).toThrow("no executable implementation");
  scenario.readiness = "implemented";
  const invalid = { ...attempt(1, scenario.executionId!), automaticRetries: 1 } as unknown as CampaignAttempt;
  expect(() => reserveCampaignAttempt(scenario, invalid)).toThrow("Invalid attempt reservation");
  expect(scenario.attempts).toHaveLength(0);
});

it("gates source acceptance on actual baseline/build receipts, not merely test source revision", () => {
  const campaign = freezeChatCampaign(root, base), scenario = campaign.scenarios.find(s => s.id === "tasks.create-backlog")!;
  const valid = attempt(1, scenario.executionId!);
  expect(campaignProductIdentityEligible(scenario, valid, base)).toBe(true);
  expect(campaignProductIdentityEligible(scenario, { ...valid, productIdentity: undefined }, base)).toBe(false);
  for (const delta of [{ productionSourceRevision: "c".repeat(40) }, { nativeBinarySha256: "" }, { snapshotSourceRevision: "d".repeat(40) }, { coreCandidate: true }, { receiptPaths: [] }]) {
    const product = { ...valid.productIdentity!, ...delta } as CampaignAttempt["productIdentity"];
    expect(campaignProductIdentityEligible(scenario, { ...valid, productIdentity: product }, base)).toBe(false);
  }
});
it("admits declared published operator transitions but rejects wrong observed targets and arbitrary installed substitution", () => {
  const campaign = freezeChatCampaign(root, base), scenario = campaign.scenarios.find(s => s.id === "instance-operations.update-instance")!;
  const publication = (version: string, h: string): CampaignPublishedIdentity => ({ version, treeSha256: h.repeat(64), artifacts: ["paperclipai", "@paperclipai/server"].map(name => ({ package: name as "paperclipai" | "@paperclipai/server", version, integrity: "sha512-YWJj", entrySha256: h.repeat(64) })) });
  const source = publication("1.0.0", "a"), target = publication("1.0.1", "b");
  const valid: CampaignAttempt = { ...attempt(1, "installed"), productIdentity: { kind: "published-release", declaredLane: "published-global-npm", source, target, observed: target, receiptPaths: ["tests/runner-e2e/results/fixture/installed.json"], coreCandidate: false } };
  expect(campaignProductIdentityEligible(scenario, valid, base)).toBe(true);
  expect(campaignProductIdentityEligible(scenario, { ...valid, productIdentity: { ...valid.productIdentity as Extract<CampaignAttempt["productIdentity"], { kind: "published-release" }>, observed: source } }, base)).toBe(false);
  const unrelated = campaign.scenarios.find(s => s.id === "tasks.create-backlog")!;
  expect(campaignProductIdentityEligible(unrelated, valid, base)).toBe(false);
  expect(campaignProductIdentityEligible({ ...scenario, productPolicy: undefined }, valid, base)).toBe(false);
  expect(campaignProductIdentityEligible(scenario, { ...valid, corePrDependencies: ["unmerged-core"] }, base)).toBe(false);
  const boundary = campaign.scenarios.find(s => s.id === "onboarding.new-instance")!;
  const installed = { ...valid, productIdentity: { kind: "published-release" as const, declaredLane: "empty-installed-boundary" as const, source, observed: source, receiptPaths: ["tests/runner-e2e/results/fixture/published-boundary.json"], coreCandidate: false } };
  expect(campaignProductIdentityEligible(boundary, installed, base)).toBe(true);
  const sourceBuilt = { ...attempt(1, "boundary"), productIdentity: { kind: "source-built-installed" as const, productionSourceRevision: base, snapshotSourceRevision: base, nativeBinarySha256: "a".repeat(64), workspaceBuildDigest: "b".repeat(64), cliSha256: "c".repeat(64), serverSha256: "d".repeat(64), artifactTreeSha256: "e".repeat(64), receiptPaths: ["tests/runner-e2e/results/fixture/source-pack.json"], coreCandidate: false } };
  expect(campaignProductIdentityEligible(boundary, sourceBuilt, base)).toBe(true);
  expect(campaignProductIdentityEligible(scenario, sourceBuilt, base)).toBe(false);
});
it("does not complete or report a qualifying pass when its product identity is missing", () => {
  const campaign = freezeChatCampaign(root, base), scenario = campaign.scenarios.find(s => s.id === "tasks.create-backlog")!;
  const reserved = attempt(1, scenario.executionId!); reserved.productIdentity = undefined;
  reserveCampaignAttempt(scenario, reserved);
  scenario.qualifyingDefinitionDigest = "fixture"; scenario.qualifyingGraderDigest = "fixture";
  const completion = { outcome: "passed" as const, finishedAt: new Date().toISOString(), definitionDigest: "fixture", graderDigest: "fixture", evidencePaths: ["tests/runner-e2e/results/fixture/result.json"], cleanup: "passed" as const, usage: reserved.usage, classification: null, observedFailure: null, corePrDependencies: [] };
  expect(() => completeCampaignAttempt(scenario, completion)).toThrow("eligible product identity");
  Object.assign(reserved, completion);
  expect(campaignSummary(campaign)).toMatchObject({ initialPassed: 0, finalPassed: 0, productEvidence: { identityIneligibleMeasurements: 1, measurementsByIdentity: { unknown: 1 } } });
});

it("processes concrete unsupported probes without accepting incomplete outcomes or unfinished shells", () => {
  const campaign = freezeChatCampaign(root, base), scenario = campaign.scenarios.find(s => s.id === "tasks.create-backlog")!;
  scenario.readiness = "partial"; scenario.authoringStatus = "concrete-blocker";
  scenario.blockerProbeSources = ["chat-catalog-domains/identity-access-grants.ts"];
  const a = attempt(1, scenario.executionId!); reserveCampaignAttempt(scenario, a);
  const completion = { outcome: "passed" as const, finishedAt: new Date().toISOString(), definitionDigest: "fixture", graderDigest: "fixture", evidencePaths: ["tests/runner-e2e/results/fixture/result.json"], cleanup: "passed" as const, usage: a.usage, classification: null, observedFailure: null, corePrDependencies: [] };
  expect(() => completeCampaignAttempt(scenario, completion)).toThrow("Incomplete conditions");
  completeCampaignAttempt(scenario, { ...completion, outcome: "blocked" });
  expect(campaignSummary(campaign)).toMatchObject({ authored: 2, coverageComplete: 1, concreteBlockers: 1, unfinished: 0, authoringResolved: 2, processed: 0, finalPassed: 0, mergeEligible: false });
  scenario.authoringStatus = "unfinished"; scenario.attempts = [];
  expect(() => reserveCampaignAttempt(scenario, attempt(1, scenario.executionId!))).toThrow("no executable implementation");
  expect(campaignSummary(campaign)).toMatchObject({ unfinished: 1, authoringResolved: 1 });
});
it("requires a real terminal source-attributed result for processing, not a reservation or calibration receipt", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "chat-campaign-processing-"));
  try {
    const a = attempt(1, "chat-features.runner-codex-subscription.local.fixture");
    a.outcome = "blocked"; a.finishedAt = new Date().toISOString();
    const relative = "tests/runner-e2e/results/owned/result.json", filename = path.join(temporary, relative);
    a.evidencePaths = [relative]; mkdirSync(path.dirname(filename), { recursive: true });
    expect(campaignAttemptProcessed(a, temporary)).toBe(false);
    const raw = { executionId: a.executionId, source: { sha: a.sourceRevision }, status: "failed", startedAt: a.startedAt, finishedAt: a.finishedAt };
    writeFileSync(filename, JSON.stringify(raw)); expect(campaignAttemptProcessed(a, temporary)).toBe(true);
    writeFileSync(filename, JSON.stringify({ ...raw, source: { sha: "wrong" } })); expect(campaignAttemptProcessed(a, temporary)).toBe(false);
    writeFileSync(filename, JSON.stringify({ calibration: true })); expect(campaignAttemptProcessed(a, temporary)).toBe(false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

it("permits a processed unsupported remainder while requiring every unfinished branch to close", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "chat-campaign-gate-"));
  try {
    const campaign = freezeChatCampaign(root, base); let passes = 0;
    for (const [index, s] of campaign.scenarios.entries()) {
      s.readiness = "implemented"; s.authoringStatus = "complete"; s.executionId = `chat-features.runner-codex-subscription.local.${s.id}`;
      s.qualifyingDefinitionDigest = "fixture"; s.qualifyingGraderDigest = "fixture";
      const a = attempt(1, s.executionId); a.finishedAt = a.startedAt; a.cleanup = "passed";
      a.outcome = s.productPolicy?.lane === "source-build" && passes < 196 ? "passed" : "blocked";
      if (a.outcome === "passed") passes++;
      const relative = `tests/runner-e2e/results/gate-${index}/result.json`, filename = path.join(temporary, relative);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, JSON.stringify({ executionId: a.executionId, source: { sha: a.sourceRevision }, status: a.outcome === "passed" ? "passed" : "failed", startedAt: a.startedAt, finishedAt: a.finishedAt }));
      a.evidencePaths = [relative]; s.attempts.push(a);
    }
    const blocked = campaign.scenarios.find(s => s.attempts[0]!.outcome === "blocked")!;
    blocked.readiness = "partial"; blocked.authoringStatus = "concrete-blocker"; blocked.blockerProbeSources = ["actual-supported-surface-probe.ts"];
    expect(campaignSummary(campaign, temporary)).toMatchObject({ authoringResolved: 244, processed: 244, finalPassed: 196, mergeEligible: true });
    blocked.authoringStatus = "unfinished";
    expect(campaignSummary(campaign, temporary)).toMatchObject({ authoringResolved: 243, unfinished: 1, mergeEligible: false });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

it("permits exactly one recorded final revalidation only after an actual selected qualifying identity change", () => {
  const scenario = freezeChatCampaign(root, base).scenarios.find(x => x.id === "tasks.create-backlog")!, first = attempt(1, scenario.executionId!);
  reserveCampaignAttempt(scenario, first); first.outcome = "passed"; const original = JSON.stringify(first);
  const next = attempt(2, scenario.executionId!); next.sourceRevision = "c".repeat(40);
  next.passedRevalidation = { reason: "Shared selected closure changed for final baseline", previous: campaignRevalidationIdentity(first), next: campaignRevalidationIdentity(next) };
  scenario.qualifyingDefinitionDigest = next.definitionDigest; scenario.qualifyingGraderDigest = next.graderDigest;
  expect(() => reserveCampaignAttempt(scenario, next)).toThrow("actual qualifying identity invalidation");
  next.definitionDigest = "actual-new-selected-closure"; scenario.qualifyingDefinitionDigest = next.definitionDigest;
  next.passedRevalidation.next = campaignRevalidationIdentity(next); next.passedRevalidation.previous.definitionDigest = "invented-old";
  expect(() => reserveCampaignAttempt(scenario, next)).toThrow("actual qualifying identity invalidation");
  next.passedRevalidation.previous = campaignRevalidationIdentity(first); next.correction = null;
  expect(() => reserveCampaignAttempt(scenario, next)).toThrow("recorded correction");
  next.correction = "Coherent shared closure correction on final B"; reserveCampaignAttempt(scenario, next);
  expect(JSON.stringify(first)).toBe(original); next.outcome = "failed";
  expect(() => reserveCampaignAttempt(scenario, attempt(2, scenario.executionId!))).toThrow("budget exhausted");
});
