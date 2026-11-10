import { createHash } from "node:crypto";
import { completeCampaignAttempt, reserveCampaignAttempt, type CampaignAttempt, type ChatCampaign } from "./chat-campaign.js";
import { databaseIdentityMatches, POSTGRES_AMD64_IMAGE, POSTGRES_AMD64_IMAGE_IDS, POSTGRES_VERSION, type DatabaseFingerprintIdentity } from "./docker-postgres.js";
import { CHAT_OPENCODE_MODEL, CHAT_OPENCODE_PROFILE } from "./chat-runtime-profile.js";
import type { RunnerE2EResult } from "./types.js";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requireProof(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Remote import: ${message}`); }
export interface RemoteCellIntent {
  campaignId: string; sourceRevision: string;
  /** Absent on preserved strict-Spot intents. Only new explicit user-authorized sources opt in. */
  hostPolicy?: "aws-fleet-spot-or-on-demand";
  /** Explicit new lane selection; absent preserves historical Docker-only intents. */
  databaseLane?: DatabaseFingerprintIdentity;
  selected: Array<{ scenarioId: string; executionId: string; remoteOrdinal: 1 | 2 }>;
}
/** Obtained by the coordinator through authenticated Actions run/artifact APIs, not from
 * files inside an untrusted archive. A reporting job's conclusion is deliberately absent. */
export interface RemoteArtifactProvenance {
  repository: "paperclipai/paperclip"; workflow: "runner-full-stack-e2e.yml"; workflowRef: "refs/heads/master";
  runId: string; runAttempt: number; artifactId: string; archiveSha256: string;
  targetSourceRevision: string;
}
export interface RemoteArtifactDocument { path: string; bytes: string; sha256: string }
export interface ValidatedRemoteCell {
  schema: "paperclip.chat-remote-cell-import/v1";
  intentCampaignId: string; importKey: string; measurementKey: string; artifactSha256: string;
  scenarioId: string; ordinal: 1 | 2; sourceRevision: string;
  resultPath: string; resultSha256: string; hostSha256: string; definitionSha256: string;
  result: RunnerE2EResult; definitionDigest: string; graderDigest: string;
  hostLifecycle: "spot" | "on-demand"; hostPolicy: "spot-only" | "aws-fleet-spot-or-on-demand";
  databaseLane: DatabaseFingerprintIdentity;
}
function document(value: RemoteArtifactDocument): Record<string, any> {
  requireProof(value.path.startsWith("tests/runner-e2e/results/") && !value.path.split("/").includes("..") && !value.path.includes("\\"), "non-retained artifact path");
  requireProof(hex(value.sha256) && sha(value.bytes) === value.sha256, "artifact document bytes changed");
  const parsed = JSON.parse(value.bytes);
  requireProof(parsed && typeof parsed === "object" && !Array.isArray(parsed), "invalid artifact document");
  return parsed;
}
/** Validates measured cell facts only. Final pass qualification still uses the existing
 * product/build/native, definition replay, privacy and cleanup campaign gates below. */
export function validateRemoteCell(input: {
  intent: RemoteCellIntent; provenance: RemoteArtifactProvenance;
  result: RemoteArtifactDocument; host: RemoteArtifactDocument; definition: RemoteArtifactDocument;
}): ValidatedRemoteCell {
  const { intent, provenance: p } = input;
  requireProof(!!intent.campaignId.trim(), "missing new campaign identity");
  requireProof(p.repository === "paperclipai/paperclip" && p.workflow === "runner-full-stack-e2e.yml" && p.workflowRef === "refs/heads/master", "foreign workflow");
  requireProof(/^\d+$/.test(p.runId) && p.runAttempt === 1 && /^\d+$/.test(p.artifactId) && hex(p.archiveSha256), "missing artifact identity or unreviewed job rerun");
  requireProof(/^[a-f0-9]{40}$/.test(intent.sourceRevision) && p.targetSourceRevision === intent.sourceRevision, "target source mismatch");
  const result = document(input.result) as RunnerE2EResult, host = document(input.host), definition = document(input.definition);
  const selected = intent.selected.filter(row => row.executionId === result.executionId);
  requireProof(selected.length === 1, "execution not uniquely selected");
  const selection = selected[0]!;
  requireProof([1, 2].includes(selection.remoteOrdinal) && result.attempt === 1, "automatic retry or invalid remote ordinal");
  requireProof(result.schema === "paperclip.runner-e2e.result/v2" && ["passed", "failed"].includes(result.status), "missing terminal cell result");
  requireProof(result.profileId === CHAT_OPENCODE_PROFILE && result.provider === "opencode" && result.model === CHAT_OPENCODE_MODEL && result.environmentId === "local", "provider/model/profile mismatch");
  requireProof(result.source?.sha === intent.sourceRevision && result.source.workflowRunUrl === `https://github.com/paperclipai/paperclip/actions/runs/${p.runId}`, "result source/run mismatch");
  requireProof(!!result.accountingIdentity?.campaignId && /^[a-f0-9]{32}$/.test(result.accountingIdentity?.attemptId ?? ""), "missing actual framework accounting identity");
  requireProof(Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.finishedAt) >= Date.parse(result.startedAt) && Number.isFinite(result.durationMs) && result.durationMs >= 0, "invalid actual timing");
  const normalFleet = intent.hostPolicy === "aws-fleet-spot-or-on-demand";
  const allowedHost = normalFleet ? host.hostPolicy === intent.hostPolicy && ["spot", "on-demand"].includes(host.lifecycle)
    && host.spotVerified === (host.lifecycle === "spot") : host.lifecycle === "spot" && host.spotVerified === true;
  requireProof(intent.hostPolicy === undefined || normalFleet, "unknown host policy");
  requireProof(host.schema === "paperclip.chat-remote-host/v1" && host.status === "qualified-host-only" && host.scope === "before-evaluation" && host.evaluationAdmitted === false
    && allowedHost && host.architecture === "x86_64" && host.region === "us-east-1", "host not qualified for explicit intent policy");
  requireProof(host.workflowRef === "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master"
    && host.workflowRunId === p.runId && host.workflowAttempt === p.runAttempt && host.sourceRevision === intent.sourceRevision
    && Array.isArray(host.executionIds) && host.executionIds.includes(result.executionId) && host.automaticRetries === 0, "host/result provenance mismatch");
  let databaseLane: DatabaseFingerprintIdentity;
  if (intent.databaseLane?.lane === "embedded-postgres") {
    requireProof(host.databaseLane === "embedded-postgres" && host.postgres === undefined && host.dockerEngineSha256 === undefined, "host database lane mismatch");
    databaseLane = intent.databaseLane;
    requireProof(databaseIdentityMatches(databaseLane, result.databaseIdentity), "cell database identity mismatch");
  } else {
    requireProof(host.databaseLane === undefined || host.databaseLane === "owned-docker-postgres", "host database lane mismatch");
    requireProof(hex(host.dockerEngineSha256) && host.postgres?.image === POSTGRES_AMD64_IMAGE && POSTGRES_AMD64_IMAGE_IDS.includes(host.postgres?.imageId) && host.postgres.architecture === "amd64" && host.postgres.version === POSTGRES_VERSION, "foreign database artifact");
    databaseLane = { lane: "owned-docker-postgres", image: host.postgres.image, imageId: host.postgres.imageId, version: host.postgres.version, architecture: "amd64" };
    requireProof(!intent.databaseLane || databaseIdentityMatches(intent.databaseLane, result.databaseIdentity), "intent database lane mismatch");
    requireProof(databaseIdentityMatches(databaseLane, result.databaseIdentity) && result.databaseIdentity?.engineSha256 === host.dockerEngineSha256, "cell database identity mismatch");
  }
  requireProof(definition.scenarioId === selection.scenarioId && hex(definition.definitionDigest) && hex(definition.graderDigest)
    && definition.suiteDefinitionHash === result.suiteDefinitionHash && hex(result.suiteDefinitionHash), "definition/result mismatch");
  return { schema: "paperclip.chat-remote-cell-import/v1", intentCampaignId: intent.campaignId, importKey: `${p.runId}/${p.runAttempt}/${result.executionId}`,
    measurementKey: `${result.accountingIdentity!.campaignId}/${result.accountingIdentity!.attemptId}/${result.executionId}`,
    artifactSha256: p.archiveSha256, scenarioId: selection.scenarioId, ordinal: selection.remoteOrdinal, sourceRevision: intent.sourceRevision,
    resultPath: input.result.path, resultSha256: input.result.sha256, hostSha256: input.host.sha256, definitionSha256: input.definition.sha256,
    result, definitionDigest: definition.definitionDigest, graderDigest: definition.graderDigest, databaseLane,
    hostLifecycle: host.lifecycle, hostPolicy: normalFleet ? "aws-fleet-spot-or-on-demand" : "spot-only" };
}
/** A pre-attempt qualification refusal is an operation, never a case reservation.
 * Only these two source-qualified host-gate branches prove this zero-admission stage. */
