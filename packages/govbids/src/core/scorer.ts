import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_SCORER_CONCURRENCY, DEFAULT_SCORER_MODEL } from "./constants.js";
import { SYSTEM_PROMPT, ENRICHED_SYSTEM_PROMPT, buildUserPrompt, buildEnrichedUserPrompt } from "./scoring-prompt.js";
import type {
  ExtractedFields,
  NormalizedOpportunity,
  ScoreBreakdown,
  ScoredOpportunity,
  ScorerOptions,
  ServiceCategory,
} from "./types.js";

const VALID_CATEGORIES: ServiceCategory[] = [
  "managed-it",
  "cybersecurity",
  "ai-data",
  "cloud",
  "erp",
  "app-dev",
  "it-staffing",
  "mixed",
];

/**
 * Score a single opportunity using Claude.
 */
export async function scoreOpportunity(
  opp: NormalizedOpportunity,
  options: ScorerOptions,
): Promise<ScoredOpportunity> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_SCORER_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(opp),
      },
    ],
    system: SYSTEM_PROMPT,
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  return parseScoreResponse(opp, text);
}

/**
 * Score an opportunity with full RFP document text for higher-confidence
 * second-tier scoring.
 */
export async function scoreOpportunityWithDocument(
  opp: NormalizedOpportunity,
  documentText: string,
  options: ScorerOptions,
): Promise<ScoredOpportunity> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const model = options.model ?? DEFAULT_SCORER_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 3072,
    messages: [
      {
        role: "user",
        content: buildEnrichedUserPrompt(opp, documentText),
      },
    ],
    system: ENRICHED_SYSTEM_PROMPT,
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  const scored = parseScoreResponse(opp, text, true);
  // Promote extracted fields onto the normalized record so downstream
  // consumers (CSV, HubSpot push) see the better data.
  if (scored.extracted) {
    if (scored.extracted.estimatedValue != null) {
      scored.estimatedValue = scored.extracted.estimatedValue;
    }
    if (scored.extracted.naicsCode) {
      scored.naicsCode = scored.extracted.naicsCode;
    }
    if (scored.extracted.setAsideType) {
      scored.setAsideType = scored.extracted.setAsideType;
    }
  }
  return scored;
}

/**
 * Score a batch of opportunities with controlled concurrency.
 */
