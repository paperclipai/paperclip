import { databaseFingerprintIdentity, databaseIdentityMatches, type DatabaseFingerprintIdentity } from "./docker-postgres.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

export const CHAT_CAMPAIGN_MANIFEST = "tests/runner-e2e/chat-campaign-manifest.json";
export type CampaignOutcome = "passed" | "failed" | "blocked";
export type CampaignProductLane = "source-build" | "published-global-npm" | "empty-installed-boundary";
export interface CampaignPublishedIdentity {
  version: string; treeSha256: string;
  artifacts: Array<{ package: "paperclipai" | "@paperclipai/server"; version: string; integrity: string; entrySha256: string }>;
}
export type CampaignProductIdentity =
  | { kind: "unknown"; reason: string }
  | { kind: "source-build" | "source-built-installed"; productionSourceRevision: string; snapshotSourceRevision: string;
      nativeBinarySha256: string; workspaceBuildDigest: string; receiptPaths: string[]; coreCandidate: boolean;
      cliSha256?: string; serverSha256?: string; artifactTreeSha256?: string }
  | { kind: "published-release"; declaredLane: "published-global-npm" | "empty-installed-boundary";
      source: CampaignPublishedIdentity; target?: CampaignPublishedIdentity; observed: CampaignPublishedIdentity;
      receiptPaths: string[]; coreCandidate: boolean };
