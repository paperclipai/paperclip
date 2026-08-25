import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ACTIVE_HEARTBEAT_RUN_STATUSES_BLOCKING_DONE,
  GENERATION_MEASUREMENT_CARD_TEMPLATES,
  issueCloseContractSchema,
  type GenerationMeasurementCardTemplate,
  type IssueCloseContract,
} from "@paperclipai/shared";
import { resolvePaperclipCompanyWorkProductsDir } from "@paperclipai/shared/home-paths";
import { unprocessable } from "../errors.js";

type IssueCloseEvidenceContract = Extract<IssueCloseContract, { evidenceTarget: number }>;
type IssueCloseExemptContract = Extract<IssueCloseContract, { mode: "exempt" }>;

const EXCLUDED_LOCAL_PATH_SEGMENTS = ["quarantine", "scratch", "cache"];

const GENERATION_MEASUREMENT_LABEL_HINTS = [
  "asset-generation",
  "benchmark-cell",
  "matrix-cell",
  "generation",
  "measurement",
] as const;

/** Title signals from K18/K19 failure cards and the three named templates. */
const GENERATION_MEASUREMENT_TITLE_RE =
  /(\[burn\]|\bburn[- ]tail\b|\basset[- ]generation\b|\bbenchmark[- ]cell\b|\bmatrix[- ]cells?\b|\bvision[- ]judge\b|\bgenerated media\b|\burl[- ]pool\b|\bmatrix incomplete\b)/i;

// Authors use these phrases to state that a task cannot be accepted from
// prose alone. Make them executable at creation time instead of relying on an
// agent to remember to add a close contract later. "attach evidence" /
// "close with evidence" joined "acceptance evidence" after TSC-7617
// (2026-08-25): a re-cut brief demanding "Attach evidence and close with a
// verdict" was closed done two minutes after creation with "No work
// performed" — the demand was prose, so nothing enforced it.
const EXPLICIT_ACCEPTANCE_EVIDENCE_RE =
  /\b(?:acceptance\s+evidence|attach(?:\s+(?:the|all|supporting))?\s+evidence|close\s+with\s+evidence)\b/i;

// TSMC-21711: the same demand, stated as a deliverable instead of as "evidence".
//
// EXPLICIT_ACCEPTANCE_EVIDENCE_RE only fires on the word "evidence", so a brief
// that says "produce a compliant demo video" armed nothing at all. DP-4627 was
// closed `done` five times with zero attachments because its contract was null
// and this gate therefore returned not_applicable — the guard never had an
// opinion about the card. Fleet-wide at the time: 54 of 56,836 issues carried a
// closeContract (0.10%), and 1,863 of the 1,884 issues closed in the preceding
// week were never gated at all.
//
// Kept deliberately high-precision: a false positive BLOCKS a close, so the
// verb forms require a determiner ("record a video", not "generate video ideas")
// and only the unambiguous noun phrases match on their own.
const ARTIFACT_DELIVERABLE_RE =
  /\b(?:demo\s+video|screen[- ]recording|screencast|walkthrough\s+video|attachment[-\s]?or[-\s]?fail)\b|\b(?:produce|record|deliver|render|export|attach)\s+(?:a|an|the|one)\s+(?:[\w-]+\s+){0,2}(?:as\s+(?:a|an)\s+)?(?:video|recording|screencast|mp4|pdf|deck|screenshot)\b/i;

/** Name the artifact class from the prose that demanded it (artifactKind is a quality floor, not a count unit). */
function artifactKindForDeliverable(text: string): string {
  if (/\b(?:demo\s+video|screen[- ]recording|screencast|walkthrough\s+video)\b/i.test(text)) {
    return "screen_recording_video";
  }
  if (/\b(?:video|mp4|recording)\b/i.test(text)) return "rendered_video";
  if (/\bpdf\b/i.test(text)) return "rendered_pdf";
  if (/\bdeck\b/i.test(text)) return "rendered_deck";
  if (/\bscreenshot\b/i.test(text)) return "captured_screenshot";
  return "delivered_artifact";
}