export async function scoreBatch(
  opportunities: NormalizedOpportunity[],
  options: ScorerOptions,
): Promise<ScoredOpportunity[]> {
  const concurrency = options.concurrency ?? DEFAULT_SCORER_CONCURRENCY;
  const results: ScoredOpportunity[] = [];
  let completed = 0;

  // Process in chunks of `concurrency`
  for (let i = 0; i < opportunities.length; i += concurrency) {
    const chunk = opportunities.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (opp) => {
        try {
          return await scoreOpportunity(opp, options);
        } catch (error) {
          // On error, return a zero-score result with the error as disqualifier
          return fallbackScore(
            opp,
            `Scoring error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );

    results.push(...chunkResults);
    completed += chunk.length;
    options.onProgress?.(completed, opportunities.length);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

function parseScoreResponse(
  opp: NormalizedOpportunity,
  text: string,
  parseExtracted: boolean = false,
): ScoredOpportunity {
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallbackScore(opp, "No JSON found in scorer response");
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      score?: number;
      scoreBreakdown?: Partial<ScoreBreakdown>;
      serviceCategory?: string;
      reasoning?: string;
      disqualifiers?: string[];
      extracted?: Partial<ExtractedFields>;
    };

    const breakdown: ScoreBreakdown = {
      serviceAlignment: clamp(parsed.scoreBreakdown?.serviceAlignment ?? 0, 0, 40),
      bidReadiness: clamp(parsed.scoreBreakdown?.bidReadiness ?? 0, 0, 20),
      competitivePosition: clamp(parsed.scoreBreakdown?.competitivePosition ?? 0, 0, 20),
      valueFit: clamp(parsed.scoreBreakdown?.valueFit ?? 0, 0, 20),
    };

    const score = clamp(
      breakdown.serviceAlignment +
        breakdown.bidReadiness +
        breakdown.competitivePosition +
        breakdown.valueFit,
      0,
      100,
    );

    const category = VALID_CATEGORIES.includes(
      parsed.serviceCategory as ServiceCategory,
    )
      ? (parsed.serviceCategory as ServiceCategory)
      : "mixed";

    const result: ScoredOpportunity = {
      ...opp,
      score,
      scoreBreakdown: breakdown,
      serviceCategory: category,
      reasoning: parsed.reasoning ?? "",
      disqualifiers: stripSoftDisqualifiers(parsed.disqualifiers ?? []),
    };

    if (parseExtracted && parsed.extracted) {
      result.extracted = normalizeExtracted(parsed.extracted);
    }

    return result;
  } catch {
    return fallbackScore(opp, "Failed to parse scorer response");
  }
}

function normalizeExtracted(raw: Partial<ExtractedFields>): ExtractedFields {
  const toNumber = (v: unknown): number | null => {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
    const cleaned = String(v).replace(/[$,\s]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const toString = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length > 0 && s.toLowerCase() !== "null" && s.toLowerCase() !== "none"
      ? s
      : null;
  };
  const toIsoDate = (v: unknown): string | null => {
    const s = toString(v);
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  };

  return {
    estimatedValue: toNumber(raw.estimatedValue),
    annualValue: toNumber(raw.annualValue),
    contractTermYears: toNumber(raw.contractTermYears),
    naicsCode: toString(raw.naicsCode),
    setAsideType: toString(raw.setAsideType),
    prebidConferenceDate: toIsoDate(raw.prebidConferenceDate),
    questionsDueDate: toIsoDate(raw.questionsDueDate),
    submissionPortal: toString(raw.submissionPortal),
    primaryContactEmail: toString(raw.primaryContactEmail),
  };
}

function fallbackScore(
  opp: NormalizedOpportunity,
  errorMessage: string,
): ScoredOpportunity {
  return {
    ...opp,
    score: 0,
    scoreBreakdown: {
      serviceAlignment: 0,
      bidReadiness: 0,
      competitivePosition: 0,
      valueFit: 0,
    },
    serviceCategory: "mixed",
    reasoning: errorMessage,
    disqualifiers: [errorMessage],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Strip "soft" reasons that the team flagged as over-aggressive disqualifiers
 * (round-3 feedback). Coverage audit on 193 manual team RFPs showed these two
 * patterns alone caused 83 spurious filter-outs across 8 days — both are
 * operating conditions the team handles routinely, not hard blockers.
 *
 * Also strips deadline-tightness, no-diversity-advantage, and pure-vagueness
 * notes. True blockers (certifications, sole-source, RFI-not-RFP, etc.) pass
 * through unchanged.
 */
export function stripSoftDisqualifiers(dq: string[]): string[] {
  const softPatterns: RegExp[] = [
    // Unknown / unspecified contract value
    /\bvalue\b.*\b(unknown|not specified|not provided|unspecified|no contract value|no estimated|not stated|unclear)\b/i,
    /\b(unknown|unspecified|no estimated|no contract value|not specified|undisclosed)\b.*\bvalue\b/i,
    /\bcontract value\b.*(not|un)/i,
    /\b(price|budget) (not|un)/i,
    // Limited / minimal / brief / vague RFP details
    /\b(limited|minimal|brief|vague|insufficient|sparse|incomplete)\b.*(detail|description|information|requirements|solicitation)/i,
    /\b(detail|description|information|requirements)\b.*\b(limited|minimal|brief|vague|insufficient|sparse|missing|incomplete)\b/i,
    // US-6: bare "unclear requirements" style concerns with no specific missing
    // element. A real gap names what's missing ("no contract value stated") and
    // survives; a generic vagueness flag is stripped.
    /\bunclear\b.*\b(requirements?|scope|details?|specifications?)\b/i,
    /\b(requirements?|scope|specifications?)\b.*\bunclear\b/i,
    /\bvague\b.*\b(scope|requirements?|rfp|solicitation)\b/i,
    /^(unclear|vague|ambiguous)\b/i,
    // Deadline tightness
    /\b(tight|short|narrow|very brief|insufficient|limited)\b.*\b(deadline|response window|timeline|turnaround|time)\b/i,
    /\bdue (date)? (is )?(tomorrow|today|in \d+ days?|soon|imminent)/i,
    /\bvery soon\b/i,
    /\bonly \d+ days?\b/i,
    // No competitive / diversity edge — open competition is the norm
    /\bno (competitive |diversity )?(advantage|set-aside|preference|edge)/i,
    /\bopen competition\b/i,
    /\bdiversity (certifications? )?(would |do |does )?not\b/i,
  ];

  return dq.filter((d) => !softPatterns.some((rx) => rx.test(d)));
}
