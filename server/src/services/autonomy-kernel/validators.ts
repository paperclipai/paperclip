import type { AutonomyEvidenceType, AutonomyEvidenceVerdict, AutonomyJsonValue } from "@paperclipai/shared";
import { createEvidenceExtractorService } from "./evidence-extractors.js";
import type { ExtractedEvidenceInput } from "./evidence-extractors.js";
import type { AutonomyKernelContext } from "./types.js";

export type EvidenceValidationVerdict = Extract<AutonomyEvidenceVerdict, "accepted" | "rejected">;

export interface EvidenceValidationResult {
  verdict: EvidenceValidationVerdict;
  reason: string;
  validatorName: string;
  validatorVersion: string;
  validatorPayload?: Record<string, AutonomyJsonValue> | null;
}

export type ValidatorEvidenceCandidate = Pick<ExtractedEvidenceInput, "type" | "title" | "summary" | "uri" | "payload" | "sourceType" | "sourceId">;

export interface CommitVerificationInput {
  sha: string;
  candidate: ValidatorEvidenceCandidate;
}

export interface FileVerificationInput {
  path: string;
  evidenceType: AutonomyEvidenceType;
  candidate: ValidatorEvidenceCandidate;
}

export interface UrlVerificationInput {
  url: string;
  evidenceType: AutonomyEvidenceType;
  candidate: ValidatorEvidenceCandidate;
}

export interface ApprovalAuditInput {
  decisionId: string;
  decision: string | null;
  candidate: ValidatorEvidenceCandidate;
}

export interface EvidenceVerifierResult {
  exists?: boolean;
  ok?: boolean;
  status?: number | null;
  contentType?: string | null;
  decisionId?: string | null;
  reason?: string | null;
}

export interface EvidenceValidatorAdapters {
  verifyCommit?: (input: CommitVerificationInput) => Promise<EvidenceVerifierResult> | EvidenceVerifierResult;
  verifyFile?: (input: FileVerificationInput) => Promise<EvidenceVerifierResult> | EvidenceVerifierResult;
  verifyUrl?: (input: UrlVerificationInput) => Promise<EvidenceVerifierResult> | EvidenceVerifierResult;
  verifyApprovalDecision?: (input: ApprovalAuditInput) => Promise<EvidenceVerifierResult> | EvidenceVerifierResult;
}

export interface EvidenceValidatorRegistryOptions {
  adapters?: EvidenceValidatorAdapters;
}

export type EvidenceCandidateValidator = (candidate: ValidatorEvidenceCandidate) => Promise<EvidenceValidationResult>;

export interface EvidenceValidatorRegistry {
  validators: Partial<Record<AutonomyEvidenceType, EvidenceCandidateValidator>>;
  validateEvidenceCandidate(candidate: ValidatorEvidenceCandidate): Promise<EvidenceValidationResult>;
}