export function validateRemoteHostRefusal(input: {
  intent: RemoteCellIntent; provenance: RemoteArtifactProvenance; host: RemoteArtifactDocument;
}) {
  const { intent, provenance: p } = input, host = document(input.host);
  requireProof(p.repository === "paperclipai/paperclip" && p.workflow === "runner-full-stack-e2e.yml" && p.workflowRef === "refs/heads/master"
    && /^\d+$/.test(p.runId) && p.runAttempt === 1 && /^\d+$/.test(p.artifactId) && hex(p.archiveSha256), "unverified qualification artifact");
  requireProof(/^[a-f0-9]{40}$/.test(intent.sourceRevision) && p.targetSourceRevision === intent.sourceRevision
    && host.sourceRevision === intent.sourceRevision && host.workflowRunId === p.runId && host.workflowAttempt === p.runAttempt
    && host.workflowRef === "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master", "qualification source/run mismatch");
  const knownRefusal = host.lifecycle === "on-demand" && host.reason === "on-demand-or-unknown-host-refused-before-evaluation"
    || host.lifecycle === "spot" && host.reason === "owned-linux-amd64-postgres-image-unqualified";
  requireProof(host.schema === "paperclip.chat-remote-host/v1" && host.status === "blocked" && host.scope === "before-evaluation"
    && host.evaluationAdmitted === false && host.automaticRetries === 0 && knownRefusal && !host.postgres && !host.dockerEngineSha256
    && host.region === "us-east-1" && host.architecture === "x86_64" && /^i-[a-f0-9]{8,17}$/.test(host.instanceId)
    && /^ami-[a-f0-9]{8,17}$/.test(host.imageId), "not a proven pre-evaluation host refusal");
  requireProof(Array.isArray(host.executionIds) && host.executionIds.length === intent.selected.length
    && new Set(host.executionIds).size === host.executionIds.length
    && intent.selected.every(row => host.executionIds.includes(row.executionId)), "qualification selection mismatch");
  return { schema: "paperclip.chat-remote-operation/v1", campaignId: intent.campaignId, runId: p.runId,
    sourceRevision: intent.sourceRevision, artifactId: p.artifactId, artifactSha256: p.archiveSha256,
    hostReceiptPath: input.host.path, hostReceiptSha256: input.host.sha256,
    outcome: "infrastructure-blocked-before-evaluation", reason: host.reason,
    evaluationAdmitted: false, canonicalQueries: 0, nativeRuns: 0, providerCalls: 0,
    caseMeasurements: 0, caseOrdinalsConsumed: 0, initialIntentConsumed: false,
    caseExecutionIds: host.executionIds as string[], actualHost: { lifecycle: host.lifecycle as "on-demand" | "spot", region: host.region, architecture: host.architecture },
    reporterConclusionIsIndependent: true } as const;
}
export function remoteCellUsage(result: RunnerE2EResult): CampaignAttempt["usage"] {
  const usage = result.billing?.llm;
  return { tokens: usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : null,
    costUsd: usage && ["reported", "partial"].includes(usage.costStatus) && Number.isFinite(usage.reportedCostUsd) ? usage.reportedCostUsd : null,
    coverage: usage?.costStatus ?? "unavailable" };
}
export interface RemoteImportRecord { importKey: string; measurementKey: string; resultSha256: string; artifactSha256: string; ordinal: 1 | 2; scenarioId: string; hostLifecycle: "spot" | "on-demand"; hostPolicy: ValidatedRemoteCell["hostPolicy"] }
export type RemoteCampaign = ChatCampaign & { remoteImports?: RemoteImportRecord[] };
/** Pure transaction: caller is the sole writer and atomically persists this returned
 * existing campaign ledger. A failed gate never partially reserves an ordinal.
 * Framework accounting campaign IDs are retained, not rewritten to the review intent ID. */
