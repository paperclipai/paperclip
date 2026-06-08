/**
 * Artifact-evidence gate (BLO-4461).
 *
 * Pure evaluator: given an issue + its recent comments + work_products + a
 * label→required-shapes registry, returns a verdict on whether the agent
 * has attached the evidence shapes the issue's labels demand.
 *
 * Phase 1 (BLO-4824): caller logs + records the verdict, never throws.
 * Phase 2 (BLO-4828): caller throws on `verdict === "block"`. The evaluator
 * is identical in both phases — only the call-site behavior changes.
 *
 * Symmetric with `evaluateTierCacheSnapshot` in `ccrotate-tier-gate.ts`:
 * pure function, no IO, no DB, no clock-side-effects beyond what the caller
 * passes in. Caller is responsible for fetching comments + work_products.
 */

import type {
  EvidenceRegistry,
  EvidenceShape,
} from "./evidence-shapes.js";
import { DEFAULT_UNLABELED_REQUIRED } from "./evidence-shapes.js";

export interface EvidenceIssueLite {
  description?: string | null;
  labels: Array<{ name: string }>;
}

export interface EvidenceCommentLite {
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | string;
}

export interface EvidenceWorkProductLite {
  kind: string;
  metadata?: Record<string, unknown> | null;
  result?: string | null;
}

export type EvidenceVerdict = "pass" | "warn" | "block";

export interface EvaluateEvidenceInput {
  issue: EvidenceIssueLite;
  comments: EvidenceCommentLite[];
  workProducts: EvidenceWorkProductLite[];
  registry: EvidenceRegistry;
  /** Number of most-recent agent comments to concatenate when scanning. Default 10. */
  recentCommentLimit?: number;
}

export interface EvaluateEvidenceResult {
  verdict: EvidenceVerdict;
  /** Shapes that were required but not detected. Empty on `pass`. */
  missing: EvidenceShape[];
  /** Shapes that were detected. */
  evidenceFound: EvidenceShape[];
  /** Per-shape detection booleans, useful for UI debugging + tests. */
  shapeDetections: Record<EvidenceShape, boolean>;
  /** True when the issue's labels did not match any registry entry. */
  unlabeledFallback: boolean;
}

const DEFAULT_RECENT_COMMENT_LIMIT = 10;

const ALL_SHAPES: readonly EvidenceShape[] = [
  "screenshot:1440x900",
  "screenshot:390x844",
  "checklist:done-when",
  "test-output",
  "kubectl-state",
  "probe-output",
  "url-probe",
  "pr-link",
  "ci-green",
  "e2e-script",
  "e2e-run",
  "migration-output",
] as const;

/**
 * Compute the required-shape set for an issue by unioning the registry
 * entries for each label name (case-insensitive). When no label matches,
 * falls back to `DEFAULT_UNLABELED_REQUIRED` and flags `unlabeledFallback`.
 */
export function resolveRequiredShapes(
  issue: EvidenceIssueLite,
  registry: EvidenceRegistry,
): { required: EvidenceShape[]; unlabeledFallback: boolean } {
  const lowerRegistry: EvidenceRegistry = {};
  for (const [key, entry] of Object.entries(registry)) {
    lowerRegistry[key.toLowerCase()] = entry;
  }

  const union = new Set<EvidenceShape>();
  let matchedAnyLabel = false;
  for (const label of issue.labels) {
    const entry = lowerRegistry[label.name.toLowerCase()];
    if (!entry) continue;
    matchedAnyLabel = true;
    for (const shape of entry.required) union.add(shape);
  }

  if (!matchedAnyLabel) {
    return { required: [...DEFAULT_UNLABELED_REQUIRED], unlabeledFallback: true };
  }
  return { required: Array.from(union), unlabeledFallback: false };
}

/**
 * Build the concatenated agent-comment body the detectors scan. Filters to
 * agent-authored comments only (operator-side comments do not "produce
 * evidence" — they're feedback). Caps at `recentCommentLimit` to bound the
 * scan window and to keep the detector regexes from quadratic-time
 * exploding on very long issues.
 */
