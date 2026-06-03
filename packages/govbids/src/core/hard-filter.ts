import {
  NON_BIDDABLE_TYPES,
  NAICS_CODES,
  VALUE_RANGE,
  DUE_DATE_RANGE,
  EXCLUDED_AGENCY_PATTERNS,
} from "./constants.js";
import type {
  NormalizedOpportunity,
  FilterResult,
  HardFilterConfig,
} from "./types.js";

type FilterFn = (
  opp: NormalizedOpportunity,
  config: Required<HardFilterConfig>,
) => string | null;

/**
 * Filter: drop non-biddable opportunity types.
 * Returns a reason string if filtered, null if passed.
 */
const filterNonBiddableTypes: FilterFn = (opp, config) => {
  if (!opp.type) return null; // Pass if type is unknown
  const typeLower = opp.type.toLowerCase();
  for (const excluded of config.nonBiddableTypes) {
    if (typeLower.includes(excluded.toLowerCase())) {
      return `Non-biddable type: "${opp.type}"`;
    }
  }
  return null;
};

/**
 * Filter: drop opportunities with NAICS codes not in the approved list.
 * Passes if the opportunity has no NAICS code (many state/local opps lack one).
 */
const filterByNaics: FilterFn = (opp, config) => {
  if (!opp.naicsCode) return null; // Pass if no NAICS
  if (config.naicsCodes.includes(opp.naicsCode)) return null;
  // Also check if it starts with any of the approved codes (partial match for subcodes)
  for (const code of config.naicsCodes) {
    if (opp.naicsCode.startsWith(code)) return null;
  }
  return `NAICS code "${opp.naicsCode}" not in approved list`;
};

/**
 * Filter: drop opportunities outside the value range.
 * Passes if no value is specified (many state/local opps don't list values).
 */
const filterByValueRange: FilterFn = (opp, config) => {
  if (opp.estimatedValue === null) return null; // Pass if no value
  if (
    opp.estimatedValue >= config.valueRange.min &&
    opp.estimatedValue <= config.valueRange.max
  ) {
    return null;
  }
  return `Value $${opp.estimatedValue.toLocaleString()} outside range $${config.valueRange.min.toLocaleString()}–$${config.valueRange.max.toLocaleString()}`;
};

/**
 * Filter: drop opportunities with expired or too-far-out due dates.
 * Passes if no due date is specified.
 */
const filterByDueDate: FilterFn = (opp, config) => {
  if (!opp.dueDate) return null; // Pass if no due date
  const now = new Date();
  const due = new Date(opp.dueDate);
  const daysFromNow = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysFromNow < config.dueDateRange.minDaysFromNow) {
    return `Due date ${opp.dueDate} is in the past`;
  }
  if (daysFromNow > config.dueDateRange.maxDaysFromNow) {
    return `Due date ${opp.dueDate} is more than ${config.dueDateRange.maxDaysFromNow} days out`;
  }
  return null;
};

/**
 * US-4: drop international / non-US-jurisdiction issuers (UN bodies, World Bank,
 * etc.). These follow non-US procurement rules and the work is rarely US-located,
 * so ConsultAdd cannot pursue them. Whole-word match on the agency name to avoid
 * false positives like "Union County" or "Unicoi".
 */
const filterExcludedAgency: FilterFn = (opp) => {
  const agency = ` ${opp.agency.toLowerCase()} `;
  for (const pattern of EXCLUDED_AGENCY_PATTERNS) {
    // Match as a whole phrase bounded by non-alphanumerics on each side.
    const re = new RegExp(`(^|[^a-z])${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
    if (re.test(agency)) {
      return `Excluded non-US issuer: "${opp.agency}"`;
    }
  }
  return null;
};

const FILTER_CHAIN: FilterFn[] = [
  filterExcludedAgency,
  filterNonBiddableTypes,
  filterByNaics,
  filterByValueRange,
  filterByDueDate,
];

/**
 * Apply all hard filters to a list of opportunities.
 * Returns kept opportunities and dropped ones with reasons.
 */
export function applyHardFilters(
  opportunities: NormalizedOpportunity[],
  config?: HardFilterConfig,
): FilterResult {
  const resolvedConfig: Required<HardFilterConfig> = {
    nonBiddableTypes: config?.nonBiddableTypes ?? [...NON_BIDDABLE_TYPES],
    naicsCodes: config?.naicsCodes ?? [...NAICS_CODES],
    valueRange: config?.valueRange ?? { ...VALUE_RANGE },
    dueDateRange: config?.dueDateRange ?? { ...DUE_DATE_RANGE },
  };

  const kept: NormalizedOpportunity[] = [];
  const dropped: FilterResult["dropped"] = [];

  for (const opp of opportunities) {
    let dropReason: string | null = null;

    for (const filter of FILTER_CHAIN) {
      dropReason = filter(opp, resolvedConfig);
      if (dropReason) break;
    }

    if (dropReason) {
      dropped.push({ opportunity: opp, reason: dropReason });
    } else {
      kept.push(opp);
    }
  }

  return { kept, dropped };
}
