/**
 * Two-tier QA modelProfile routing (TSMC-20243 / TSMC-20345 / TSKB0404).
 *
 * Tier-1: eligible product QA classes mint/run on `modelProfile: "cheap"`.
 * Tier-2: escalate to `strong` on tier-1 fail, ambiguity, or hard floors
 * (visual-truth frame inspect, G-class money/publish/identity/delivery binding).
 *
 * Escape hatch (TSMC-20346): product classes listed in
 * `two-tier-qa-escape-force-strong.json` (or process override) skip tier-1 and
 * force strong until cleared after remeasure. Weekly metric:
 * company `scripts/qa_defect_escape_weekly.py` + work-products/TSMC-20243/escape-ledger/.
 *
 * Skill/rubric binding (TSMC-20358 / Child C): product QA runs stamp
 * `requiredSkills` / `requiredSkillKeys` for the existing free company skills
 * ship-it-qa-checklist, video-assembly-pipeline (assembly gate), and
 * never-again-gates. Heartbeat injects the same names into task markdown.
 * Text-only visual QA of frames remains a defect (VA1) — never weakened here.
 *
 * K25/K26 artifact-binding and identity stay deterministic outside this module
 * (issue-close-evidence / never-again gates) — do not model-judge them here.
 *
 * Classification mirrors baseline SQL heuristics in
 * work-products/TSMC-20243/baseline-queries.sql, narrowed so engineering cards
 * that merely mention "QA" are not forced onto the cheap lane.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TWO_TIER_QA_POLICY = "TSKB0404" as const;
export const TWO_TIER_QA_SOURCE = "two_tier_qa_routing" as const;

/** Existing company skill slugs — no new paid tools (TSMC-20358). */
export const TIER1_PRODUCT_QA_RUBRIC_SKILL_SLUGS = [
  "ship-it-qa-checklist",
  "video-assembly-pipeline",
  "never-again-gates",
] as const;

/** Canonical company skill keys (inventory / paperclipSkillSync.desiredSkills). */
export const TIER1_PRODUCT_QA_RUBRIC_SKILL_KEYS = [
  "paperclipai/paperclip/ship-it-qa-checklist",
  "paperclipai/paperclip/video-assembly-pipeline",
  "paperclipai/paperclip/never-again-gates",
] as const;

export type TwoTierQaRubricBinding = {
  requiredSkills: string[];
  requiredSkillKeys: string[];
  /** VA1: text-only visual QA of frames is always a defect. */
  visualTruthTextOnlyIsDefect: true;
  policy: typeof TWO_TIER_QA_POLICY;
  source: typeof TWO_TIER_QA_SOURCE;
};

export type ProductQaClass =
  | "deck_video_assembly_qa"
  | "pack_lint_review"
  | "close_evidence_checks"
  | "guard_card_triage"
  | "other_qa_review_verify";

export type TwoTierQaTier = 1 | 2;

export type TwoTierQaFloorReason =
  | "visual_truth"
  | "g_class_binding"
  | "explicit_strong"
  | "engineering_not_qa_pass"
  | "close_evidence_deterministic_only"
  | "strong_title_denylist"
  | "escape_hatch_force_strong";

export type TwoTierQaClassification = {
  qaClass: ProductQaClass | null;
  tier1Eligible: boolean;
  floorReason: TwoTierQaFloorReason | null;
  requestedModelProfile: "cheap" | "strong" | null;
  notes: string[];
};

export type TwoTierEscalateReason =
  | "tier1_fail"
  | "ambiguity"
  | "visual_truth"
  | "g_class_binding"
  | "manual"
  | "escape_hatch";

const PRODUCT_QA_CLASS_SET = new Set<string>([
  "deck_video_assembly_qa",
  "pack_lint_review",
  "close_evidence_checks",
  "guard_card_triage",
  "other_qa_review_verify",
]);

/**
 * Rubric skills every product-QA run must load (tier-1 cheap and tier-2 strong).
 * Brief Child C / TSMC-20358: no new paid tools; assembly gate = video-assembly-pipeline.
 */