function buildAgentEvidenceText(
  comments: EvidenceCommentLite[],
  recentCommentLimit: number,
): string {
  const agentComments = comments.filter((c) => c.authorAgentId !== null);
  agentComments.sort((a, b) => {
    // Defensive: `new Date(badString).getTime()` returns NaN, and a NaN
    // comparator return value silently produces an engine-dependent order in
    // V8's TimSort — which would let a single malformed timestamp push real
    // evidence outside the recent-comment window and false-block the gate.
    // Coerce NaN/Infinity to epoch 0 so bad timestamps sort to the bottom of
    // the window deterministically. Caller should validate inputs upstream;
    // this is the last-line defense.
    const aRaw = new Date(a.createdAt).getTime();
    const bRaw = new Date(b.createdAt).getTime();
    const aT = Number.isFinite(aRaw) ? aRaw : 0;
    const bT = Number.isFinite(bRaw) ? bRaw : 0;
    return bT - aT;
  });
  return agentComments
    .slice(0, recentCommentLimit)
    .map((c) => c.body)
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Per-shape detectors. Each returns true if the shape is "attached".
//
// Detection runs locally against the agent-comment text + work_products. No
// outbound HTTP, no parsing of remote content. The gate enforces the SHAPE
// of the receipt, not its truth — QA Engineer (BLO-4827) re-runs the
// receipt against the live artifact to catch fakery.
// ---------------------------------------------------------------------------

function detectScreenshotViewport(
  text: string,
  workProducts: EvidenceWorkProductLite[],
  viewport: string,
): boolean {
  const [w, h] = viewport.split("x");
  // 1. Work-product with explicit viewport metadata.
  for (const wp of workProducts) {
    if (wp.kind !== "screenshot") continue;
    const meta = wp.metadata;
    if (!meta) continue;
    const mv = (meta as { viewport?: unknown }).viewport;
    if (typeof mv === "string" && mv === viewport) return true;
  }
  // 2. Inline markdown image whose filename or alt mentions the viewport.
  const inlinePattern = new RegExp(
    `!\\[[^\\]]*\\]\\([^)]*${w}\\s*[x_-]?\\s*${h}[^)]*\\)`,
    "i",
  );
  if (inlinePattern.test(text)) return true;
  // 3. Filename/path reference near a screenshot / Playwright keyword.
  //    Matches "blog_listing_desktop_1440.png ... 1440x900" or similar.
  const looseFilename = new RegExp(
    `\\b(?:screenshot|playwright|png|jpg|jpeg)\\b[\\s\\S]{0,200}\\b${w}\\s*[x_-]?\\s*${h}\\b|\\b${w}\\s*[x_-]?\\s*${h}\\b[\\s\\S]{0,200}\\b(?:screenshot|playwright|png|jpg|jpeg)\\b`,
    "i",
  );
  return looseFilename.test(text);
}

function detectChecklistDoneWhen(
  text: string,
  issueDescription: string | null | undefined,
): boolean {
  if (!issueDescription) {
    // No description = no acceptance criteria to map against; treat as
    // satisfied (the checklist requirement is meaningless here).
    return true;
  }
  const doneWhenBullets = countDoneWhenBullets(issueDescription);
  if (doneWhenBullets === 0) return true;

  // A "checklist" is either:
  //  (a) A markdown table with N >= doneWhenBullets rows that include a
  //      status marker (✅/✓/✔/❌/✗/⏸ or [x]/[ ]/[X]) in any cell.
  //  (b) A task-list with N >= doneWhenBullets `- [ ]` / `- [x]` lines.

  const statusMarker = /✅|✓|✔|❌|✗|⏸|⏹|⚠️|\[\s\]|\[[xX]\]|\bpass\b|\bfail\b/;

  // (b) Task list count.
  const taskListMatches = text.match(/^[-*]\s+\[[ xX]\]/gm);
  if (taskListMatches && taskListMatches.length >= doneWhenBullets) return true;

  // (a) Markdown table — count rows that contain a status marker.
  let taggedRowCount = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.includes("|")) continue;
    if (/^\s*\|[-:|\s]+\|\s*$/.test(line)) continue; // header separator
    if (statusMarker.test(line)) taggedRowCount += 1;
  }
  return taggedRowCount >= doneWhenBullets;
}