export type CloseEvidenceMeasurement = {
  closeContract: IssueCloseEvidenceContract;
  measuredCount: number;
  targetCount: number;
  portableCount: number;
  portableTargetCount: number | null;
  breakdown: {
    attachments: number;
    workProducts: number;
    localFiles: number;
  };
  localPath: string | null;
};

export type CloseContractEvaluation =
  | { outcome: "not_applicable" }
  | { outcome: "exempt"; contract: IssueCloseExemptContract }
  | { outcome: "satisfied"; measurement: CloseEvidenceMeasurement }
  | {
      outcome: "unmet";
      reason:
        | "close_contract_required"
        | "close_contract_invalid"
        | "close_evidence_unmet"
        | "close_portable_evidence_unmet";
      message: string;
      details: Record<string, unknown>;
    };

function normalizeRelativeEvidencePath(evidencePath: string) {
  return evidencePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(path.sep);
}

function resolveWorkProductsRoot(companyId: string) {
  const explicitRoot = process.env.PAPERCLIP_WORK_PRODUCTS_DIR?.trim();
  if (explicitRoot) return path.resolve(explicitRoot);
  try {
    return resolvePaperclipCompanyWorkProductsDir(companyId, {
      homeDir: process.env.PAPERCLIP_HOME?.trim(),
      instanceId: process.env.PAPERCLIP_INSTANCE_ID?.trim(),
    });
  } catch {
    return null;
  }
}

function isExcludedLocalSegment(segment: string) {
  const normalized = segment.trim().toLowerCase();
  return EXCLUDED_LOCAL_PATH_SEGMENTS.some((excluded) => normalized.includes(excluded));
}

