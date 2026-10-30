#!/usr/bin/env node
/**
 * check-pr-risk-tier.mjs
 * Enforces risk-tier declaration and high-risk rollback plan evidence.
 *
 * Export: checkRiskTier({ body, labels, files, title }) →
 *   { passed, failures, informational, tier }
 *
 * Labels (preferred): risk:low | risk:medium | risk:high
 * Body fallback: "Risk tier: low|medium|high" (case-insensitive)
 *
 * See doc/reviews/risk-tiers.md for the full policy.
 */
import { fileURLToPath } from 'node:url';

export const RISK_LABELS = Object.freeze({
  low: 'risk:low',
  medium: 'risk:medium',
  high: 'risk:high',
});

const TIER_ORDER = Object.freeze({ low: 1, medium: 2, high: 3 });

const APPROVAL_HINTS = Object.freeze({
  low: 'Risk tier low: require 1 reviewer approval + CI green before merge.',
  medium:
    'Risk tier medium: require 1 reviewer + Lead Engineer approval + CI + tests covering changed behaviour before merge.',
  high:
    'Risk tier high: require 2 approvals (Reviewer + Lead or CTO), security checklist pass, and documented rollback plan before merge.',
});

/** Paths that strongly imply high risk when touched. */
const HIGH_PATH_PATTERNS = [
  /(^|\/)packages\/db\/src\/migrations\//,
  /(^|\/)packages\/db\/drizzle\//,
  // Path-segment auth matches only — avoid false positives like author.ts / oauth-notes.md
  /(^|\/)auth(\/|$)/i,
  /(^|\/)oauth(\/|$)/i,
  /(^|\/)authenticate/i,
  /(^|\/)authentication(\/|$)/i,
  /(^|\/).*payment.*/i,
  /(^|\/).*billing.*/i,
  /(^|\/)server\/src\/routes\/auth/,
  /(^|\/)server\/src\/services\/auth/,
  /(^|\/)\.github\/workflows\/release/,
];

/** Paths that strongly imply at least medium risk. */
const MEDIUM_PATH_PATTERNS = [
  /(^|\/)packages\/db\/src\/schema\//,
  /(^|\/)packages\/shared\/src\/(validators|types)\//,
  /(^|\/)server\/src\/(routes|services)\//,
  /(^|\/)packages\/adapters\//,
];

function normalizeLabelName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase();
}

function tierFromLabelName(name) {
  const n = normalizeLabelName(name);
  if (n === 'risk:low' || n === 'risk-low' || n === 'risk/low') return 'low';
  if (n === 'risk:medium' || n === 'risk-medium' || n === 'risk/medium') return 'medium';
  if (n === 'risk:high' || n === 'risk-high' || n === 'risk/high') return 'high';
  return null;
}