function countDoneWhenBullets(description: string): number {
  const doneWhenIdx = description.search(/^##+\s*Done when\b/im);
  if (doneWhenIdx === -1) return 0;
  const rest = description.slice(doneWhenIdx);
  // Stop at next heading.
  const nextHeading = rest.slice(2).search(/^##+\s/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 2);
  const bullets = section.match(/^[-*]\s+/gm);
  return bullets ? bullets.length : 0;
}

function detectTestOutput(text: string): boolean {
  // vitest banner
  if (/Test Files\s+\d+\s+passed/i.test(text)) return true;
  // pytest banner
  if (/=+\s+\d+\s+passed\s+in\s+[\d.]+s\s+=+/i.test(text)) return true;
  if (/^\s*\d+\s+passed\s+in\s+[\d.]+s\s*$/im.test(text)) return true;
  // jest banner
  if (/Tests:\s+\d+\s+passed/i.test(text)) return true;
  // mocha / generic "N tests passing"
  if (/\b\d+\s+(?:tests?|specs?)\s+passing\b/i.test(text)) return true;
  return false;
}

function detectKubectlState(text: string): boolean {
  // Pod listing header.
  if (/^\s*NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE/m.test(text)) return true;
  // Service / generic listing header.
  if (/^\s*NAME\s+TYPE\s+CLUSTER-IP/m.test(text)) return true;
  // Rollout output.
  if (/\bdeployment\s+"[\w-]+"\s+successfully rolled out\b/i.test(text)) {
    return true;
  }
  return false;
}

function detectProbeOutput(text: string): boolean {
  // A curl/wget invocation paired with something that looks like a response
  // body or status line within a reasonable window. We don't try to be too
  // clever — the goal is to force the agent to paste *something* observable.
  const probeAndBody =
    /\b(?:curl|wget|http)\b[^\n]*\n[\s\S]{0,500}?(?:HTTP\/[\d.]+\s+\d{3}|^\{[\s\S]*?\}$|<\!?DOCTYPE|<html)/im;
  if (probeAndBody.test(text)) return true;
  // Healthz / status-endpoint output.
  if (/"(?:status|state|ok)"\s*:\s*(?:"ok"|"healthy"|true)/i.test(text)) {
    return true;
  }
  return false;
}

function detectUrlProbe(text: string): boolean {
  return /\bcurl\b[^\n]+https?:\/\/[^\s]+/i.test(text);
}

function detectPrLink(text: string): boolean {
  return /https?:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/i.test(text);
}

function detectCiGreen(text: string): boolean {
  if (/All checks have passed/i.test(text)) return true;
  if (/"mergeable_state"\s*:\s*"clean"/i.test(text)) return true;
  if (/\bCI\s+green\b/i.test(text)) return true;
  return false;
}

function detectE2eScript(
  text: string,
  workProducts: EvidenceWorkProductLite[],
): boolean {
  for (const wp of workProducts) {
    if (wp.kind === "e2e-script") return true;
  }
  // Inline detection: a fenced code block with Playwright/Cypress idioms.
  if (
    /\bawait\s+page\.(?:goto|click|fill|waitForSelector|waitForURL)\b/.test(text)
  ) {
    return true;
  }
  if (/\bcy\.(?:visit|get|click|contains)\b/.test(text)) return true;
  return false;
}

function detectMigrationOutput(text: string): boolean {
  const hasMigrationRunnerSignal =
    /Applied\s+\d+\s+migration/i.test(text) ||
    /No pending migrations/i.test(text) ||
    /\d+\s+migration(?:s)?\s+applied/i.test(text) ||
    /drizzle-kit[\s\S]{0,80}(?:push|migrate|generate)/i.test(text) ||
    /INFO\s+\[alembic\.runtime/i.test(text) ||
    /Flyway\s+(?:Community|Pro|Teams)\s+Edition/i.test(text) ||
    /Liquibase\s+Community/i.test(text);
  // EXPLAIN / EXPLAIN ANALYZE plan output.
  if (/\b(?:Seq|Index|Bitmap Heap|Hash|Merge|Nested Loop)\s+(?:Scan|Join)\b/i.test(text)) return true;
  if (/\bcost=[\d.]+\.\.[\d.]+\s+rows=\d+/i.test(text)) return true;
  // psql row-count line: "(N rows)" or "(1 row)". This must be paired
  // with runner output so an incidental SELECT result cannot satisfy the gate.
  if (hasMigrationRunnerSignal && /\(\d+\s+rows?\)/i.test(text)) return true;
  // Migration runner banners.
  if (hasMigrationRunnerSignal) return true;
  return false;
}

function detectE2eRun(
  workProducts: EvidenceWorkProductLite[],
  text: string,
): boolean {
  for (const wp of workProducts) {
    if (wp.kind === "e2e-run" && wp.result === "pass") return true;
  }
  // Inline: a "PASS" or "✓ all tests" line near an e2e-style runner banner.
  if (/Running\s+\d+\s+tests?\s+using\s+\d+\s+workers?/i.test(text)) {
    return /\bpassed\b/i.test(text);
  }
  return false;
}

/**
 * Run all detectors and return per-shape booleans plus the joined found set.
 */
function detectAll(input: {
  issueDescription: string | null | undefined;
  text: string;
  workProducts: EvidenceWorkProductLite[];
}): { detections: Record<EvidenceShape, boolean>; found: EvidenceShape[] } {
  const { issueDescription, text, workProducts } = input;
  const detections: Record<EvidenceShape, boolean> = {
    "screenshot:1440x900": detectScreenshotViewport(text, workProducts, "1440x900"),
    "screenshot:390x844": detectScreenshotViewport(text, workProducts, "390x844"),
    "checklist:done-when": detectChecklistDoneWhen(text, issueDescription),
    "test-output": detectTestOutput(text),
    "kubectl-state": detectKubectlState(text),
    "probe-output": detectProbeOutput(text),
    "url-probe": detectUrlProbe(text),
    "pr-link": detectPrLink(text),
    "ci-green": detectCiGreen(text),
    "e2e-script": detectE2eScript(text, workProducts),
    "e2e-run": detectE2eRun(workProducts, text),
    "migration-output": detectMigrationOutput(text),
  };
  const found = ALL_SHAPES.filter((s) => detections[s]);
  return { detections, found };
}

/**
 * Pure evaluator. See top-of-file for semantics.
 *
 * Verdict semantics:
 *   - `pass`  — every required shape was detected.
 *   - `warn`  — at least one required shape is missing, BUT the issue had
 *               no matching registry entry (unlabeled fallback). Caller
 *               typically records but doesn't block.
 *   - `block` — at least one required shape is missing AND the issue's
 *               labels matched a registry entry. Strong signal.
 */
export function evaluateEvidence(
  input: EvaluateEvidenceInput,
): EvaluateEvidenceResult {
  const limit = input.recentCommentLimit ?? DEFAULT_RECENT_COMMENT_LIMIT;
  const text = buildAgentEvidenceText(input.comments, limit);
  const { required, unlabeledFallback } = resolveRequiredShapes(
    input.issue,
    input.registry,
  );
  const { detections, found } = detectAll({
    issueDescription: input.issue.description,
    text,
    workProducts: input.workProducts,
  });

  const missing = required.filter((s) => !detections[s]);
  let verdict: EvidenceVerdict;
  if (missing.length === 0) {
    verdict = "pass";
  } else if (unlabeledFallback) {
    verdict = "warn";
  } else {
    verdict = "block";
  }

  return {
    verdict,
    missing,
    evidenceFound: found,
    shapeDetections: detections,
    unlabeledFallback,
  };
}