const identityHash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const identityRevision = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const retainedIdentityPaths = (paths: string[]) => Array.isArray(paths) && paths.length > 0 && paths.every(p => typeof p === "string" && p.startsWith("tests/runner-e2e/results/") && !p.split("/").includes(".."));
export function scenarioProductPolicy(id: string, baselineRevision: string) {
  const lane: CampaignProductLane = ["instance-operations.update-instance", "instance-operations.provision-runtime"].includes(id)
    ? "published-global-npm" : id === "onboarding.new-instance" ? "empty-installed-boundary" : "source-build";
  return { lane, sourceBaselineRevision: baselineRevision };
}
function publishedIdentityValid(value: CampaignPublishedIdentity) {
  return !!value && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) && identityHash(value.treeSha256)
    && Array.isArray(value.artifacts) && value.artifacts.length === 2
    && ["paperclipai", "@paperclipai/server"].every(name => value.artifacts.filter(a => a && a.package === name).length === 1)
    && value.artifacts.every(a => a.version === value.version && /^sha512-[A-Za-z0-9+/]+=*$/.test(a.integrity) && identityHash(a.entrySha256));
}
function samePublishedIdentity(a: CampaignPublishedIdentity, b: CampaignPublishedIdentity) {
  return publishedIdentityValid(a) && publishedIdentityValid(b) && a.version === b.version && a.treeSha256 === b.treeSha256
    && a.artifacts.every(x => b.artifacts.some(y => x.package === y.package && x.version === y.version && x.integrity === y.integrity && x.entrySha256 === y.entrySha256));
}
/** Identity gates eligibility independently of a model's outcome or test-source SHA. */
export function campaignProductIdentityEligible(scenario: CampaignScenario, attempt: CampaignAttempt, baselineRevision = scenario.productPolicy?.sourceBaselineRevision): boolean {
  const policy = scenario.productPolicy, product = attempt.productIdentity;
  if (!policy || policy.sourceBaselineRevision !== baselineRevision || !identityRevision(baselineRevision)
    || policy.lane !== scenarioProductPolicy(scenario.id, baselineRevision).lane || !product || product.kind === "unknown"
    || product.coreCandidate !== false || attempt.corePrDependencies.length || !retainedIdentityPaths(product.receiptPaths)) return false;
  if (product.kind === "source-build" || product.kind === "source-built-installed") {
    return product.productionSourceRevision === baselineRevision && product.snapshotSourceRevision === attempt.sourceRevision
      && identityRevision(product.snapshotSourceRevision) && identityHash(product.nativeBinarySha256) && identityHash(product.workspaceBuildDigest)
      && (product.kind === "source-build" ? policy.lane === "source-build" : policy.lane === "empty-installed-boundary"
        && identityHash(product.cliSha256) && identityHash(product.serverSha256) && identityHash(product.artifactTreeSha256));
  }
  if (product.kind !== "published-release") return false;
  if (policy.lane === "source-build" || product.declaredLane !== policy.lane || !publishedIdentityValid(product.source)) return false;
  if (scenario.id === "instance-operations.update-instance") return !!product.target && product.target.version !== product.source.version && samePublishedIdentity(product.target, product.observed);
  return !product.target && samePublishedIdentity(product.source, product.observed);
}
export interface CampaignRevalidationIdentity {
  definitionDigest: string; graderDigest: string; productBaseline: string | null; databaseLane: DatabaseFingerprintIdentity;
}
/** Source checkout revisions alone are not qualifying identity changes. */
export function campaignRevalidationIdentity(attempt: CampaignAttempt): CampaignRevalidationIdentity {
  const product = attempt.productIdentity;
  let productBaseline: string | null = null;
  if (product?.kind === "source-build" || product?.kind === "source-built-installed") productBaseline = JSON.stringify({ kind: product.kind, source: product.productionSourceRevision });
  if (product?.kind === "published-release") {
    const pin = (v: CampaignPublishedIdentity) => ({ version: v.version, treeSha256: v.treeSha256, artifacts: [...v.artifacts].sort((a, b) => a.package.localeCompare(b.package)) });
    productBaseline = JSON.stringify({ kind: product.kind, lane: product.declaredLane, source: pin(product.source), target: product.target ? pin(product.target) : null });
  }
  return { definitionDigest: attempt.definitionDigest, graderDigest: attempt.graderDigest, productBaseline, databaseLane: attempt.databaseLane ?? { lane: "embedded-postgres" } };
}
export interface CampaignAttempt {
  /** Stable declared DB environment, excluding passwords/IDs. Missing only on historical embedded attempts. */
  databaseLane?: DatabaseFingerprintIdentity;
  productIdentity?: CampaignProductIdentity;
  ordinal: 1 | 2;
  outcome: CampaignOutcome | "running";
  executionId: string;
  startedAt: string;
  finishedAt: string | null;
  sourceRevision: string;
  workingTreeDigest: string;
  definitionDigest: string;
  suiteDefinitionDigest: string;
  graderDigest: string;
  model: string;
  profile: string;
  environment: string;
  automaticRetries: 0;
  correction: string | null;
  /** One final-B measurement only when actual qualifying identity was invalidated. */
  passedRevalidation?: { reason: string; previous: CampaignRevalidationIdentity; next: CampaignRevalidationIdentity };
  classification: string | null;
  diagnosisHistory?: Array<{ at: string; classification: string | null; detail: string | null; supersededBy: string }>;
  observedFailure: string | null;
  evidencePaths: string[];
  usage: { costUsd: number | null; coverage: string; tokens: number | null };
  cleanup: "pending" | "passed" | "failed" | "not_started";
  /** Later resource verification never rewrites the measured cleanup outcome. */
  cleanupResolutions?: Array<{ at: string; receiptPath: string; receiptSha256: string }>;
  corePrDependencies: string[];
}
export interface CampaignScenario {
  id: string; feature: string; sourceFile: string; sourceSha256: string;
  capabilities: string[]; context: string; query: string; expected_outcome: string;
  scenarioSha256: string;
  qualifyingDefinitionDigest: string | null;
  qualifyingGraderDigest: string | null;
  owner: string;
  readiness: "unimplemented" | "partial" | "implemented" | "blocked";
  /** Complete callbacks, executable supported-surface blocker, unfinished conditional, or absent. */
  authoringStatus?: "complete" | "concrete-blocker" | "unfinished" | "absent";
  blockerProbeSources?: string[];
  executionId: string | null;
  blocker: string | null;
  productPolicy?: { lane: CampaignProductLane; sourceBaselineRevision: string };
  attempts: CampaignAttempt[];
}
export interface ChatCampaign {
  version: 1; campaignId: string; frozenAt: string; baselineRevision: string;
  inventoryDigest: string; defaultsSha256: string;
  denominator: number; areas: number; capabilities: number;
  requiredPasses: number;
  corePrs: string[]; evalPr: string | null;
  /** Authored metadata only; never passing execution evidence. */
  implementationCheckpoint?: { sourceRevision: string; descriptorSha256: string; authored: number; complete: number; partial: number; unimplemented: number };
  scenarios: CampaignScenario[];
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function freezeChatCampaign(root: string, baselineRevision: string): ChatCampaign {
  const directory = path.join(root, "tests/runner-e2e/chat-scenarios");
  const scenarios: CampaignScenario[] = [];
  const files = readdirSync(directory).filter(name => name.endsWith(".yaml") && name !== "defaults.yaml").sort();
  for (const file of files) {
    const text = readFileSync(path.join(directory, file), "utf8");
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw new Error(`Invalid catalog ${file}`);
    const value = document.toJS();
    for (const scenario of value.scenarios) {
      const canonical = { id: scenario.id, capabilities: scenario.capabilities, context: scenario.context, query: scenario.query, expected_outcome: scenario.expected_outcome };
      if (scenarios.some(entry => entry.id === scenario.id)) throw new Error(`Duplicate scenario ${scenario.id}`);
      const legacy = ["tasks.create-backlog", "tasks.delegate-announcement"].includes(scenario.id);
      scenarios.push({ ...canonical, feature: value.feature, sourceFile: `tests/runner-e2e/chat-scenarios/${file}`,
        sourceSha256: digest(text), scenarioSha256: digest(JSON.stringify(canonical)),
        qualifyingDefinitionDigest: null, qualifyingGraderDigest: null,
        owner: legacy ? "eval_integrator" : "unassigned", readiness: legacy ? "implemented" : "unimplemented",
        executionId: legacy ? `chat-features.runner-codex-subscription.local.${scenario.id.slice(6)}` : null,
        blocker: null, productPolicy: scenarioProductPolicy(scenario.id, baselineRevision), attempts: [] });
    }
  }
  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  const capabilities = new Set(scenarios.flatMap(scenario => scenario.capabilities)).size;
  if (scenarios.length !== 244 || files.length !== 35 || capabilities !== 191) throw new Error("Frozen denominator changed; reconcile explicitly");
  const defaultsSha256 = digest(readFileSync(path.join(directory, "defaults.yaml"), "utf8"));
  return { version: 1, campaignId: "chat-catalog-2026-10-26", frozenAt: new Date().toISOString(), baselineRevision,
    inventoryDigest: digest(JSON.stringify({ defaultsSha256, scenarios: scenarios.map(({ id, scenarioSha256, sourceSha256 }) => ({ id, scenarioSha256, sourceSha256 })) })),
    defaultsSha256, denominator: scenarios.length, areas: files.length, capabilities, requiredPasses: Math.ceil(scenarios.length * 0.8), corePrs: [], evalPr: null, scenarios };
}
export function validateFrozenCampaign(campaign: ChatCampaign, root: string): void {
  const fresh = freezeChatCampaign(root, campaign.baselineRevision);
  if (campaign.version !== 1 || campaign.denominator !== 244 || campaign.areas !== 35 || campaign.capabilities !== 191
    || campaign.requiredPasses !== 196 || campaign.scenarios.length !== 244 || campaign.defaultsSha256 !== fresh.defaultsSha256
    || campaign.inventoryDigest !== fresh.inventoryDigest) throw new Error("Frozen campaign inventory metadata changed");
  for (let index = 0; index < campaign.scenarios.length; index++) {
    const actual = campaign.scenarios[index]!; const expected = fresh.scenarios[index]!;
    for (const field of ["id", "feature", "sourceFile", "sourceSha256", "scenarioSha256", "capabilities", "context", "query", "expected_outcome", "productPolicy"] as const) {
      if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) throw new Error(`Frozen scenario content changed: ${expected.id}`);
    }
    if (actual.attempts.length > 2 || actual.attempts.some((attempt, attemptIndex) => attempt.ordinal !== attemptIndex + 1 || attempt.automaticRetries !== 0)) throw new Error(`Invalid attempt history: ${actual.id}`);
  }
}
export function reserveCampaignAttempt(scenario: CampaignScenario, attempt: CampaignAttempt): void {
  if (!scenario.productPolicy || !identityRevision(scenario.productPolicy.sourceBaselineRevision) || scenario.productPolicy.lane !== scenarioProductPolicy(scenario.id, scenario.productPolicy.sourceBaselineRevision).lane) throw new Error("Attempt requires a declared product lane");
  if (!(scenario.readiness === "implemented" || (scenario.readiness === "partial" && scenario.authoringStatus === "concrete-blocker" && scenario.blockerProbeSources?.length)) || !scenario.executionId) throw new Error("Scenario has no executable implementation");
  if (scenario.attempts.some(entry => entry.outcome === "running")) throw new Error("Previous attempt still running");
  if (scenario.attempts.length >= 2 || attempt.ordinal !== scenario.attempts.length + 1) throw new Error("Attempt budget exhausted or incorrect ordinal");
  if (attempt.ordinal === 2 && !attempt.correction?.trim()) throw new Error("Fix cycle requires a recorded correction");
  if (attempt.automaticRetries !== 0 || attempt.executionId !== scenario.executionId || attempt.outcome !== "running") throw new Error("Invalid attempt reservation");
  if ([attempt.sourceRevision, attempt.workingTreeDigest, attempt.definitionDigest, attempt.suiteDefinitionDigest, attempt.graderDigest, attempt.model, attempt.profile, attempt.environment].some(value => !value.trim())) throw new Error("Missing attempt provenance");
  const selectedDatabase = databaseFingerprintIdentity();
  if (attempt.databaseLane && JSON.stringify(attempt.databaseLane) !== JSON.stringify(selectedDatabase)) throw new Error("Attempt database lane differs from selected fingerprint environment");
  attempt.databaseLane ??= selectedDatabase;
  const first = scenario.attempts[0];
  if (first?.outcome === "passed") {
    const record = attempt.passedRevalidation, previous = campaignRevalidationIdentity(first), next = campaignRevalidationIdentity(attempt);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const actualInvalidation = previous.definitionDigest !== next.definitionDigest || previous.graderDigest !== next.graderDigest
      || !same(previous.databaseLane, next.databaseLane) || previous.productBaseline !== null && next.productBaseline !== null && previous.productBaseline !== next.productBaseline && campaignProductIdentityEligible(scenario, attempt);
    if (!record?.reason.trim() || !attempt.correction?.trim() || !actualInvalidation || !same(record.previous, previous) || !same(record.next, next)
      || attempt.definitionDigest !== scenario.qualifyingDefinitionDigest || attempt.graderDigest !== scenario.qualifyingGraderDigest) throw new Error("Passing scenario cannot be rerun without recorded actual qualifying identity invalidation");
  } else if (attempt.passedRevalidation) throw new Error("Passed-result revalidation requires an original pass");
  scenario.attempts.push(attempt);
}
export function completeCampaignAttempt(scenario: CampaignScenario, completion: {
  outcome: CampaignOutcome; productIdentity?: CampaignProductIdentity; finishedAt: string; definitionDigest: string; graderDigest: string;
  evidencePaths: string[]; cleanup: CampaignAttempt["cleanup"]; usage: CampaignAttempt["usage"];
  classification: string | null;
  diagnosisHistory?: Array<{ at: string; classification: string | null; detail: string | null; supersededBy: string }>; observedFailure: string | null; corePrDependencies: string[];
}): void {
  const attempt = scenario.attempts.at(-1);
  if (!attempt || attempt.outcome !== "running") throw new Error("No running reserved attempt");
  if (completion.definitionDigest !== attempt.definitionDigest || completion.graderDigest !== attempt.graderDigest) throw new Error("Definition or grader changed during attempt");
  if (completion.evidencePaths.some(value => !value.startsWith("tests/runner-e2e/results/") || value.split("/").includes(".."))) throw new Error("Evidence must use retained sanitized result paths");
  if (completion.outcome === "passed" && (scenario.readiness !== "implemented" || (scenario.authoringStatus && scenario.authoringStatus !== "complete"))) throw new Error("Incomplete conditions cannot pass");
  if (completion.outcome === "passed" && (!completion.evidencePaths.length || completion.cleanup !== "passed")) throw new Error("Pass requires evidence and successful cleanup");
  if (completion.outcome === "passed" && !campaignProductIdentityEligible(scenario, { ...attempt, ...completion })) throw new Error("Pass requires eligible product identity");
  if (Date.parse(completion.finishedAt) < Date.parse(attempt.startedAt) || !Number.isFinite(Date.parse(completion.finishedAt))) throw new Error("Invalid completion timing");
  if (completion.outcome === "passed" && !campaignDatabaseEvidenceEligible({ ...attempt, evidencePaths: completion.evidencePaths })) throw new Error("Passed outcome lacks matching database environment identity");
  Object.assign(attempt, completion);
}
/** A reservation or offline calibration alone never establishes actual processing. */
export function campaignDatabaseEvidenceEligible(attempt: CampaignAttempt, root = process.cwd()) {
  const expected = attempt.databaseLane ?? { lane: "embedded-postgres" as const };
  const rows = attempt.evidencePaths.filter(relative => relative.startsWith("tests/runner-e2e/results/") && !relative.split("/").includes("..") && path.basename(relative) === "result.json").flatMap(relative => {
    try { return [JSON.parse(readFileSync(path.join(root, relative), "utf8"))]; } catch { return []; }
  });
  // Historical embedded interpretation stays backward-compatible. A retained
  // Docker identity can never masquerade as an undeclared/embedded result.
  if (expected.lane === "embedded-postgres") return rows.every(row => row.databaseIdentity === undefined);
  return rows.length > 0 && rows.every(row => row.executionId === attempt.executionId && row.source?.sha === attempt.sourceRevision && databaseIdentityMatches(expected, row.databaseIdentity));
}
export function campaignAttemptProcessed(attempt: CampaignAttempt, root = process.cwd()): boolean {
  if (attempt.outcome === "running" || !attempt.finishedAt) return false;
  return attempt.evidencePaths.some(relative => {
    if (!relative.startsWith("tests/runner-e2e/results/") || relative.split("/").includes("..") || path.basename(relative) !== "result.json") return false;
    try {
      const result = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
      return result.executionId === attempt.executionId && result.source?.sha === attempt.sourceRevision
        && (attempt.databaseLane?.lane !== "owned-docker-postgres" || result.databaseIdentity?.lane === "owned-docker-postgres")
        && ["passed", "failed"].includes(result.status) && (attempt.outcome !== "passed" || result.status === "passed")
        && Number.isFinite(Date.parse(result.startedAt)) && Number.isFinite(Date.parse(result.finishedAt))
        && Date.parse(result.finishedAt) >= Date.parse(result.startedAt);
    } catch { return false; }
  });
}

