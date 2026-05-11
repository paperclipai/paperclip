/**
 * Raw opportunity shape from the HigherGov API.
 * Fields match the actual API response structure (nested objects for agency, naics, etc.).
 */
export interface HigherGovOpportunity {
  opp_key: string;
  version_key: string;
  opp_cat: string;
  title: string;
  description_text: string;
  ai_summary: string;
  source_id: string;
  source_id_version: string;
  captured_date: string | null;
  posted_date: string | null;
  due_date: string | null;
  agency: {
    agency_key: number;
    agency_name: string;
    agency_abbreviation: string | null;
    agency_type: string;
    path: string;
  } | null;
  naics_code: {
    naics_code: string;
  } | null;
  psc_code: {
    psc_code: string;
  } | null;
  opp_type: {
    description: string;
  } | null;
  primary_contact_email: {
    contact_name: string;
    contact_email: string | null;
    contact_phone: string | null;
  } | null;
  set_aside: {
    description: string;
  } | null;
  val_est_low: string | null;
  val_est_high: string | null;
  pop_country: string | null;
  pop_state: string | null;
  pop_city: string | null;
  pop_zip: string | null;
  source_type: string;
  sole_source_flag: boolean;
  product_service: string | null;
  path: string;
  source_path: string | null;
  document_path: string | null;
  [key: string]: unknown;
}

/**
 * Cleaned, narrowed opportunity after extraction from raw API data.
 */
export interface NormalizedOpportunity {
  id: string;
  title: string;
  description: string;
  agency: string;
  state: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  estimatedValue: number | null;
  dueDate: string | null;
  postedDate: string | null;
  capturedDate: string | null;
  type: string | null;
  setAsideType: string | null;
  sourceUrl: string | null;
  placeOfPerformance: string | null;
}

/**
 * Service categories that map to ConsultAdd's core offerings.
 */
export type ServiceCategory =
  | "managed-it"
  | "cybersecurity"
  | "ai-data"
  | "cloud"
  | "erp"
  | "app-dev"
  | "it-staffing"
  | "mixed";

/**
 * Breakdown of the 0–100 qualification score.
 */
export interface ScoreBreakdown {
  /** 0–40: How well does this match ConsultAdd's service areas? */
  serviceAlignment: number;
  /** 0–20: Is this an open RFP where ConsultAdd can submit? */
  bidReadiness: number;
  /** 0–20: Do MBE/USPAACC certs give an edge? Set-asides? */
  competitivePosition: number;
  /** 0–20: Contract value in the $100K–$500K sweet spot? */
  valueFit: number;
}

/**
 * Structured fields extracted from RFP document text by the tier-2 scorer.
 * Populated only when scoring with the full PDF context; null/undefined
 * when the field couldn't be determined from the document.
 */
export interface ExtractedFields {
  /** Total contract value in USD if disclosed in the RFP. */
  estimatedValue: number | null;
  /** Annual contract value if multi-year, in USD. */
  annualValue: number | null;
  /** Contract base term in years (excluding option years). */
  contractTermYears: number | null;
  /** NAICS code if listed in the solicitation. */
  naicsCode: string | null;
  /** Set-aside type if specified (e.g., "MBE", "SDVOSB", "Small Business"). */
  setAsideType: string | null;
  /** Date of pre-bid / pre-proposal conference (ISO date) if scheduled. */
  prebidConferenceDate: string | null;
  /** Deadline for questions to the agency (ISO date) if specified. */
  questionsDueDate: string | null;
  /** Submission portal or method (e.g., "PASSPort", "Bonfire", "email", "mail"). */
  submissionPortal: string | null;
  /** Primary contact email from the RFP, if listed. */
  primaryContactEmail: string | null;
}

/**
 * Opportunity after LLM scoring.
 */
export interface ScoredOpportunity extends NormalizedOpportunity {
  score: number;
  scoreBreakdown: ScoreBreakdown;
  serviceCategory: ServiceCategory;
  reasoning: string;
  disqualifiers: string[];
  /** Populated only by tier-2 enrichment with full PDF text. */
  extracted?: ExtractedFields;
}

/**
 * Result of the hard filter stage: kept opportunities + dropped with reasons.
 */
export interface FilterResult {
  kept: NormalizedOpportunity[];
  dropped: Array<{
    opportunity: NormalizedOpportunity;
    reason: string;
  }>;
}

/**
 * Statistics from a pipeline run.
 */
export interface PipelineStats {
  totalFetched: number;
  afterDedup: number;
  afterHardFilter: number;
  scored: number;
  aboveThreshold: number;
  apiCallsUsed: number;
  claudeCallsUsed: number;
}

/**
 * Full result from a pipeline run.
 */
export interface PipelineResult {
  scored: ScoredOpportunity[];
  dropped: FilterResult["dropped"];
  stats: PipelineStats;
  runDate: string;
}

/**
 * Shape of a HubSpot deal to push.
 */
export interface HubSpotDeal {
  properties: {
    dealname: string;
    pipeline: string;
    dealstage: string;
    amount?: string;
    closedate?: string;
    source_platform: string;
    highergov_id: string;
    naics_code: string;
    psc_code: string;
    service_category: string;
    qualification_score: string;
    due_date: string;
    agency_name: string;
    opportunity_state: string;
    posting_url: string;
    certs_matched: string;
  };
}

/**
 * Persistent state for the CLI pipeline.
 */
export interface PipelineState {
  lastRunDate: string | null;
  lastCapturedDate: string | null;
  monthlyApiCallsUsed: number;
  monthlyApiCallsResetDate: string;
}

/**
 * Configuration overrides for the hard filter stage.
 */
export interface HardFilterConfig {
  nonBiddableTypes?: string[];
  naicsCodes?: string[];
  valueRange?: { min: number; max: number };
  dueDateRange?: { minDaysFromNow: number; maxDaysFromNow: number };
}

/**
 * Options for the LLM scorer.
 */
export interface ScorerOptions {
  apiKey: string;
  model?: string;
  concurrency?: number;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Search parameters for the HigherGov API.
 */
export interface HigherGovSearchParams {
  keywords?: string;
  naics?: string[];
  psc?: string[];
  minValue?: number;
  maxValue?: number;
  dueDateAfter?: string;
  dueDateBefore?: string;
  capturedAfter?: string;
  opportunityType?: string;
  sourceType?: string;
  pageSize?: number;
  page?: number;
}