export function applyRemoteCell(campaign: RemoteCampaign, cell: ValidatedRemoteCell, qualification: {
  attempt: CampaignAttempt; completion: Parameters<typeof completeCampaignAttempt>[1];
}): { campaign: RemoteCampaign; duplicate: boolean } {
  requireProof(campaign.campaignId === cell.intentCampaignId, "cannot import into historical or foreign campaign");
  const records = campaign.remoteImports ?? [];
  const previous = records.find(row => row.importKey === cell.importKey || row.measurementKey === cell.measurementKey || row.scenarioId === cell.scenarioId && row.ordinal === cell.ordinal);
  if (previous) {
    requireProof(previous.importKey === cell.importKey && previous.measurementKey === cell.measurementKey && previous.resultSha256 === cell.resultSha256 && previous.artifactSha256 === cell.artifactSha256, "changed or duplicate ordinal measurement");
    return { campaign, duplicate: true };
  }
  const { attempt, completion } = qualification;
  requireProof(completion.usage.tokens === remoteCellUsage(cell.result).tokens && completion.usage.costUsd === remoteCellUsage(cell.result).costUsd && completion.usage.coverage === remoteCellUsage(cell.result).coverage, "usage differs from actual cell billing");
  requireProof(attempt.ordinal === cell.ordinal && attempt.executionId === cell.result.executionId && attempt.sourceRevision === cell.sourceRevision
    && attempt.startedAt === cell.result.startedAt && completion.finishedAt === cell.result.finishedAt
    && attempt.profile === cell.result.profileId && attempt.model === cell.result.model
    && attempt.definitionDigest === cell.definitionDigest && attempt.graderDigest === cell.graderDigest
    && attempt.suiteDefinitionDigest === cell.result.suiteDefinitionHash
    && JSON.stringify(attempt.databaseLane) === JSON.stringify(cell.databaseLane), "qualification does not describe measured cell");
  requireProof(completion.outcome === cell.result.status && completion.cleanup === cell.result.cleanup && completion.evidencePaths.includes(cell.resultPath), "measured outcome or cleanup rewritten");
  const next = structuredClone(campaign), scenario = next.scenarios.find(row => row.id === cell.scenarioId);
  requireProof(scenario, "scenario absent from frozen campaign");
  reserveCampaignAttempt(scenario, structuredClone(attempt));
  completeCampaignAttempt(scenario, structuredClone(completion));
  next.remoteImports = [...records, { importKey: cell.importKey, measurementKey: cell.measurementKey, resultSha256: cell.resultSha256, artifactSha256: cell.artifactSha256, ordinal: cell.ordinal, scenarioId: cell.scenarioId, hostLifecycle: cell.hostLifecycle, hostPolicy: cell.hostPolicy }];
  return { campaign: next, duplicate: false };
}