async function countGovernedFiles(filePath: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(filePath, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (isExcludedLocalSegment(entry.name)) continue;
    const entryPath = path.join(filePath, entry.name);
    if (entry.isDirectory()) {
      count += await countGovernedFiles(entryPath);
      continue;
    }
    if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

export async function countCloseEvidenceLocalFiles(companyId: string, closeContract: IssueCloseEvidenceContract) {
  const root = resolveWorkProductsRoot(companyId);
  if (!root) {
    return { count: 0, localPath: null };
  }

  const relativePath = normalizeRelativeEvidencePath(closeContract.evidencePath);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return { count: 0, localPath: resolvedPath };
  }

  return {
    count: await countGovernedFiles(resolvedPath),
    localPath: resolvedPath,
  };
}

function issueLabelNames(issue: { labels?: Array<{ name?: string | null }> | null }) {
  return (issue.labels ?? [])
    .map((label) => (typeof label?.name === "string" ? label.name.trim().toLowerCase() : ""))
    .filter((label): label is string => label.length > 0);
}

export function isGenerationMeasurementCardTemplate(
  value: unknown,
): value is GenerationMeasurementCardTemplate {
  return (
    typeof value === "string" &&
    (GENERATION_MEASUREMENT_CARD_TEMPLATES as readonly string[]).includes(value)
  );
}

/**
 * Generation/measurement path (TSMC-18738 §5 reachability).
 * A guard that only fires when closeContract is opt-in is unreachable for this class.
 */
export function isGenerationMeasurementPath(issue: {
  title?: string | null;
  description?: string | null;
  labels?: Array<{ name?: string | null }> | null;
  closeContract?: unknown;
  cardTemplate?: string | null;
}): boolean {
  if (isGenerationMeasurementCardTemplate(issue.cardTemplate)) return true;

  const labels = issueLabelNames(issue);
  if (
    labels.some((name) =>
      GENERATION_MEASUREMENT_LABEL_HINTS.some((hint) => name === hint || name.includes(hint)),
    )
  ) {
    return true;
  }

  const rawContract = issue.closeContract;
  if (rawContract && typeof rawContract === "object" && !Array.isArray(rawContract)) {
    const template = (rawContract as { cardTemplate?: unknown }).cardTemplate;
    if (isGenerationMeasurementCardTemplate(template)) return true;
  }

  const title = issue.title ?? "";
  if (GENERATION_MEASUREMENT_TITLE_RE.test(title)) return true;

  return false;
}

export function defaultCloseContractForCardTemplate(
  template: GenerationMeasurementCardTemplate,
  evidencePath: string,
): IssueCloseEvidenceContract {
  const pathValue = evidencePath.trim() || template;
  switch (template) {
    case "asset-generation":
      return {
        mode: "evidence",
        evidenceTarget: 1,
        evidencePath: pathValue,
        artifactKind: "generated_media",
        cardTemplate: template,
      };
    case "benchmark-cell":
      return {
        mode: "evidence",
        evidenceTarget: 1,
        evidencePath: pathValue,
        artifactKind: "benchmark_result",
        cardTemplate: template,
      };
    case "matrix-cell":
      return {
        mode: "evidence",
        evidenceTarget: 1,
        evidencePath: pathValue,
        artifactKind: "matrix_cell_ledger",
        cardTemplate: template,
      };
  }
}

export function inferDefaultCloseContractForIssueCreate(input: {
  title?: string | null;
  description?: string | null;
  cardTemplate?: string | null;
  closeContract?: unknown;
  identifier: string;
}): IssueCloseContract | null {
  if (input.closeContract != null) return null;
  if (isGenerationMeasurementCardTemplate(input.cardTemplate)) {
    return defaultCloseContractForCardTemplate(input.cardTemplate, input.identifier);
  }
  if (
    isGenerationMeasurementPath({
      title: input.title,
      cardTemplate: input.cardTemplate,
      closeContract: null,
    })
  ) {
    return {
      mode: "evidence",
      evidenceTarget: 1,
      // TSMC-21711: without a portable target, loose files under the workspace
      // work-products dir satisfy the contract on their own. DP-4627 measured
      // localFiles:3 — three markdown self-reports — which would have cleared a
      // bare evidenceTarget:1 while the actual deliverable did not exist.
      portableEvidenceTarget: 1,
      evidencePath: input.identifier,
      artifactKind: "generated_media",
    };
  }
  if (EXPLICIT_ACCEPTANCE_EVIDENCE_RE.test(`${input.title ?? ""}\n${input.description ?? ""}`)) {
    return {
      mode: "evidence",
      evidenceTarget: 1,
      portableEvidenceTarget: 1,
      evidencePath: input.identifier,
      artifactKind: "acceptance_evidence",
    };
  }
  const deliverableText = `${input.title ?? ""}\n${input.description ?? ""}`;
  if (ARTIFACT_DELIVERABLE_RE.test(deliverableText)) {
    return {
      mode: "evidence",
      evidenceTarget: 1,
      portableEvidenceTarget: 1,
      evidencePath: input.identifier,
      artifactKind: artifactKindForDeliverable(deliverableText),
    };
  }
  return null;
}

export function isActiveHeartbeatRunStatusBlockingDone(status: string | null | undefined): boolean {
  if (!status) return false;
  return (ACTIVE_HEARTBEAT_RUN_STATUSES_BLOCKING_DONE as readonly string[]).includes(status);
}

export type CloseGateRunCandidate = {
  id: string;
  status: string;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

function closeGateRunAnchorMs(run: CloseGateRunCandidate): number {
  const started = run.startedAt ? new Date(run.startedAt).getTime() : NaN;
  if (Number.isFinite(started)) return started;
  const created = run.createdAt ? new Date(run.createdAt).getTime() : NaN;
  return Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY;
}

/**
 * §3 AC freshness run selection (TSMC-19840).
 * Prefer the fresher of issue-scoped latest vs the actor close-out run.
 * Self-exclusion is intentionally NOT applied here (only §2 active-run block excludes self).
 */
export function selectFreshestCloseGateRun(input: {
  latestScoped: CloseGateRunCandidate | null | undefined;
  actorRun: CloseGateRunCandidate | null | undefined;
}): CloseGateRunCandidate | null {
  const latest = input.latestScoped ?? null;
  const actor = input.actorRun ?? null;
  if (latest && actor) {
    if (latest.id === actor.id) return actor;
    return closeGateRunAnchorMs(actor) >= closeGateRunAnchorMs(latest) ? actor : latest;
  }
  return actor ?? latest ?? null;
}

/**
 * Board/user comment signal for acceptance-criteria mutation (TSMC-19840).
 *
 * Bare "Acceptance:" operator shorthand (e.g. provider delivery receipts) is NOT
 * an AC edit. Require stronger edit signals so close-guard §3 does not false-trip
 * on common board prose after a prior pack-delivery run.
 */
export function commentSignalsAcceptanceCriteriaChange(body: string | null | undefined): boolean {
  const text = (body ?? "").toLowerCase();
  if (!text.includes("acceptance")) return false;

  // Explicit AC section / field references.
  if (/\bacceptance[\s_-]+criteria\b/.test(text)) return true;
  if (/\bacceptancecriteria\b/.test(text)) return true;
  if (/^#{1,6}\s*acceptance(\s+criteria)?\b/m.test(text)) return true;

  // Edit language near "acceptance" (either order, short window).
  if (
    /\b(update|updated|updating|change|changed|changing|revise|revised|revising|modify|modified|modifying|edit|edited|editing|rewrite|rewrote|rewritten|replace|replaced|replacing)\b[\s\S]{0,80}\bacceptance\b/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\bacceptance\b[\s\S]{0,80}\b(update|updated|updating|change|changed|changing|revise|revised|revising|modify|modified|modifying|edit|edited|editing|rewrite|rewrote|rewritten|replace|replaced|replacing|criteria)\b/.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

export function acceptanceCriteriaChangedAfterRunStart(input: {
  runStartedAt: Date | string | null | undefined;
  acceptanceCriteriaDocumentUpdatedAt?: Date | string | null;
  comments?: Array<{
    createdAt?: Date | string | null;
    authorType?: string | null;
    body?: string | null;
  }>;
}): { changed: boolean; source: "document" | "comment" | null; changedAt: string | null } {
  if (!input.runStartedAt) {
    return { changed: false, source: null, changedAt: null };
  }
  const runStartedMs = new Date(input.runStartedAt).getTime();
  if (!Number.isFinite(runStartedMs)) {
    return { changed: false, source: null, changedAt: null };
  }

  if (input.acceptanceCriteriaDocumentUpdatedAt) {
    const docMs = new Date(input.acceptanceCriteriaDocumentUpdatedAt).getTime();
    if (Number.isFinite(docMs) && docMs > runStartedMs) {
      return {
        changed: true,
        source: "document",
        changedAt: new Date(docMs).toISOString(),
      };
    }
  }

  for (const comment of input.comments ?? []) {
    const authorType = (comment.authorType ?? "").toLowerCase();
    if (authorType !== "user" && authorType !== "board") continue;
    if (!commentSignalsAcceptanceCriteriaChange(comment.body)) continue;
    if (!comment.createdAt) continue;
    const commentMs = new Date(comment.createdAt).getTime();
    if (Number.isFinite(commentMs) && commentMs > runStartedMs) {
      return {
        changed: true,
        source: "comment",
        changedAt: new Date(commentMs).toISOString(),
      };
    }
  }

  return { changed: false, source: null, changedAt: null };
}

export async function measureCloseEvidence(input: {
  companyId: string;
  attachmentsCount: number;
  workProductsCount: number;
  closeContract: unknown;
}): Promise<CloseEvidenceMeasurement | null> {
  const parsed = issueCloseContractSchema.safeParse(input.closeContract);
  if (!parsed.success) return null;
  if (parsed.data.mode === "exempt") return null;

  const evidenceContract = parsed.data;
  const { count: localFiles, localPath } = await countCloseEvidenceLocalFiles(input.companyId, evidenceContract);
  const measuredCount = input.attachmentsCount + input.workProductsCount + localFiles;
  const portableCount = input.attachmentsCount + input.workProductsCount;

  return {
    closeContract: evidenceContract,
    measuredCount,
    targetCount: evidenceContract.evidenceTarget,
    portableCount,
    portableTargetCount: evidenceContract.portableEvidenceTarget ?? null,
    breakdown: {
      attachments: input.attachmentsCount,
      workProducts: input.workProductsCount,
      localFiles,
    },
    localPath,
  } satisfies CloseEvidenceMeasurement;
}

/**
 * Full close-contract evaluation for a done transition (TSMC-18738).
 * Generation/measurement path with null contract cannot reach done (reachability).
 */
export async function evaluateCloseContractForDone(input: {
  companyId: string;
  issue: {
    title?: string | null;
    labels?: Array<{ name?: string | null }> | null;
    closeContract?: unknown;
    cardTemplate?: string | null;
  };
  attachmentsCount: number;
  workProductsCount: number;
}): Promise<CloseContractEvaluation> {
  const onGenerationPath = isGenerationMeasurementPath(input.issue);
  const raw = input.issue.closeContract ?? null;

  if (raw == null) {
    if (!onGenerationPath) return { outcome: "not_applicable" };
    return {
      outcome: "unmet",
      reason: "close_contract_required",
      message:
        "Generation/measurement cards cannot enter done without a closeContract (opt-in guard is unreachable — TSMC-18738 §5).",
      details: {
        code: "invalid_issue_disposition",
        reason: "close_contract_required",
        generationMeasurementPath: true,
      },
    };
  }

  const parsed = issueCloseContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "unmet",
      reason: "close_contract_invalid",
      message:
        "closeContract is present but invalid — evidence contracts require evidenceTarget, evidencePath, and a concrete artifactKind quality floor.",
      details: {
        code: "invalid_issue_disposition",
        reason: "close_contract_invalid",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }

  if (parsed.data.mode === "exempt") {
    return { outcome: "exempt", contract: parsed.data };
  }

  const measurement = await measureCloseEvidence({
    companyId: input.companyId,
    attachmentsCount: input.attachmentsCount,
    workProductsCount: input.workProductsCount,
    closeContract: parsed.data,
  });
  if (!measurement) {
    return {
      outcome: "unmet",
      reason: "close_contract_invalid",
      message: "closeContract could not be measured.",
      details: {
        code: "invalid_issue_disposition",
        reason: "close_contract_invalid",
      },
    };
  }

  if (measurement.measuredCount < measurement.targetCount) {
    return {
      outcome: "unmet",
      reason: "close_evidence_unmet",
      message: `Issue cannot close until close evidence reaches ${measurement.targetCount}; measured ${measurement.measuredCount}.`,
      details: {
        code: "invalid_issue_disposition",
        reason: "close_evidence_unmet",
        measuredCount: measurement.measuredCount,
        targetCount: measurement.targetCount,
        evidencePath: measurement.closeContract.evidencePath,
        artifactKind: measurement.closeContract.artifactKind,
        localPath: measurement.localPath,
        breakdown: measurement.breakdown,
      },
    };
  }

  if (
    measurement.portableTargetCount !== null
    && measurement.portableCount < measurement.portableTargetCount
  ) {
    return {
      outcome: "unmet",
      reason: "close_portable_evidence_unmet",
      message:
        `Issue cannot close until board-visible evidence reaches ${measurement.portableTargetCount}; `
        + `measured ${measurement.portableCount} attachments/work products.`,
      details: {
        code: "invalid_issue_disposition",
        reason: "close_portable_evidence_unmet",
        portableMeasuredCount: measurement.portableCount,
        portableTargetCount: measurement.portableTargetCount,
        measuredCount: measurement.measuredCount,
        targetCount: measurement.targetCount,
        evidencePath: measurement.closeContract.evidencePath,
        artifactKind: measurement.closeContract.artifactKind,
        breakdown: measurement.breakdown,
      },
    };
  }

  return { outcome: "satisfied", measurement };
}


// ---------------------------------------------------------------------------
// TSMC-21479: the close-evidence gate, extracted from routes/issues.ts.
//
// This gate lived ONLY on the HTTP route, so `PATCH /issues/:id {status:"done"}`
// was checked and the heartbeat disposition path — where an agent states
// `PAPERCLIP_DISPOSITION: done` — was not. That is the hole every hollow close
// travelled through: `issue.disposition_applied` -> `issuesSvc.update` with no
// evidence check at all. Five fabricated or hollow closes were recorded in the
// 24h to 2026-08-25 (TSMC-21479, TSMC-21480, TSMC-21391, TSMC-21280, DP-4759).
//
// It is intentionally pure — every service it needs is injected — so both the
// route and the heartbeat can call the SAME implementation. Two answers to
// "may this close?" would drift silently, which is the failure this card exists
// to end.
// ---------------------------------------------------------------------------
export async function assertIssueCloseEvidenceSatisfied(input: {
  issue: {
    id: string;
    companyId: string;
    title?: string | null;
    labels?: Array<{ name?: string | null }> | null;
    closeContract?: unknown;
    executionRunId?: string | null;
  };
  nextStatus: string;
  svc: {
    listAttachments: (issueId: string) => Promise<unknown[]>;
    listComments?: (
      issueId: string,
      opts?: { order?: "asc" | "desc"; limit?: number | null },
    ) => Promise<Array<{ createdAt?: Date | string | null; authorType?: string | null; body?: string | null }>>;
  };
  workProductsSvc: { listForIssue: (issueId: string) => Promise<unknown[]> };
  documentsSvc: {
    listIssueDocuments: (
      issueId: string,
      options?: { includeSystem?: boolean },
    ) => Promise<Array<{ key: string; updatedAt?: Date | string | null }>>;
  };
  /**
   * Latest/active execution run context for this issue.
   * Prefer an active OTHER run when present; otherwise the most recent run by startedAt
   * (including the actor close-out run) for AC freshness — TSMC-19840.
   * Self-exclusion applies only to the §2 active-run block.
   */
  issueRun?: {
    id: string;
    status: string;
    startedAt?: Date | string | null;
    createdAt?: Date | string | null;
  } | null;
  /** When set, an active run with this id is treated as the caller's own and does not block done. */
  actorRunId?: string | null;
}) {
  if (input.nextStatus !== "done") return;

  const issueRun = input.issueRun ?? null;
  const actorRunId = input.actorRunId?.trim() || null;

  // TSMC-18738 §2 — reject done while another execution run on this issue is still active.
  // Do not self-block the agent run that is performing the close.
  if (
    issueRun
    && isActiveHeartbeatRunStatusBlockingDone(issueRun.status)
    && (!actorRunId || issueRun.id !== actorRunId)
  ) {
    throw unprocessable(
      `Issue cannot enter done while execution run ${issueRun.id} is still ${issueRun.status}.`,
      {
        code: "invalid_issue_disposition",
        reason: "active_run_in_progress",
        runId: issueRun.id,
        runStatus: issueRun.status,
      },
    );
  }

  // TSMC-18738 §3 — reject done when acceptance criteria changed after the last run started.
  // Anchor to the resolved run (latest including actor close-out when that is the freshest).
  const runStartedAt = issueRun?.startedAt ?? issueRun?.createdAt ?? null;
  if (issueRun && runStartedAt) {
    const documents = await input.documentsSvc.listIssueDocuments(input.issue.id, { includeSystem: true });
    const acceptanceDoc = documents.find((doc) => doc.key === "acceptance-criteria") ?? null;
    const comments = typeof input.svc.listComments === "function"
      ? await input.svc.listComments(input.issue.id, { order: "desc", limit: 40 })
      : [];
    const acChange = acceptanceCriteriaChangedAfterRunStart({
      runStartedAt,
      acceptanceCriteriaDocumentUpdatedAt: acceptanceDoc?.updatedAt ?? null,
      comments: comments.map((comment) => ({
        createdAt: comment.createdAt,
        authorType: comment.authorType,
        body: comment.body,
      })),
    });
    if (acChange.changed) {
      throw unprocessable(
        "Issue cannot enter done because acceptance criteria changed after the last execution run started; re-run before closing.",
        {
          code: "invalid_issue_disposition",
          reason: "acceptance_criteria_stale_vs_run",
          runId: issueRun.id,
          runStartedAt: new Date(runStartedAt).toISOString(),
          changedSource: acChange.source,
          changedAt: acChange.changedAt,
        },
      );
    }
  }

  const [attachments, workProducts] = await Promise.all([
    input.svc.listAttachments(input.issue.id),
    input.workProductsSvc.listForIssue(input.issue.id),
  ]);
  const evaluation = await evaluateCloseContractForDone({
    companyId: input.issue.companyId,
    issue: input.issue,
    attachmentsCount: attachments.length,
    workProductsCount: workProducts.length,
  });

  if (evaluation.outcome === "unmet") {
    throw unprocessable(evaluation.message, evaluation.details);
  }
}