function extractSectionContent(body, heading) {
  const idx = body.indexOf(heading);
  if (idx === -1) return null;
  const after = body.slice(idx + heading.length);
  const nextHeading = after.search(/\n## /);
  return (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
}

function tierFromBody(body) {
  if (!body) return null;

  // Explicit field forms: Risk tier: high / **Risk tier:** medium / Risk-Tier = low
  const field = body.match(
    /(?:\*\*)?risk[\s_-]*tier(?:\*\*)?\s*[:=]\s*\**\s*(low|medium|high)\b/i
  );
  if (field) return field[1].toLowerCase();

  // Bullet: - Risk tier — high
  const bullet = body.match(
    /^\s*[-*>]\s*risk[\s_-]*tier\s*[:=\-–—]\s*(low|medium|high)\b/im
  );
  if (bullet) return bullet[1].toLowerCase();

  return null;
}

function labelTiers(labels) {
  const found = [];
  for (const label of labels ?? []) {
    const name = typeof label === 'string' ? label : label?.name;
    const tier = tierFromLabelName(name);
    if (tier) found.push(tier);
  }
  return [...new Set(found)];
}

function inferTierFromFiles(files) {
  const paths = (files ?? []).map((f) =>
    typeof f === 'string' ? f : f?.filename ?? f?.path ?? ''
  );
  let inferred = 'low';
  for (const p of paths) {
    if (!p) continue;
    if (HIGH_PATH_PATTERNS.some((re) => re.test(p))) {
      return 'high';
    }
    if (MEDIUM_PATH_PATTERNS.some((re) => re.test(p))) {
      inferred = 'medium';
    }
  }
  return inferred;
}

/** Strip HTML comments so template hint comments do not inflate or block substance checks. */
function stripHtmlComments(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * Affirmative rollback steps/link under ## Risks.
 * Requires "rollback plan|strategy|…" followed by a separator and ≥20 chars of
 * plan substance. Rejects checkbox-only and negation prose (“No rollback plan…”).
 */
function hasAffirmativeRollbackInRisks(risks) {
  if (!risks) return false;

  const pattern =
    /rollback[\s_-]*(?:plan|strategy|path|notes?)\s*[:\-–—]\s*(\S[\s\S]{19,})/gi;
  let match;
  while ((match = pattern.exec(risks)) !== null) {
    const before = risks.slice(Math.max(0, match.index - 24), match.index);
    // Negation immediately before the phrase: "No rollback plan:", "without a rollback…"
    if (/\b(no|not|without|none)\b(?:\s+a)?\s*$/i.test(before)) continue;

    const planText = stripHtmlComments(match[1]);
    if (planText.length < 20) continue;
    if (/^(?:n\/a|none|not\s+needed|unnecessary|no\b)/i.test(planText)) continue;
    return true;
  }
  return false;
}

function hasRollbackPlan(body) {
  if (!body || !body.trim()) return false;

  const rollbackSection = extractSectionContent(body, '## Rollback Plan');
  if (rollbackSection) {
    const substance = stripHtmlComments(rollbackSection);
    if (substance.length >= 40) return true;
  }

  const risks = extractSectionContent(body, '## Risks') ?? '';
  return hasAffirmativeRollbackInRisks(risks);
}

/**
 * @param {{ body?: string, labels?: Array<string|{name?: string}>, files?: Array<string|{filename?: string, path?: string}>, title?: string }} input
 */
export function checkRiskTier(input = {}) {
  const body = input.body ?? '';
  const labels = input.labels ?? [];
  const files = input.files ?? [];
  const failures = [];
  const informational = [];

  const fromLabels = labelTiers(labels);
  const fromBody = tierFromBody(body);

  let tier = null;

  if (fromLabels.length > 1) {
    failures.push(
      `Multiple risk-tier labels applied (${fromLabels.map((t) => RISK_LABELS[t]).join(', ')}). Keep exactly one of \`risk:low\`, \`risk:medium\`, \`risk:high\`.`
    );
  } else if (fromLabels.length === 1) {
    tier = fromLabels[0];
    if (fromBody && fromBody !== tier) {
      failures.push(
        `Risk-tier label (\`${RISK_LABELS[tier]}\`) disagrees with PR body declaration (\`${fromBody}\`). Align them.`
      );
    }
  } else if (fromBody) {
    tier = fromBody;
    informational.push(
      `Risk tier taken from PR body (\`${tier}\`). Prefer applying the GitHub label \`${RISK_LABELS[tier]}\` so automation and humans see the same signal.`
    );
  } else {
    failures.push(
      'Missing risk tier. Apply exactly one label (`risk:low`, `risk:medium`, or `risk:high`) or declare `Risk tier: low|medium|high` in the PR body. See `doc/reviews/risk-tiers.md`.'
    );
  }

  const inferred = inferTierFromFiles(files);
  if (tier && TIER_ORDER[inferred] > TIER_ORDER[tier]) {
    informational.push(
      `Changed paths look like **${inferred}** risk (see \`doc/reviews/risk-tiers.md\`), but the declared tier is **${tier}**. Confirm the declaration is intentional.`
    );
  }

  if (tier === 'high') {
    if (!hasRollbackPlan(body)) {
      failures.push(
        'High-risk PRs require a documented rollback plan: add a `## Rollback Plan` section (≥40 chars of substance after HTML comments), or describe affirmative rollback steps/link under `## Risks` (e.g. `Rollback plan: …`). Checkbox-only and negation prose do not count. See `doc/reviews/risk-tiers.md`.'
      );
    }
  }

  if (tier && APPROVAL_HINTS[tier]) {
    informational.push(APPROVAL_HINTS[tier]);
  }

  return {
    passed: failures.length === 0,
    failures,
    informational,
    tier,
    inferredTier: inferred,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const labels = (process.env.PR_LABELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const result = checkRiskTier({ body, labels });
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
