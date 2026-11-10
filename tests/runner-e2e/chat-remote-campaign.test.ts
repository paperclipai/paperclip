import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRemoteCell, validateRemoteCell, remoteCellUsage, validateRemoteHostRefusal, type RemoteArtifactDocument, type RemoteCampaign } from "./chat-remote-campaign.js";
import { DATABASE_LANE_ENV, POSTGRES_ARTIFACT_ENV, POSTGRES_IMAGE_ID_ENV, POSTGRES_AMD64_IMAGE, POSTGRES_AMD64_IMAGE_IDS, POSTGRES_VERSION } from "./docker-postgres.js";
import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
import type { CampaignAttempt } from "./chat-campaign.js";
const digest = (x: string) => createHash("sha256").update(x).digest("hex");
const source = "a".repeat(40), hash = "b".repeat(64), runId = "12345";
const execution = "chat-features.runner-opencode.local.create-backlog";
const wrap = (name: string, value: unknown): RemoteArtifactDocument => { const bytes = JSON.stringify(value); return { path: `tests/runner-e2e/results/remote/${name}`, bytes, sha256: digest(bytes) }; };
function fixture() {
  const result: any = { schema: "paperclip.runner-e2e.result/v2", executionId: execution, attempt: 1, status: "failed", cleanup: "passed", profileId: "runner-opencode", provider: "opencode", model: CHAT_OPENCODE_MODEL, environmentId: "local", source: { sha: source, workflowRunUrl: `https://github.com/paperclipai/paperclip/actions/runs/${runId}` }, accountingIdentity: { campaignId: "actual-workflow-generated", attemptId: "c".repeat(32) }, suiteDefinitionHash: hash, startedAt: "2026-10-27T14:00:00Z", finishedAt: "2026-10-27T14:01:00Z", durationMs: 60000,
    databaseIdentity: { lane: "owned-docker-postgres", image: POSTGRES_AMD64_IMAGE, imageId: POSTGRES_AMD64_IMAGE_IDS[0], architecture: "amd64", imageVersion: POSTGRES_VERSION, artifactVerified: true, contextSha256: hash, engineSha256: hash, containerId: "d".repeat(64), cluster: { version: "18.6 (Debian)", systemIdentifier: "12345" }, status: "removed" } };
  const host: any = { schema: "paperclip.chat-remote-host/v1", status: "qualified-host-only", scope: "before-evaluation", evaluationAdmitted: false, spotVerified: true, lifecycle: "spot", architecture: "x86_64", region: "us-east-1", workflowRef: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master", workflowRunId: runId, workflowAttempt: 1, sourceRevision: source, executionIds: [execution], automaticRetries: 0, dockerEngineSha256: hash, postgres: { image: POSTGRES_AMD64_IMAGE, imageId: POSTGRES_AMD64_IMAGE_IDS[0], architecture: "amd64", version: POSTGRES_VERSION } };
  const definition: any = { scenarioId: "tasks.create-backlog", definitionDigest: hash, graderDigest: hash, suiteDefinitionHash: hash };
  const input = () => ({ intent: { campaignId: "remote-campaign", sourceRevision: source, selected: [{ scenarioId: "tasks.create-backlog", executionId: execution, remoteOrdinal: 1 as const }] }, provenance: { repository: "paperclipai/paperclip" as const, workflow: "runner-full-stack-e2e.yml" as const, workflowRef: "refs/heads/master" as const, runId, runAttempt: 1, artifactId: "998", archiveSha256: hash, targetSourceRevision: source }, result: wrap("result.json", result), host: wrap("chat-remote-host.json", host), definition: wrap("chat-catalog-definition.json", definition) });
  return { result, host, definition, input };
}
afterEach(() => vi.unstubAllEnvs());
describe("remote Actions cell import", () => {
  it("retains actual cell facts independently of any reporting-job conclusion", () => {
    const f = fixture(), cell = validateRemoteCell(f.input());
    expect(cell.result.status).toBe("failed"); expect(cell.result.accountingIdentity?.campaignId).toBe("actual-workflow-generated"); expect(cell.databaseLane).toMatchObject({ architecture: "amd64" });
  });
  it.each([
    ["OnDemand", (f: ReturnType<typeof fixture>) => { f.host.lifecycle = "on-demand"; }],
    ["wrong source", (f: ReturnType<typeof fixture>) => { f.result.source.sha = "e".repeat(40); }],
    ["wrong model", (f: ReturnType<typeof fixture>) => { f.result.model = "gpt-5.6"; }],
    ["wrong workflow", (f: ReturnType<typeof fixture>) => { f.host.workflowRef = "fork/workflow"; }],
    ["wrong database", (f: ReturnType<typeof fixture>) => { f.result.databaseIdentity.architecture = "arm64"; }],
    ["mixed engine", (f: ReturnType<typeof fixture>) => { f.result.databaseIdentity.engineSha256 = "e".repeat(64); }],
    ["wrong scenario", (f: ReturnType<typeof fixture>) => { f.definition.scenarioId = "tasks.other"; }],
    ["missing accounting", (f: ReturnType<typeof fixture>) => { delete f.result.accountingIdentity; }],
  ] as const)("rejects %s without recording a measurement", (_name, mutate) => { const f = fixture(); mutate(f); expect(() => validateRemoteCell(f.input())).toThrow("Remote import:"); });
  it("imports the ordinary embedded lane only under an explicit matching intent", () => {
    const f = fixture();
    delete f.result.databaseIdentity; delete f.host.postgres; delete f.host.dockerEngineSha256;
    f.host.databaseLane = "embedded-postgres";
    expect(() => validateRemoteCell(f.input())).toThrow("host database lane mismatch");
    const input = f.input();
    expect(validateRemoteCell({ ...input, intent: { ...input.intent, databaseLane: { lane: "embedded-postgres" } } }).databaseLane).toEqual({ lane: "embedded-postgres" });
  });
  it.each(["host lane", "Docker receipt", "Docker engine", "Docker artifact"])("rejects embedded/Docker mixed evidence: %s", variant => {
    const f = fixture(); const docker = f.result.databaseIdentity;
    delete f.result.databaseIdentity; delete f.host.postgres; delete f.host.dockerEngineSha256;
    f.host.databaseLane = "embedded-postgres";
    if (variant === "host lane") f.host.databaseLane = "owned-docker-postgres";
    if (variant === "Docker receipt") f.result.databaseIdentity = docker;
    if (variant === "Docker engine") f.host.dockerEngineSha256 = hash;
    if (variant === "Docker artifact") f.host.postgres = {};
    const input = f.input();
    expect(() => validateRemoteCell({ ...input, intent: { ...input.intent, databaseLane: { lane: "embedded-postgres" } } })).toThrow("database");
  });
  it("rejects changed bytes, foreign result paths and unreviewed Actions reruns", () => {
    const f = fixture(), changed = f.input(); changed.result.bytes += " "; expect(() => validateRemoteCell(changed)).toThrow("bytes changed");
    const foreign = f.input(); foreign.result.path = "../result.json"; expect(() => validateRemoteCell(foreign)).toThrow("artifact path");
    const rerun = f.input(); rerun.provenance.runAttempt = 2; expect(() => validateRemoteCell(rerun)).toThrow("job rerun");
  });
  it("accepts proven normal-fleet fallback only under a new explicit intent and matching receipt", () => {
    const f = fixture(); f.host.hostPolicy = "aws-fleet-spot-or-on-demand"; f.host.lifecycle = "on-demand"; f.host.spotVerified = false;
    expect(() => validateRemoteCell(f.input())).toThrow("intent policy");
    const allowed = () => { const input = f.input(); return { ...input, intent: { ...input.intent, hostPolicy: "aws-fleet-spot-or-on-demand" as const } }; };
    expect(validateRemoteCell(allowed())).toMatchObject({ hostLifecycle: "on-demand", hostPolicy: "aws-fleet-spot-or-on-demand" });
    f.host.spotVerified = true; expect(() => validateRemoteCell(allowed())).toThrow("intent policy");
    f.host.spotVerified = false; f.host.lifecycle = "unknown"; expect(() => validateRemoteCell(allowed())).toThrow("intent policy");
    f.host.lifecycle = "on-demand"; delete f.host.hostPolicy; expect(() => validateRemoteCell(allowed())).toThrow("intent policy");
    f.host.hostPolicy = "aws-fleet-spot-or-on-demand"; f.host.lifecycle = "spot"; f.host.spotVerified = true;
    expect(validateRemoteCell(allowed()).hostLifecycle).toBe("spot");
  });
  it("imports actual On-Demand refusal only as an operation with zero case ordinals", () => {
    const f = fixture(); Object.assign(f.host, { status: "blocked", lifecycle: "on-demand", reason: "on-demand-or-unknown-host-refused-before-evaluation", instanceId: "i-12345678", imageId: "ami-12345678" });
    delete f.host.postgres; delete f.host.dockerEngineSha256;
    const operation = validateRemoteHostRefusal(f.input());
    expect(operation.caseMeasurements).toBe(0); expect(operation.caseOrdinalsConsumed).toBe(0); expect(operation.initialIntentConsumed).toBe(false);
    f.host.evaluationAdmitted = true; expect(() => validateRemoteHostRefusal(f.input())).toThrow("host refusal");
    f.host.evaluationAdmitted = false; f.host.lifecycle = "spot"; expect(() => validateRemoteHostRefusal(f.input())).toThrow("host refusal");
  });
  it("retains Spot image-qualification refusal separately and rejects invented admission", () => {
    const f = fixture(); Object.assign(f.host, { status: "blocked", lifecycle: "spot", reason: "owned-linux-amd64-postgres-image-unqualified", instanceId: "i-12345678", imageId: "ami-12345678" });
    delete f.host.postgres; delete f.host.dockerEngineSha256;
    const operation = validateRemoteHostRefusal(f.input());
    expect(operation.actualHost.lifecycle).toBe("spot"); expect(operation.caseOrdinalsConsumed).toBe(0);
    f.host.reason = "unknown-failure"; expect(() => validateRemoteHostRefusal(f.input())).toThrow("host refusal");
    f.host.reason = "owned-linux-amd64-postgres-image-unqualified"; f.host.postgres = {};
    expect(() => validateRemoteHostRefusal(f.input())).toThrow("host refusal");
  });
  it("keeps unknown billing unknown and reported OpenRouter billing separate", () => {
    const f = fixture(); expect(remoteCellUsage(f.result)).toEqual({ costUsd: null, tokens: null, coverage: "unavailable" });
    f.result.billing = { llm: { totalTokens: 123, reportedCostUsd: 0.02, costStatus: "reported" } };
    expect(remoteCellUsage(f.result)).toEqual({ costUsd: 0.02, tokens: 123, coverage: "reported" });
  });
  it("imports exactly once through existing campaign guards and never changes historical input", () => {
    vi.stubEnv(DATABASE_LANE_ENV, "owned-docker-postgres"); vi.stubEnv(POSTGRES_ARTIFACT_ENV, "linux-amd64"); vi.stubEnv(POSTGRES_IMAGE_ID_ENV, POSTGRES_AMD64_IMAGE_IDS[0]);
    const f = fixture(), cell = validateRemoteCell(f.input());
    const campaign = { campaignId: "remote-campaign", scenarios: [{ id: cell.scenarioId, executionId: execution, readiness: "implemented", authoringStatus: "complete", productPolicy: { lane: "source-build", sourceBaselineRevision: source }, attempts: [] }] } as unknown as RemoteCampaign;
    const attempt: CampaignAttempt = { ordinal: 1, executionId: execution, outcome: "running", startedAt: f.result.startedAt, finishedAt: null, sourceRevision: source, workingTreeDigest: hash, definitionDigest: hash, graderDigest: hash, suiteDefinitionDigest: hash, profile: "runner-opencode", model: CHAT_OPENCODE_MODEL, environment: "local", automaticRetries: 0, correction: null, classification: null, observedFailure: null, evidencePaths: [], usage: { costUsd: null, tokens: null, coverage: "unavailable" }, cleanup: "pending", corePrDependencies: [], databaseLane: cell.databaseLane };
    const qualification = { attempt, completion: { outcome: "failed" as const, finishedAt: f.result.finishedAt, definitionDigest: hash, graderDigest: hash, evidencePaths: [cell.resultPath], cleanup: "passed" as const, usage: attempt.usage, classification: "candidate_failure", observedFailure: null, corePrDependencies: [] } };
    const imported = applyRemoteCell(campaign, cell, qualification);
    expect(() => applyRemoteCell({ ...campaign, campaignId: "historical-local" }, cell, qualification)).toThrow("historical or foreign campaign");
    expect(campaign.scenarios[0]!.attempts).toHaveLength(0); expect(imported.campaign.scenarios[0]!.attempts).toHaveLength(1);
    expect(applyRemoteCell(imported.campaign, cell, qualification).duplicate).toBe(true);
    expect(() => applyRemoteCell(imported.campaign, { ...cell, resultSha256: "e".repeat(64) }, qualification)).toThrow("duplicate ordinal");
    expect(() => applyRemoteCell(campaign, cell, { ...qualification, completion: { ...qualification.completion, outcome: "passed" } })).toThrow("outcome or cleanup rewritten");
  });
});
