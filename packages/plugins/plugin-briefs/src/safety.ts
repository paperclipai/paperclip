import type { BriefSummaryFailureReason } from "./contracts.js";
import {
  resolveBriefCardState,
  type BriefsSourceBundle,
  type DeterministicBriefOptions,
} from "./deterministic-card-service.js";

const MAX_COMMENT_CHARS = 1_200;
const MAX_RUN_ERROR_CHARS = 800;
const MAX_UNTRUSTED_LINES = 24;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_SESSION_KEY]"],
  [/\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox(?:a|b|p|o|s|r)-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, "Bearer [REDACTED_TOKEN]"],
  [/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*=\s*([^\s'"`]+|"[^"]*"|'[^']*'|`[^`]*`)/gi, "$1=[REDACTED_SECRET]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
];

const NOISY_TOOL_LINE_PATTERNS = [
  /\bmcp\b.*\b(init|initialize|starting|started|stderr|stdio)\b/i,
  /\b(stderr|stdout)\b.*\b(mcp|tool|server)\b/i,
  /\b(node:\d+)\s+(experimentalwarning|deprecationwarning)\b/i,
  /^\s*(debug|trace|verbose)\s*[:\]]/i,
];

const PROMPT_INJECTION_PATTERNS = [
  /\bignore (all )?(previous|above|earlier) (instructions|messages|rules)\b/i,
  /\b(system|developer) (prompt|message|instructions?)\b/i,
  /\bexfiltrat(e|ion)|leak (the )?(secret|token|credential)/i,
  /\breveal (the )?(secret|token|credential|api key|password)\b/i,
];

const ISSUE_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;
const LOW_LEVEL_STATUS_LABEL_PATTERNS = [
  /\b(is|are|was|were|remains?|still)\s+(todo|done|stale|blocked|in[- ]review|in[- ]progress)\b/i,
  /\b(todo|done|stale|blocked|in[- ]review|in[- ]progress)\s+(issue|row|card|state|status)\b/i,
  /\bwaiting[- ]user|waiting[- ]reviewer\b/i,
];

type SummaryFacts = {
  hasBlocked: boolean;
  hasWaitingUser: boolean;
  hasWaitingReviewer: boolean;
  hasDone: boolean;
  hasError: boolean;
  hasLive: boolean;
};

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
}

function stripNoisyToolLines(value: string): string {
  const lines = value.split(/\r?\n/);
  let omitted = 0;
  const kept = lines.filter((line) => {
    const noisy = NOISY_TOOL_LINE_PATTERNS.some((pattern) => pattern.test(line));
    if (noisy) omitted += 1;
    return !noisy;
  });
  if (!omitted) return value;
  return [...kept, `[${omitted} noisy tool log line${omitted === 1 ? "" : "s"} omitted]`].join("\n");
}

function capUntrustedText(value: string, maxChars: number): string {
  const lines = value.split(/\r?\n/);
  const cappedLines = lines.slice(0, MAX_UNTRUSTED_LINES);
  let capped = cappedLines.join("\n").slice(0, maxChars);
  if (lines.length > cappedLines.length || value.length > maxChars) {
    capped = `${capped.trimEnd()}\n[untrusted content truncated]`;
  }
  return capped;
}

function sanitizeUntrustedText(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\u0000/g, "").trim();
  if (!normalized) return "";
  return capUntrustedText(stripNoisyToolLines(neutralizePromptInjection(redactSecrets(normalized))), maxChars);
}

function hasSecretLikeValue(value: string): boolean {
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function hasPromptInjection(value: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

function neutralizePromptInjection(value: string): string {
  return PROMPT_INJECTION_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[REDACTED_PROMPT_INJECTION]"),
    value,
  );
}

function hasOutOfTreeBlocker(bundle: BriefsSourceBundle): boolean {
  const issueIds = new Set(bundle.issues.map((issue) => issue.id));
  return Object.values(bundle.relations ?? {}).some((relation) =>
    (relation.blockedBy ?? []).some((blocker) => !issueIds.has(blocker.id) && blocker.status !== "done" && blocker.status !== "cancelled")
  );
}

function sourceFacts(bundle: BriefsSourceBundle): SummaryFacts {
  const state = resolveBriefCardState(bundle).state;
  const runs = [
    ...Object.values(bundle.activeRuns ?? {}).flat(),
    ...(bundle.runs ?? []),
  ];
  return {
    hasBlocked: state === "blocked" || bundle.issues.some((issue) => issue.status === "blocked") || hasOutOfTreeBlocker(bundle),
    hasWaitingUser: state === "waiting-user" || (bundle.interactions ?? []).some((interaction) => interaction.status === "pending" && interaction.targetUserId === bundle.userId),
    hasWaitingReviewer: state === "waiting-reviewer" || bundle.issues.some((issue) => issue.status === "in_review") || (bundle.approvals ?? []).some((approval) => approval.status === "pending_approval"),
    hasDone: state === "done" || bundle.issues.some((issue) => issue.status === "done"),
    hasError: state === "error" || bundle.issues.some((issue) => Boolean(issue.activeRecoveryAction)) || runs.some((run) => ["failed", "error"].includes(run.status)),
    hasLive: state === "live" || runs.some((run) => run.status === "running") || bundle.issues.some((issue) => issue.status === "in_progress"),
  };
}

function unsupportedStatusClaim(summary: string, facts: SummaryFacts): boolean {
  const claims = [
    { pattern: /\b(blocked|blocker|blocking|blocked by)\b/i, supported: facts.hasBlocked },
    { pattern: /\b(waiting on you|waiting for your|needs your response|your response)\b/i, supported: facts.hasWaitingUser },
    { pattern: /\b(in review|reviewer|approval|approve|approved|requested changes)\b/i, supported: facts.hasWaitingReviewer },
    { pattern: /\b(done|complete|completed|finished|shipped)\b/i, supported: facts.hasDone },
    { pattern: /\b(failed|failure|error|recovery|crashed|timed out)\b/i, supported: facts.hasError },
    { pattern: /\b(active|in progress|running|live)\b/i, supported: facts.hasLive },
  ];
  return claims.some((claim) => claim.pattern.test(summary) && !claim.supported);
}

function unsupportedOwnerClaim(summary: string): boolean {
  return /\b(owner|owned by|assignee|assigned to|responsible agent|responsible user)\b/i.test(summary);
}

function usesLowLevelIssueLabels(summary: string): boolean {
  return ISSUE_IDENTIFIER_PATTERN.test(summary)
    || LOW_LEVEL_STATUS_LABEL_PATTERNS.some((pattern) => pattern.test(summary));
}

function fallbackOptions(reason: BriefSummaryFailureReason, generated: Pick<DeterministicBriefOptions, "generatedByAgentId" | "generatedByRunId">): DeterministicBriefOptions {
  return {
    summaryStatus: "fallback",
    summaryFailureReason: reason,
    generatedByAgentId: generated.generatedByAgentId ?? null,
    generatedByRunId: generated.generatedByRunId ?? null,
  };
}

function withoutGeneratedTitle(options: DeterministicBriefOptions): DeterministicBriefOptions {
  return {
    ...options,
    title: null,
  };
}

export function sanitizeBriefSourceBundle(bundle: BriefsSourceBundle): BriefsSourceBundle {
  return {
    ...bundle,
    comments: (bundle.comments ?? []).map((comment) => ({
      ...comment,
      body: sanitizeUntrustedText(comment.body, MAX_COMMENT_CHARS),
    })),
    activeRuns: Object.fromEntries(
      Object.entries(bundle.activeRuns ?? {}).map(([issueId, runs]) => [
        issueId,
        runs.map((run) => ({
          ...run,
          error: sanitizeUntrustedText(run.error, MAX_RUN_ERROR_CHARS),
        })),
      ]),
    ),
    runs: (bundle.runs ?? []).map((run) => ({
      ...run,
      error: sanitizeUntrustedText(run.error, MAX_RUN_ERROR_CHARS),
    })),
  };
}

export function hardenGeneratedSummaryOptions(
  bundle: BriefsSourceBundle,
  options: DeterministicBriefOptions & { allowGeneratedSummary?: boolean },
): DeterministicBriefOptions {
  let nextOptions: DeterministicBriefOptions & { allowGeneratedSummary?: boolean } = options;
  const generatedTitle = options.title?.trim();
  if (generatedTitle && (!options.allowGeneratedSummary || hasSecretLikeValue(generatedTitle) || hasPromptInjection(generatedTitle))) {
    nextOptions = withoutGeneratedTitle(options);
  }
  if (nextOptions.summaryStatus !== "ok" || !nextOptions.summaryParagraph) {
    return nextOptions;
  }
  const generated = {
    generatedByAgentId: nextOptions.generatedByAgentId ?? null,
    generatedByRunId: nextOptions.generatedByRunId ?? null,
  };
  if (!nextOptions.allowGeneratedSummary) {
    return fallbackOptions("safety_block", generated);
  }
  const summary = nextOptions.summaryParagraph;
  if (hasSecretLikeValue(summary) || hasPromptInjection(summary)) {
    return fallbackOptions("safety_block", generated);
  }
  const facts = sourceFacts(bundle);
  if (usesLowLevelIssueLabels(summary) || unsupportedOwnerClaim(summary) || unsupportedStatusClaim(summary, facts)) {
    return fallbackOptions("safety_block", generated);
  }
  return nextOptions;
}