const VALIDATOR_VERSION = "autonomy-kernel.validators.v1";
const COMMIT_RE = /^[a-f0-9]{7,40}$/i;
const PASS_RE = /\b(pass(?:ed|es|ing)?|success(?:ful)?|succeeded|green|ok|0\s+failed|exit(?:ed)?\s+(?:code\s+)?0)\b/i;
const FAIL_RE = /\b(fail(?:ed|s|ing)?|error|errored|exception|timed?\s*out|exit(?:ed)?\s+(?:code\s+)?[1-9]\d*)\b/i;
const PLACEHOLDER_RE = /^(?:unknown|none|n\/a|tbd|todo|someone|owner|unassigned|\?|-)$/i;
const URL_RE = /^https?:\/\//i;
const IMAGE_CONTENT_TYPE_RE = /^image\//i;
const DOCUMENT_EXT_RE = /\.(?:md|mdx|pdf|txt|docx?|json|html?)(?:[?#].*)?$/i;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i;
const SENSITIVE_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|(?:[A-Za-z0-9_-]{20,}\.){2}[A-Za-z0-9_-]{20,})\b/;

function getString(payload: Record<string, AutonomyJsonValue> | null | undefined, ...keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function getNumber(payload: Record<string, AutonomyJsonValue> | null | undefined, ...keys: string[]): number | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function getBoolean(payload: Record<string, AutonomyJsonValue> | null | undefined, ...keys: string[]): boolean | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function result(verdict: EvidenceValidationVerdict, validatorName: string, reason: string, validatorPayload?: Record<string, AutonomyJsonValue>): EvidenceValidationResult {
  return { verdict, reason, validatorName, validatorVersion: VALIDATOR_VERSION, validatorPayload: validatorPayload ?? null };
}

function safeVerifierReason(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  return SENSITIVE_VALUE_RE.test(value) ? fallback : value;
}

function accepted(validatorName: string, reason: string, validatorPayload?: Record<string, AutonomyJsonValue>): EvidenceValidationResult {
  return result("accepted", validatorName, reason, validatorPayload);
}

function rejected(validatorName: string, reason: string, validatorPayload?: Record<string, AutonomyJsonValue>): EvidenceValidationResult {
  return result("rejected", validatorName, reason, validatorPayload);
}

function normalizeSha(candidate: ValidatorEvidenceCandidate): string | null {
  const payloadSha = getString(candidate.payload, "commitSha", "sha", "hash", "revision");
  const uriSha = candidate.uri?.startsWith("commit:") ? candidate.uri.slice("commit:".length) : null;
  const sha = (payloadSha ?? uriSha ?? "").trim().toLowerCase();
  return COMMIT_RE.test(sha) ? sha : null;
}

async function validateCommit(candidate: ValidatorEvidenceCandidate, adapters: EvidenceValidatorAdapters): Promise<EvidenceValidationResult> {
  const validatorName = "commit-evidence-validator";
  const sha = normalizeSha(candidate);
  if (!sha) return rejected(validatorName, "Rejected commit evidence: candidate does not contain a valid 7-40 character hex commit id.");
  if (!adapters.verifyCommit) return rejected(validatorName, "Rejected commit evidence: no repository verifier was supplied.", { shaLength: sha.length });

  const verification = await adapters.verifyCommit({ sha, candidate });
  if (verification.exists || verification.ok) return accepted(validatorName, "Accepted commit evidence: repository verifier confirmed the commit exists.", { shaLength: sha.length });
  return rejected(
    validatorName,
    safeVerifierReason(verification.reason, "Rejected commit evidence: repository verifier did not confirm the commit exists."),
    { shaLength: sha.length },
  );
}

function hasTrustedSuccess(payload: Record<string, AutonomyJsonValue> | null | undefined): boolean {
  const exitCode = getNumber(payload, "exitCode", "trustedExitCode", "statusCode");
  if (exitCode !== null) return exitCode === 0;
  const status = getString(payload, "status", "result", "outcome");
  if (status && /^(?:pass(?:ed)?|success(?:ful)?|succeeded|ok|green)$/i.test(status)) return true;
  const trustedResultText = getString(payload, "resultText", "trustedResultText", "stdout", "stderr", "logExcerpt", "output");
  return Boolean(trustedResultText && PASS_RE.test(trustedResultText) && !FAIL_RE.test(trustedResultText));
}

function hasOnlyClaimText(payload: Record<string, AutonomyJsonValue> | null | undefined): boolean {
  if (!payload) return true;
  const keys = Object.keys(payload).filter((key) => !["extractedFrom", "extractorVersion", "validationState", "command", "claimedResult", "matchedText"].includes(key));
  return keys.length === 0;
}

function validateCommandResult(candidate: ValidatorEvidenceCandidate): EvidenceValidationResult {
  const validatorName = `${candidate.type}-evidence-validator`;
  const command = getString(candidate.payload, "command");
  if (!command) return rejected(validatorName, `Rejected ${candidate.type} evidence: candidate does not include the command that was run.`);
  if (hasOnlyClaimText(candidate.payload)) {
    return rejected(validatorName, `Rejected ${candidate.type} evidence: command/result prose is claim-only and lacks trusted exit status or result output.`);
  }
  if (hasTrustedSuccess(candidate.payload)) return accepted(validatorName, `Accepted ${candidate.type} evidence: trusted result metadata indicates success.`);
  return rejected(validatorName, `Rejected ${candidate.type} evidence: trusted result metadata does not indicate success.`);
}

function candidatePath(candidate: ValidatorEvidenceCandidate): string | null {
  return candidate.uri ?? getString(candidate.payload, "path", "file", "artifactPath", "reference");
}

async function validateFileLike(candidate: ValidatorEvidenceCandidate, adapters: EvidenceValidatorAdapters): Promise<EvidenceValidationResult> {
  const validatorName = `${candidate.type}-evidence-validator`;
  const path = candidatePath(candidate);
  if (!path) return rejected(validatorName, `Rejected ${candidate.type} evidence: candidate does not include a file or artifact path.`);
  if (URL_RE.test(path)) return validateUrlLike(candidate, adapters);
  if (!adapters.verifyFile) return rejected(validatorName, `Rejected ${candidate.type} evidence: no file verifier was supplied.`);

  const verification = await adapters.verifyFile({ path, evidenceType: candidate.type, candidate });
  if (!(verification.exists || verification.ok)) {
    return rejected(validatorName, safeVerifierReason(verification.reason, `Rejected ${candidate.type} evidence: file verifier did not confirm existence.`));
  }
  if (candidate.type === "screenshot" && verification.contentType && !IMAGE_CONTENT_TYPE_RE.test(verification.contentType) && !IMAGE_EXT_RE.test(path)) {
    return rejected(validatorName, "Rejected screenshot evidence: verified artifact is not image-shaped.");
  }
  if (candidate.type === "document" && verification.contentType?.startsWith("image/") && !DOCUMENT_EXT_RE.test(path)) {
    return rejected(validatorName, "Rejected document evidence: verified artifact is not document-shaped.");
  }
  return accepted(validatorName, `Accepted ${candidate.type} evidence: verifier confirmed the artifact exists.`);
}

function candidateUrl(candidate: ValidatorEvidenceCandidate): string | null {
  const url = candidate.uri ?? getString(candidate.payload, "url", "href");
  return url && URL_RE.test(url) ? url : null;
}

async function validateUrlLike(candidate: ValidatorEvidenceCandidate, adapters: EvidenceValidatorAdapters): Promise<EvidenceValidationResult> {
  const validatorName = `${candidate.type}-evidence-validator`;
  const url = candidateUrl(candidate);
  if (!url) return rejected(validatorName, `Rejected ${candidate.type} evidence: candidate does not include an HTTP(S) URL.`);
  if (!adapters.verifyUrl) return rejected(validatorName, `Rejected ${candidate.type} evidence: no URL verifier or trusted status metadata was supplied.`);

  const verification = await adapters.verifyUrl({ url, evidenceType: candidate.type, candidate });
  const status = verification.status ?? null;
  const ok = verification.ok === true || (typeof status === "number" && status >= 200 && status < 400);
  if (!ok) {
    return rejected(
      validatorName,
      safeVerifierReason(verification.reason, `Rejected ${candidate.type} evidence: URL verifier did not confirm a successful status.`),
      status === null ? undefined : { status },
    );
  }
  if (candidate.type === "screenshot" && verification.contentType && !IMAGE_CONTENT_TYPE_RE.test(verification.contentType) && !IMAGE_EXT_RE.test(url)) {
    return rejected(validatorName, "Rejected screenshot evidence: URL verifier did not confirm image-shaped content.", { status });
  }
  return accepted(validatorName, `Accepted ${candidate.type} evidence: URL verifier confirmed a successful status.`, status === null ? undefined : { status });
}

async function validateApproval(candidate: ValidatorEvidenceCandidate, adapters: EvidenceValidatorAdapters): Promise<EvidenceValidationResult> {
  const validatorName = `${candidate.type}-evidence-validator`;
  const decisionId = getString(candidate.payload, "decisionId", "approvalDecisionId", "approvalId", "auditDecisionId");
  const decision = getString(candidate.payload, "decision", "status");
  if (!decisionId) return rejected(validatorName, `Rejected ${candidate.type} evidence: approval requires audited decision metadata with a decision id.`);
  if (decision !== "approved" && decision !== "rejected") return rejected(validatorName, `Rejected ${candidate.type} evidence: audited decision metadata must include approved or rejected decision.`);
  if (adapters.verifyApprovalDecision) {
    const verification = await adapters.verifyApprovalDecision({ decisionId, decision, candidate });
    if (!(verification.ok || verification.exists)) {
      return rejected(
        validatorName,
        safeVerifierReason(verification.reason, `Rejected ${candidate.type} evidence: approval audit verifier did not confirm the decision id.`),
      );
    }
  }
  return accepted(validatorName, `Accepted ${candidate.type} evidence: audited approval decision metadata is present.`, { decision });
}

function validateBlocker(candidate: ValidatorEvidenceCandidate): EvidenceValidationResult {
  const validatorName = "blocked_dependency-evidence-validator";
  const owner = getString(candidate.payload, "owner", "blockedBy", "assignee");
  const action = getString(candidate.payload, "unblockAction", "nextAction", "action");
  if (!owner || PLACEHOLDER_RE.test(owner)) return rejected(validatorName, "Rejected blocker evidence: blocker must include a concrete owner.");
  if (!action || action.length < 8 || PLACEHOLDER_RE.test(action)) return rejected(validatorName, "Rejected blocker evidence: blocker must include a concrete next action.");
  return accepted(validatorName, "Accepted blocker evidence: concrete owner and next action are present.");
}

function validateUnsupported(candidate: ValidatorEvidenceCandidate): EvidenceValidationResult {
  return rejected("unsupported-evidence-validator", `Rejected ${candidate.type} evidence: no validator is registered for this evidence type.`);
}

export function createEvidenceValidatorRegistry(options: EvidenceValidatorRegistryOptions = {}): EvidenceValidatorRegistry {
  const adapters = options.adapters ?? {};
  const validators: Partial<Record<AutonomyEvidenceType, EvidenceCandidateValidator>> = {
    commit: (candidate) => validateCommit(candidate, adapters),
    test_run: async (candidate) => validateCommandResult(candidate),
    build: async (candidate) => validateCommandResult(candidate),
    document: (candidate) => validateFileLike(candidate, adapters),
    published_asset: (candidate) => validateFileLike(candidate, adapters),
    work_product: (candidate) => validateFileLike(candidate, adapters),
    screenshot: (candidate) => validateFileLike(candidate, adapters),
    external_api_check: (candidate) => validateUrlLike(candidate, adapters),
    deployment: (candidate) => validateUrlLike(candidate, adapters),
    app_store_state: (candidate) => validateUrlLike(candidate, adapters),
    approval_request: (candidate) => validateApproval(candidate, adapters),
    approval_decision: (candidate) => validateApproval(candidate, adapters),
    blocked_dependency: async (candidate) => validateBlocker(candidate),
  };

  return {
    validators,
    async validateEvidenceCandidate(candidate: ValidatorEvidenceCandidate): Promise<EvidenceValidationResult> {
      const validator = validators[candidate.type] ?? (async () => validateUnsupported(candidate));
      return validator(candidate);
    },
  };
}

export function createValidatorService(_context: AutonomyKernelContext, options: EvidenceValidatorRegistryOptions = {}) {
  const registry = createEvidenceValidatorRegistry(options);
  return {
    evidenceExtractors: createEvidenceExtractorService(),
    ...registry,
  };
}

export * from "./evidence-extractors.js";
