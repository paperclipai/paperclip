/**
 * Round-5 unified opportunity classifier.
 *
 * Every opportunity gets one primary "type" used for routing:
 *   - rfp        → the Qualified sheet (the default; a biddable state/local RFP)
 *   - rfi        → "Other Opportunity Types" sheet (team does not work RFIs)
 *   - job-posting→ "Other Opportunity Types" sheet (single-role hire / pure staffing)
 *   - federal    → "Other Opportunity Types" sheet (out of state & local focus)
 *   - addendum   → "Addenda & Updates" sheet (round-4 behaviour)
 *   - qanda      → dropped entirely (round-4 behaviour; not biddable)
 *
 * `ongoing` is an orthogonal flag (a no-deadline RFP is still an `rfp`, just
 * labeled ongoing). Precedence for the primary type when several match:
 *   qanda > addendum > federal > job-posting > rfi > rfp
 * (qanda/addendum first because a re-posted federal RFI is still an update;
 * federal next because it's a hard out-of-scope signal.)
 */
import { isAddendumOrRepost, isQandA } from "./addendum.js";
import type { NormalizedOpportunity } from "./types.js";

export type OppType =
  | "rfp"
  | "rfi"
  | "job-posting"
  | "federal"
  | "addendum"
  | "qanda";

export interface Classification {
  type: OppType;
  ongoing: boolean;
}

// ─── Federal (US-7) ──────────────────────────────────────────────────
// Known federal agencies + "U.S./United States" prefixes. State/local agencies
// named "Department of X" with a US state do NOT match.
const FEDERAL_AGENCY_PATTERNS: RegExp[] = [
  /\bu\.?\s?s\.?\s+(department|dept|agency|office|bureau|administration|government|federal)\b/i,
  /\bunited\s+states\b/i,
  /\bfederal\s+(government|agency|bureau)\b/i,
  /\bnasa\b/i,
  /\bnational\s+aeronautics\b/i,
  /\bdepartment\s+of\s+defense\b/i,
  /\bdept\.?\s+of\s+defense\b/i,
  /\b(u\.?s\.?\s+)?(army|navy|air\s+force|marine\s+corps|space\s+force|coast\s+guard)\b/i,
  /\bdefense\s+(logistics|information|advanced)\b/i,
  /\bgeneral\s+services\s+administration\b/i,
  /\bgsa\b/i,
  /\bveterans\s+affairs\b/i,
  /\b(department|dept)\s+of\s+(homeland\s+security|energy|the\s+treasury|state|justice|labor|the\s+interior|agriculture|commerce)\b/i,
  /\bnational\s+institutes?\s+of\s+health\b/i,
  /\b(internal\s+revenue\s+service|social\s+security\s+administration)\b/i,
  /\bfederal\s+(aviation|bureau|communications|emergency|reserve|trade)\b/i,
  /\b(centers?\s+for\s+disease\s+control|environmental\s+protection\s+agency)\b/i,
];

// Guard against vendor/company names that contain "US" but aren't federal.
const FEDERAL_FALSE_POSITIVE = /\b(us\s+bank|us\s+cellular|us\s+foods|us\s+steel|us\s+postal\s+service\s+contractor)\b/i;

export function isFederal(opp: { agency: string; title?: string }): boolean {
  const text = `${opp.agency} ${opp.title ?? ""}`;
  if (FEDERAL_FALSE_POSITIVE.test(text)) return false;
  return FEDERAL_AGENCY_PATTERNS.some((re) => re.test(` ${opp.agency} `));
}

// ─── Job posting / pure staffing (US-8) ──────────────────────────────
// Single salaried role, or staffing-only with no project/deliverable.
// Optional "RFP -" prefix, then up to 2 qualifier words (e.g. "IT", "Senior"),
// then a role noun followed by "of/for/-". Catches "Director of …",
// "RFP - IT Coordinator for …", "Senior Network Engineer -".
const SINGLE_ROLE_TITLE = /^(?:rfp|rfq|ifb)?\s*[-:]?\s*(?:[a-z]+\s+){0,2}(director|manager|coordinator|administrator|supervisor|officer|specialist|engineer|developer|architect|analyst|technician|programmer|consultant)\s+(of|for|[-,])/i;
const PURE_STAFFING = /\b(temporary|contingent|substitute|temp)\s+(staffing|staff|employee|labor|personnel)\b|\bstaff\s+augmentation\s+only\b|\bpersonnel\s+placement\b|\bstaffing\s+services?\b/i;
// A "… Services" project engagement is NOT a job posting (US-8 default rule).
const PROJECT_SIGNAL = /\b(implementation|migration|assessment|modernization|integration|development|managed\s+services?|consulting\s+services?|maintenance|support\s+services?|platform|system|solution)\b/i;

export function isJobPosting(opp: { title: string }): boolean {
  const t = opp.title;
  // Single named role at the start of the title → job posting,
  // UNLESS it's clearly a services engagement (e.g. "IT Director Services").
  if (SINGLE_ROLE_TITLE.test(t) && !/\bservices?\b/i.test(t)) return true;
  // Pure staffing with no project signal.
  if (PURE_STAFFING.test(t) && !PROJECT_SIGNAL.test(t)) return true;
  return false;
}

// ─── RFI / Sources Sought / Pre-Solicitation (US-9) ──────────────────
const RFI_PATTERNS: RegExp[] = [
  /\brfi\b/i,
  /\brfei\b/i,
  /\brequest\s+for\s+information\b/i,
  /\brequest\s+for\s+expressions?\s+of\s+interest\b/i,
  /\bsources?\s+sought\b/i,
  /\bpre-?solicitation\b/i,
];

export function isRfi(opp: { title: string }): boolean {
  return RFI_PATTERNS.some((re) => re.test(opp.title));
}

// ─── Ongoing / no stated deadline (US-10) ────────────────────────────
const ONGOING_TITLE = /\b(ongoing|open\s+enrollment|continuous|evergreen|master\s+(contract|agreement)|on-?going|as[\s-]?needed|on-?call)\b/i;

export function isOngoing(opp: { dueDate: string | null; title: string }): boolean {
  if (!opp.dueDate) return true;
  return ONGOING_TITLE.test(opp.title);
}

/**
 * Primary classification used for routing, plus the orthogonal `ongoing` flag.
 */
export function classifyOpportunity(
  opp: Pick<NormalizedOpportunity, "title" | "agency" | "dueDate">,
): Classification {
  const ongoing = isOngoing(opp);
  let type: OppType = "rfp";
  if (isQandA(opp.title)) type = "qanda";
  else if (isAddendumOrRepost(opp.title)) type = "addendum";
  else if (isFederal(opp)) type = "federal";
  else if (isJobPosting(opp)) type = "job-posting";
  else if (isRfi(opp)) type = "rfi";
  return { type, ongoing };
}

/** Human label for the "Opportunity Type" column. */
export const OPP_TYPE_LABEL: Record<OppType, string> = {
  rfp: "RFP",
  rfi: "RFI",
  "job-posting": "Job Posting",
  federal: "Federal",
  addendum: "Addendum",
  qanda: "Q&A",
};