export function buildTwoTierQaRubricBinding(): TwoTierQaRubricBinding {
  return {
    requiredSkills: [...TIER1_PRODUCT_QA_RUBRIC_SKILL_SLUGS],
    requiredSkillKeys: [...TIER1_PRODUCT_QA_RUBRIC_SKILL_KEYS],
    visualTruthTextOnlyIsDefect: true,
    policy: TWO_TIER_QA_POLICY,
    source: TWO_TIER_QA_SOURCE,
  };
}

/** Compact twoTierQa meta blob stamped on assigneeAdapterOverrides / run context. */
export function buildTwoTierQaMeta(input: {
  tier: TwoTierQaTier;
  qaClass: ProductQaClass | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const rubric = buildTwoTierQaRubricBinding();
  return {
    policy: TWO_TIER_QA_POLICY,
    source: TWO_TIER_QA_SOURCE,
    tier: input.tier,
    qaClass: input.qaClass,
    requiredSkills: rubric.requiredSkills,
    requiredSkillKeys: rubric.requiredSkillKeys,
    visualTruthTextOnlyIsDefect: rubric.visualTruthTextOnlyIsDefect,
    ...(input.extra ?? {}),
  };
}

/**
 * Prompt directive injected into paperclipTaskMarkdown when the run is product QA.
 * Instructs assignees to load existing free skills; does not weaken VA1 floors.
 */
export function buildTwoTierQaRubricPromptDirective(input?: {
  tier?: TwoTierQaTier | null;
  qaClass?: ProductQaClass | null;
  modelProfile?: "cheap" | "strong" | null;
}): string {
  const skills = TIER1_PRODUCT_QA_RUBRIC_SKILL_SLUGS.map((s) => `\`${s}\``).join(", ");
  const tierLabel =
    input?.tier === 2 || input?.modelProfile === "strong"
      ? "Tier-2 (strong)"
      : input?.tier === 1 || input?.modelProfile === "cheap"
        ? "Tier-1 (cheap)"
        : "Product QA";
  const classLine = input?.qaClass ? `\n- QA class: \`${input.qaClass}\`` : "";
  return [
    `${tierLabel} rubric binding (TSKB0404 / TSMC-20358):`,
    `- Load and follow these existing company skills before disposition (no new paid tools): ${skills}.`,
    "- Assembly gate skill key/slug: `video-assembly-pipeline` (tsm-assembly-gate equivalent).",
    "- VA1: text-only visual QA of frames remains a defect — do not mark visual/frame truth from prose alone; look-at-a-frame / visual-truth requires a capable lane and real frame evidence.",
    "- G-class / K25 / K26 binding floors unchanged; never-again-gates still apply.",
    classLine.trimEnd(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Append rubric directive once to task markdown (idempotent). */
export function appendTwoTierQaRubricDirectiveToTaskMarkdown(
  markdown: string | null | undefined,
  binding: {
    tier?: TwoTierQaTier | null;
    qaClass?: ProductQaClass | null;
    modelProfile?: "cheap" | "strong" | null;
  } | null,
): string | null {
  if (!markdown) return markdown ?? null;
  if (!binding) return markdown;
  if (markdown.includes("TSMC-20358") || markdown.includes("rubric binding (TSKB0404")) {
    return markdown;
  }
  return `${markdown}\n\n${buildTwoTierQaRubricPromptDirective(binding)}`;
}

/** Test/process override; null = load from JSON file beside this module. */
let escapeForceStrongOverride: ReadonlySet<ProductQaClass> | null = null;

function defaultEscapeForceStrongPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "two-tier-qa-escape-force-strong.json");
}

export function setEscapeHatchForceStrongClassesForTests(
  classes: Iterable<ProductQaClass> | null,
): void {
  escapeForceStrongOverride = classes == null ? null : new Set(classes);
}

export function loadEscapeHatchForceStrongClasses(
  jsonPath: string = process.env.TWO_TIER_QA_FORCE_STRONG_JSON ?? defaultEscapeForceStrongPath(),
): Set<ProductQaClass> {
  if (escapeForceStrongOverride) {
    return new Set(escapeForceStrongOverride);
  }
  try {
    if (!existsSync(jsonPath)) return new Set();
    const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      forceStrongProductQaClasses?: unknown;
    };
    const list = Array.isArray(raw.forceStrongProductQaClasses)
      ? raw.forceStrongProductQaClasses
      : [];
    const out = new Set<ProductQaClass>();
    for (const item of list) {
      if (typeof item === "string" && PRODUCT_QA_CLASS_SET.has(item)) {
        out.add(item as ProductQaClass);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

export function isEscapeHatchForceStrongClass(qaClass: ProductQaClass | null | undefined): boolean {
  if (!qaClass) return false;
  return loadEscapeHatchForceStrongClasses().has(qaClass);
}
const VISUAL_TRUTH_RE =
  /\b(visual[-\s]?truth|look[-\s]?at[-\s]?a[-\s]?frame|frame[-\s]?inspect|beat[-\s]?level proof|real[-\s]?motion visual|Ken Burns|visual QA)\b/i;

const G_CLASS_RE =
  /\b(G[-\s]?class|money|payment|billing[-\s]?truth|publish[-\s]?gate|identity[-\s]?bind|delivery[-\s]?bind|secret[-\s]?binding|credential)\b/i;

/** Engineering / platform work that mentions QA but is not a first-pass QA run. */
const ENGINEERING_NOT_QA_PASS_RE =
  /^\s*(\[?(PLATFORM|OPERATOR|BOARD|CTO)\]?|Implement|Build|Configure|Install|Enforce|Add |Rewrite|Make |Gate the|Manual live|CTO dispatch|OPERATOR ASK|BOARD ACTION)/i;

const STRONG_TITLE_DENYLIST_RE =
  /\b(architecture review|security review|auth review|crypto review|permission review|budget transfer|production incident)\b/i;

const DECK_VIDEO_ASSEMBLY_QA_RE =
  /\b(assembly gate|governed QA|all[-\s]?green QA|mandatory QA|QA runner|deck QA|re-?assemble master|assembly and all[-\s]?green)\b/i;

const PACK_LINT_REVIEW_RE =
  /\b(pack[.\s_-]?lint|packDraft QA|QA Pack|pending_qa|lint review)\b/i;

const CLOSE_EVIDENCE_RE = /\bclose[.\s_-]?evidence\b/i;

/** Residual narrative close-evidence review only — not platform guard implementation. */
const CLOSE_EVIDENCE_NARRATIVE_RE =
  /\b(residual narrative|narrative review|close[.\s_-]?evidence (check|review|verify|residual))\b/i;

const GUARD_CARD_TRIAGE_RE = /\b(guard[.\s_-]?card|routing[.\s_-]?guard)\b/i;

/**
 * Residual product QA / independent verify passes (baseline other_qa_review_verify),
 * kept tighter than the SQL catch-all so ordinary eng "review" cards stay default.
 */
const OTHER_PRODUCT_QA_RE =
  /\b(Cerberus independent QA|independent QA|qa[-\s]?signoff|qaReceipt|rejection QA|reviewer[-\s]?owned QA|ship[-\s]?it QA|product QA|Postiz (?:promote )?(?:independent )?QA|rendered QA|step[-\s]?10 QA)\b/i;

const ORIGIN_ALREADY_CHEAP = new Set([
  "routine_health",
  "issue_productivity_review",
  "harness_liveness_escalation",
  "stranded_issue_recovery",
  "stale_active_run_evaluation",
  "restart_lane_recovery",
]);

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readIssueModelProfileOverride(assigneeAdapterOverrides: unknown): "cheap" | "strong" | null {
  const profile = readObject(assigneeAdapterOverrides).modelProfile;
  return profile === "cheap" || profile === "strong" ? profile : null;
}

export function classifyProductQaClass(input: {
  title?: string | null;
  originKind?: string | null;
}): ProductQaClass | null {
  const title = input.title ?? "";
  const origin = input.originKind ?? "";

  if (origin === "issue_productivity_review" || origin === "routine_health") {
    return null;
  }
  if (
    origin === "harness_liveness_escalation" ||
    origin === "stranded_issue_recovery" ||
    origin === "stale_active_run_evaluation" ||
    origin === "restart_lane_recovery"
  ) {
    return null;
  }

  if (GUARD_CARD_TRIAGE_RE.test(title)) return "guard_card_triage";
  if (PACK_LINT_REVIEW_RE.test(title)) return "pack_lint_review";
  if (CLOSE_EVIDENCE_RE.test(title)) return "close_evidence_checks";
  if (DECK_VIDEO_ASSEMBLY_QA_RE.test(title) || VISUAL_TRUTH_RE.test(title)) {
    return "deck_video_assembly_qa";
  }
  if (OTHER_PRODUCT_QA_RE.test(title)) return "other_qa_review_verify";
  return null;
}

export function classifyTwoTierQa(input: {
  title?: string | null;
  description?: string | null;
  originKind?: string | null;
  assigneeAdapterOverrides?: unknown;
}): TwoTierQaClassification {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  const blob = `${title}\n${description}`;
  const notes: string[] = [];
  const explicit = readIssueModelProfileOverride(input.assigneeAdapterOverrides);

  if (explicit === "strong") {
    return {
      qaClass: classifyProductQaClass(input),
      tier1Eligible: false,
      floorReason: "explicit_strong",
      requestedModelProfile: "strong",
      notes: ["explicit assigneeAdapterOverrides.modelProfile=strong"],
    };
  }

  if (explicit === "cheap") {
    const qaClass = classifyProductQaClass(input);
    if (isEscapeHatchForceStrongClass(qaClass)) {
      return {
        qaClass,
        tier1Eligible: false,
        floorReason: "escape_hatch_force_strong",
        requestedModelProfile: "strong",
        notes: [
          "escape hatch overrides explicit cheap",
          `escape hatch force-strong for ${qaClass} (TSKB0404 / TSKB0055; clear after remeasure)`,
        ],
      };
    }
    return {
      qaClass,
      tier1Eligible: true,
      floorReason: null,
      requestedModelProfile: "cheap",
      notes: ["explicit assigneeAdapterOverrides.modelProfile=cheap"],
    };
  }

  if (input.originKind && ORIGIN_ALREADY_CHEAP.has(input.originKind)) {
    return {
      qaClass: null,
      tier1Eligible: false,
      floorReason: null,
      requestedModelProfile: null,
      notes: [`origin ${input.originKind} already handled by sibling cheap pin`],
    };
  }

  const qaClass = classifyProductQaClass(input);
  if (!qaClass) {
    return {
      qaClass: null,
      tier1Eligible: false,
      floorReason: null,
      requestedModelProfile: null,
      notes: ["not a product QA class"],
    };
  }

  // Escape hatch: weekly metric tripped this product class → force strong (TSKB0055 path).
  if (isEscapeHatchForceStrongClass(qaClass)) {
    return {
      qaClass,
      tier1Eligible: false,
      floorReason: "escape_hatch_force_strong",
      requestedModelProfile: "strong",
      notes: [
        `escape hatch force-strong for ${qaClass} (TSKB0404 / TSKB0055; clear after remeasure)`,
      ],
    };
  }

  if (ENGINEERING_NOT_QA_PASS_RE.test(title)) {
    return {
      qaClass,
      tier1Eligible: false,
      floorReason: "engineering_not_qa_pass",
      requestedModelProfile: null,
      notes: ["title looks like engineering/platform work, not a QA pass"],
    };
  }

  if (STRONG_TITLE_DENYLIST_RE.test(blob)) {
    return {
      qaClass,
      tier1Eligible: false,
      floorReason: "strong_title_denylist",
      requestedModelProfile: "strong",
      notes: ["strong title denylist matched"],
    };
  }

  if (VISUAL_TRUTH_RE.test(blob)) {
    return {
      qaClass,
      tier1Eligible: false,
      floorReason: "visual_truth",
      requestedModelProfile: "strong",
      notes: ["visual-truth / frame-inspect requires capable lane"],
    };
  }

  if (G_CLASS_RE.test(blob)) {
    return {
      qaClass,
      tier1Eligible: false,
      floorReason: "g_class_binding",
      requestedModelProfile: "strong",
      notes: ["G-class money/publish/identity/delivery binding stays strong"],
    };
  }

  if (qaClass === "close_evidence_checks") {
    // Prefer deterministic measureCloseEvidence; only residual narrative review is tier-1.
    if (!CLOSE_EVIDENCE_NARRATIVE_RE.test(blob)) {
      return {
        qaClass,
        tier1Eligible: false,
        floorReason: "close_evidence_deterministic_only",
        requestedModelProfile: null,
        notes: ["close_evidence without residual-narrative marker — leave default / deterministic"],
      };
    }
  }

  notes.push(`tier-1 cheap eligible for ${qaClass}`);
  return {
    qaClass,
    tier1Eligible: true,
    floorReason: null,
    requestedModelProfile: "cheap",
    notes,
  };
}

/**
 * Mint-time merge: if the issue is tier-1 eligible and the caller did not set a
 * modelProfile, stamp `assigneeAdapterOverrides.modelProfile = "cheap"`.
 * Never clobbers an explicit modelProfile or unrelated override keys.
 */
export function applyTwoTierQaMintOverrides(input: {
  title?: string | null;
  description?: string | null;
  originKind?: string | null;
  assigneeAdapterOverrides?: unknown;
}): {
  assigneeAdapterOverrides: Record<string, unknown> | null | undefined;
  classification: TwoTierQaClassification;
  applied: boolean;
} {
  const classification = classifyTwoTierQa(input);
  const existing = input.assigneeAdapterOverrides;
  const existingObj = existing == null ? null : readObject(existing);

  if (!classification.tier1Eligible || classification.requestedModelProfile !== "cheap") {
    return {
      assigneeAdapterOverrides: existing as Record<string, unknown> | null | undefined,
      classification,
      applied: false,
    };
  }

  if (existingObj && readIssueModelProfileOverride(existingObj)) {
    return {
      assigneeAdapterOverrides: existingObj,
      classification,
      applied: false,
    };
  }

  const next: Record<string, unknown> = {
    ...(existingObj ?? {}),
    modelProfile: "cheap",
    twoTierQa: buildTwoTierQaMeta({
      tier: 1,
      qaClass: classification.qaClass,
    }),
  };

  return {
    assigneeAdapterOverrides: next,
    classification,
    applied: true,
  };
}

/**
 * Effective issue model profile for run routing when the issue row may predate
 * mint-time stamping. Explicit overrides always win.
 */
export function resolveTwoTierQaIssueModelProfile(input: {
  title?: string | null;
  description?: string | null;
  originKind?: string | null;
  assigneeAdapterOverrides?: unknown;
}): {
  modelProfile: "cheap" | "strong" | null;
  classification: TwoTierQaClassification;
  source: "issue_override" | "two_tier_qa_routing" | "none";
} {
  const explicit = readIssueModelProfileOverride(input.assigneeAdapterOverrides);
  const classification = classifyTwoTierQa(input);

  // Escape hatch / floors that request strong beat a stale explicit cheap pin.
  if (
    classification.requestedModelProfile === "strong" &&
    classification.floorReason === "escape_hatch_force_strong"
  ) {
    return {
      modelProfile: "strong",
      classification,
      source: "two_tier_qa_routing",
    };
  }

  if (explicit) {
    return { modelProfile: explicit, classification, source: "issue_override" };
  }
  if (classification.requestedModelProfile) {
    return {
      modelProfile: classification.requestedModelProfile,
      classification,
      source: "two_tier_qa_routing",
    };
  }
  return { modelProfile: null, classification, source: "none" };
}

/**
 * Tier-2 escalate: force strong on the issue and record why. Caller persists
 * assigneeAdapterOverrides and re-wakes the assignee.
 */
export function buildTwoTierQaEscalateOverrides(input: {
  assigneeAdapterOverrides?: unknown;
  reason: TwoTierEscalateReason;
  detail?: string | null;
  qaClass?: ProductQaClass | null;
}): {
  assigneeAdapterOverrides: Record<string, unknown>;
  modelProfile: "strong";
  reason: TwoTierEscalateReason;
} {
  const existing = readObject(input.assigneeAdapterOverrides);
  const prevTwoTier = readObject(existing.twoTierQa);
  const qaClass =
    (typeof input.qaClass === "string" && PRODUCT_QA_CLASS_SET.has(input.qaClass)
      ? input.qaClass
      : null) ??
    (typeof prevTwoTier.qaClass === "string" && PRODUCT_QA_CLASS_SET.has(prevTwoTier.qaClass)
      ? (prevTwoTier.qaClass as ProductQaClass)
      : null);
  return {
    modelProfile: "strong",
    reason: input.reason,
    assigneeAdapterOverrides: {
      ...existing,
      modelProfile: "strong",
      twoTierQa: {
        ...prevTwoTier,
        ...buildTwoTierQaMeta({
          tier: 2,
          qaClass,
          extra: {
            escalatedAt: new Date().toISOString(),
            escalateReason: input.reason,
            escalateDetail: input.detail ?? null,
          },
        }),
      },
    },
  };
}

export function shouldEscalateTwoTierQaAfterFailedRun(input: {
  title?: string | null;
  description?: string | null;
  originKind?: string | null;
  assigneeAdapterOverrides?: unknown;
  runModelProfile?: string | null;
  runStatus: string;
}): {
  escalate: boolean;
  reason: TwoTierEscalateReason | null;
  classification: TwoTierQaClassification;
} {
  const classification = classifyTwoTierQa(input);
  const explicit = readIssueModelProfileOverride(input.assigneeAdapterOverrides);
  const failed =
    input.runStatus === "failed" ||
    input.runStatus === "timed_out" ||
    input.runStatus === "error";

  if (!failed) {
    return { escalate: false, reason: null, classification };
  }

  // Already strong — nothing to do.
  if (explicit === "strong") {
    return { escalate: false, reason: null, classification };
  }

  const ranCheap =
    input.runModelProfile === "cheap" ||
    explicit === "cheap" ||
    classification.requestedModelProfile === "cheap";

  if (!ranCheap) {
    return { escalate: false, reason: null, classification };
  }

  // Only escalate product-QA classes (or explicitly cheap two-tier stamps).
  const twoTierMeta = readObject(readObject(input.assigneeAdapterOverrides).twoTierQa);
  const isTwoTier =
    classification.qaClass != null ||
    twoTierMeta.source === TWO_TIER_QA_SOURCE ||
    twoTierMeta.policy === TWO_TIER_QA_POLICY;

  if (!isTwoTier) {
    return { escalate: false, reason: null, classification };
  }

  return { escalate: true, reason: "tier1_fail", classification };
}

export function buildTwoTierQaEscalateSystemComment(input: {
  reason: TwoTierEscalateReason;
  detail?: string | null;
  qaClass?: ProductQaClass | null;
  fromRunId?: string | null;
}): string {
  const rubric = buildTwoTierQaRubricBinding();
  const lines = [
    "## Two-tier QA escalate (auto, TSKB0404 / TSMC-20243)",
    "",
    `- Tier-2 modelProfile: \`strong\``,
    `- Reason: \`${input.reason}\``,
    ...(input.qaClass ? [`- QA class: \`${input.qaClass}\``] : []),
    ...(input.fromRunId ? [`- Failed tier-1 run: \`${input.fromRunId}\``] : []),
    ...(input.detail ? [`- Detail: ${input.detail}`] : []),
    `- Required rubric skills: ${rubric.requiredSkills.map((s) => `\`${s}\``).join(", ")}`,
    "",
    "Floors intact: visual-truth (text-only frame QA remains a defect / VA1), G-class, K25/K26 deterministic gates unchanged.",
  ];
  return lines.join("\n");
}