/** Closed, hash-bound evidence of later absence; an acknowledgement or partial PID census is insufficient. */
export function campaignCleanupResolved(attempt: CampaignAttempt, root = process.cwd()): boolean {
  if (attempt.cleanup === "passed" || attempt.cleanup === "not_started") return true;
  if (attempt.outcome === "running" || !attempt.finishedAt) return false;
  const retained = (relative: string, sha: string) => {
    if (!identityHash(sha) || !retainedIdentityPaths([relative])) throw new Error("Invalid cleanup evidence reference");
    const file = path.resolve(realpathSync(root), relative);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || realpathSync(file) !== file) throw new Error("Cleanup evidence must be a retained regular file");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("Cleanup evidence changed");
    return JSON.parse(bytes.toString("utf8"));
  };
  return (attempt.cleanupResolutions ?? []).some(resolution => {
    try {
      const r = retained(resolution.receiptPath, resolution.receiptSha256);
      if (r.schemaVersion !== 1 || r.executionId !== attempt.executionId || r.ordinal !== attempt.ordinal || r.originalCleanup !== attempt.cleanup
        || r.observedAt !== resolution.at || !identityRevision(r.verifierSourceRevision) || !Number.isFinite(Date.parse(r.observedAt))
        || Date.parse(r.observedAt) < Date.parse(attempt.finishedAt!)) return false;
      if (!attempt.evidencePaths.includes(r.originalEvidence.path)) return false;
      const original = retained(r.originalEvidence.path, r.originalEvidence.sha256);
      if (original.schemaVersion !== 1 || original.kind !== "campaign-admitted-resource-inventory" || original.executionId !== attempt.executionId
        || original.ordinal !== attempt.ordinal || original.cleanup !== attempt.cleanup || !Array.isArray(original.resources)
        || !Number.isFinite(Date.parse(original.recordedAt)) || Date.parse(original.recordedAt) > Date.parse(attempt.finishedAt!)) return false;
      const inventory = retained(r.inventory.path, r.inventory.sha256);
      if (inventory.executionId !== attempt.executionId || inventory.ordinal !== attempt.ordinal || inventory.complete !== true
        || !["processes", "database", "proxy"].every(scope => inventory.completeScopes?.includes(scope)) || !Array.isArray(inventory.resources)) return false;
      const scopeFor = (kind: string) => kind === "process" ? "processes" : kind === "proxy" ? "proxy" : "database";
      for (const scope of ["processes", "database", "proxy"]) {
        if (original.resources.some((row: { kind: string }) => scopeFor(row.kind) === scope)) continue;
        const unused = original.notAdmittedScopes?.[scope];
        if (!unused) return false;
        const evidence = retained(unused.path, unused.sha256);
        if (evidence.executionId !== attempt.executionId || evidence.ordinal !== attempt.ordinal || evidence.scope !== scope || evidence.notAdmitted !== true
          || !Number.isFinite(Date.parse(evidence.observedAt)) || Date.parse(evidence.observedAt) > Date.parse(attempt.finishedAt!)) return false;
      }
      const identity = (row: { kind: string; id: string; ownershipEvidence: { path: string; sha256: string } }) => JSON.stringify([row.kind, row.id, row.ownershipEvidence.path, row.ownershipEvidence.sha256]);
      if (inventory.resources.length !== original.resources.length
        || inventory.resources.some((row: Parameters<typeof identity>[0]) => !original.resources.some((saved: Parameters<typeof identity>[0]) => identity(row) === identity(saved)))) return false;
      if (!Array.isArray(r.resources) || r.resources.length !== inventory.resources.length) return false;
      const identities = new Set<string>();
      return inventory.resources.every((resource: { kind: string; id: string; ownershipEvidence: { path: string; sha256: string } }) => {
        if (!["process", "container", "volume", "proxy"].includes(resource.kind) || !resource.id) return false;
        const key = `${resource.kind}:${resource.id}`;
        if (identities.has(key)) return false;
        identities.add(key);
        const ownership = retained(resource.ownershipEvidence.path, resource.ownershipEvidence.sha256);
        if (ownership.executionId !== attempt.executionId || ownership.ordinal !== attempt.ordinal || ownership.kind !== resource.kind
          || ownership.id !== resource.id || ownership.owned !== true) return false;
        const rows = r.resources.filter((row: { kind: string; id: string }) => row.kind === resource.kind && row.id === resource.id);
        if (rows.length !== 1) return false;
        const evidence = retained(rows[0].absenceEvidence.path, rows[0].absenceEvidence.sha256);
        return evidence.kind === resource.kind && evidence.id === resource.id && evidence.absent === true
          && evidence.ownershipEvidenceSha256 === resource.ownershipEvidence.sha256 && evidence.observedAt === r.observedAt;
      });
    } catch { return false; }
  });
}
export function appendCampaignCleanupResolution(attempt: CampaignAttempt, resolution: NonNullable<CampaignAttempt["cleanupResolutions"]>[number], root = process.cwd()): void {
  if (!["failed", "pending"].includes(attempt.cleanup) || attempt.cleanupResolutions?.some(row => row.receiptPath === resolution.receiptPath)) throw new Error("Cleanup resolution must append distinct evidence to unresolved historical cleanup");
  if (!campaignCleanupResolved({ ...attempt, cleanupResolutions: [resolution] }, root)) throw new Error("Cleanup resolution lacks complete verified resource absence");
  (attempt.cleanupResolutions ??= []).push({ ...resolution });
}
export function campaignSummary(campaign: ChatCampaign, root = process.cwd()) {
  const initialPassed = campaign.scenarios.filter(scenario => { const first = scenario.attempts[0]; return scenario.readiness === "implemented" && (!scenario.authoringStatus || scenario.authoringStatus === "complete") && first?.outcome === "passed" && first.cleanup === "passed" && first.corePrDependencies.length === 0 && campaignProductIdentityEligible(scenario, first, campaign.baselineRevision) && campaignDatabaseEvidenceEligible(first, root); }).length;
  const passed = campaign.scenarios.filter(scenario => { const final = scenario.attempts.at(-1); return scenario.readiness === "implemented" && (!scenario.authoringStatus || scenario.authoringStatus === "complete") && final?.outcome === "passed" && final.corePrDependencies.length === 0 && final.cleanup === "passed" && final.definitionDigest === scenario.qualifyingDefinitionDigest && final.graderDigest === scenario.qualifyingGraderDigest && campaignProductIdentityEligible(scenario, final, campaign.baselineRevision) && campaignDatabaseEvidenceEligible(final, root); }).length;
  const attempted = campaign.scenarios.filter(scenario => scenario.attempts.length).length;
  const implemented = campaign.scenarios.filter(scenario => scenario.readiness === "implemented" && (!scenario.authoringStatus || scenario.authoringStatus === "complete")).length;
  const concreteBlockers = campaign.scenarios.filter(s => s.authoringStatus === "concrete-blocker" && s.executionId && s.blockerProbeSources?.length).length;
  const authored = campaign.scenarios.filter(s => s.readiness !== "unimplemented" && s.executionId).length;
  const unfinished = authored - implemented - concreteBlockers;
  const authoringResolved = implemented + concreteBlockers;
  const processed = campaign.scenarios.filter(s => s.attempts.some(a => campaignAttemptProcessed(a, root))).length;
  const measured = campaign.scenarios.flatMap(scenario => scenario.attempts.map(attempt => ({ scenario, attempt })));
  const productEvidence = { sourceBaselineRevision: campaign.baselineRevision,
    measurementsByIdentity: Object.fromEntries(["source-build", "published-release", "source-built-installed", "unknown"].map(kind => [kind, measured.filter(row => (row.attempt.productIdentity?.kind ?? "unknown") === kind).length])),
    identityIneligibleMeasurements: measured.filter(row => !campaignProductIdentityEligible(row.scenario, row.attempt, campaign.baselineRevision)).length };
  return { authored, coverageComplete: implemented, concreteBlockers, unfinished, authoringResolved, processed, sourceChatHumanCountScope: "standing-source-chat-only", productEvidence, denominator: campaign.denominator, implemented, attempted, unrun: campaign.denominator - attempted,
    initialPassed, finalPassed: passed, firstAttemptRate: initialPassed / campaign.denominator,
    finalRate: passed / campaign.denominator, requiredPasses: campaign.requiredPasses,
    unresolvedCleanup: measured.filter(({ attempt }) => !campaignCleanupResolved(attempt, root)).length,
    mergeEligible: authoringResolved === campaign.denominator && processed === campaign.denominator && passed >= campaign.requiredPasses && !campaign.scenarios.some(scenario => scenario.attempts.some(attempt => attempt.outcome === "running" || !campaignCleanupResolved(attempt, root))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, baseline] = process.argv.slice(2);
  if (command === "freeze" && baseline) {
    writeFileSync(CHAT_CAMPAIGN_MANIFEST, `${JSON.stringify(freezeChatCampaign(process.cwd(), baseline), null, 2)}\n`, { flag: "wx" });
  } else if (command !== "summary") throw new Error("Usage: chat-campaign.ts freeze <baseline> | summary");
  const campaign = JSON.parse(readFileSync(CHAT_CAMPAIGN_MANIFEST, "utf8")) as ChatCampaign;
  validateFrozenCampaign(campaign, process.cwd());
  process.stdout.write(`${JSON.stringify({ inventoryDigest: campaign.inventoryDigest, ...campaignSummary(campaign) }, null, 2)}\n`);
}
