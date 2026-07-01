// Read-only evidence overview for CPS research-paper reproduction artifacts.
//
// These types describe the shape returned by
// `GET /api/companies/:companyId/research-papers`. The surface is strictly
// read-only: it scans local CPS self-practice artifacts and never triggers any
// reproduction, backtest, broker, or compute action.
//
// Two independent verdict axes are preserved and must never be collapsed:
//   - paperReproductionVerdict: did we faithfully reproduce the *paper's own*
//     claimed numbers? A paper is only ever "refuted" when a faithful
//     reproduction was actually attempted against extracted primary-source
//     claim values.
//   - localValidationVerdict: how did a *local adaptation/proxy* fare? A local
//     kill is NOT evidence against the original paper.

/** Visual/semantic classification for a single badge. */
export type ResearchPaperTone =
  | "reproduced"
  | "refuted"
  | "data_blocked"
  | "claims_missing"
  | "claims_extracted"
  | "local_kill"
  | "not_comparable"
  | "local_pass"
  | "not_assessed"
  | "spike"
  | "neutral";

/** Which verdict axis a badge belongs to. */
export type ResearchPaperBadgeAxis = "paper" | "local" | "claims" | "status" | "meta";

export interface ResearchPaperBadge {
  label: string;
  tone: ResearchPaperTone;
  axis: ResearchPaperBadgeAxis;
  /** Optional longer explanation surfaced on hover / in detail. */
  detail?: string;
}

/** A single flattened, human-readable metric value. */
export interface ResearchPaperMetric {
  key: string;
  label: string;
  value: number | string | boolean | null;
  /** Optional grouping, e.g. a strategy name within a multi-strategy family. */
  group?: string;
}

/** One important, simplified chronological event for a paper. */
export interface ResearchPaperLogEntry {
  /** ISO timestamp when known (file mtime or report-stamped time), else null. */
  ts: string | null;
  label: string;
  detail?: string;
  /** Artifact file / source this event was derived from. */
  source?: string;
}

export type ResearchPaperArtifactKind =
  | "verdict"
  | "reproduction_report"
  | "local_validation"
  | "benchmarks"
  | "paper_claims"
  | "reproduction_plan"
  | "readme"
  | "loop_state"
  | "test_report"
  | "replay"
  | "data"
  | "other";

export interface ResearchPaperArtifactFile {
  name: string;
  path: string;
  kind: ResearchPaperArtifactKind;
  bytes: number | null;
  modifiedAt: string | null;
}

export interface ResearchPaperClaims {
  /** Cited primary-source references (paper family) when captured. */
  primarySources?: string[];
  /** Qualitative claims preserved from prior artifacts. */
  qualitativeClaims?: string[];
  /** Numeric claim values extracted from the primary source, if any. */
  numericClaimValues?: Record<string, unknown>;
  /** Whether numeric paper claims were extracted (vs. missing). */
  numericClaimsExtracted: boolean | null;
  notes?: string[];
}

export interface ResearchPaperMetricsBlock {
  /** Flattened headline metrics suitable for table/detail display. */
  summary: ResearchPaperMetric[];
  /** Best-available raw measured object, preserved verbatim. */
  raw: Record<string, unknown> | null;
}

/** Normalized record for a single research paper / paper family / spike. */
export interface ResearchPaperEvidence {
  id: string;
  slug: string;
  title: string;
  family: string | null;
  /** "paper_family" | "micro_addon" | "execution_spike". */
  category: string;
  /** The artifact group/run this paper belongs to (e.g. repro-repair-20260629). */
  group: string;
  paperId: string | null;
  authors: string[];
  sourceUrl: string | null;

  // --- verdict axes (raw, never collapsed) ---
  paperReproductionVerdict: string | null;
  localValidationVerdict: string | null;
  claimValueStatus: string | null;
  comparability: string | null;
  /** Only ever true when faithfulReproductionAttempted is also true. */
  paperRefuted: boolean | null;
  notAPaperRefutation: boolean | null;
  faithfulReproductionAttempted: boolean | null;
  promotionAllowed: boolean | null;

  /** Headline tone used for the primary accent and grouping. */
  headlineTone: ResearchPaperTone;
  badges: ResearchPaperBadge[];

  // --- detail ---
  claims: ResearchPaperClaims;
  measured: ResearchPaperMetricsBlock;
  benchmark: ResearchPaperMetricsBlock;
  failingGates: Record<string, string[]> | string[] | null;
  safetyFlags: Record<string, boolean> | null;
  blockers: string[];
  /** Excerpt of the experiment-design narrative (README / plan), trimmed. */
  experimentDesign: string | null;
  log: ResearchPaperLogEntry[];
  artifacts: ResearchPaperArtifactFile[];
  artifactDir: string;
}

export interface ResearchPaperRoot {
  path: string;
  label: string;
  present: boolean;
  /** Number of papers discovered under this root. */
  count: number;
}

export interface ResearchToolbeltStatus {
  name: string;
  path: string;
  generatedAt: string | null;
  ready: boolean;
  toolCount: number;
  importOk: number;
  failed: number;
  failedImports: string[];
  safeActions: {
    brokerActions: boolean;
    paidData: boolean;
    paidCompute: boolean;
    secretChanges?: boolean;
  };
  notes: string[];
}

export interface ResearchPaperOverview {
  companyId: string;
  generatedAt: string;
  roots: ResearchPaperRoot[];
  counts: {
    total: number;
    byCategory: Record<string, number>;
    byTone: Record<string, number>;
  };
  papers: ResearchPaperEvidence[];
  safety: {
    readOnly: true;
    brokerActions: false;
    paidComputeActions: false;
    note: string;
  };
  toolbelts: ResearchToolbeltStatus[];
}
