/**
 * Issue → Project auto-classification (heuristic / rules engine).
 *
 * One-click suggestion of a project for unclassified issues.
 *
 * This module is intentionally a pure, dependency-free function: it takes the
 * candidate projects and (optionally) the already-classified issues that anchor
 * each project, and returns a ranked, *explainable* set of suggestions. No LLM
 * call, no network, no DB access — deterministic and unit-testable. The board's
 * rules-vs-model decision can layer an LLM tie-breaker on top later
 * without changing this contract; see the scoping note on the issue.
 *
 * Scoring is a lightweight TF-IDF-style weighted term overlap between the issue
 * text and a per-project term profile built from the project name/description
 * plus the text of issues already filed under it. IDF suppresses ubiquitous
 * boilerplate ("review", "fix", "ton", …) so generic terms don't dominate.
 */

export interface ClassifierProject {
  id: string;
  name: string;
  description?: string | null;
  /** e.g. "in_progress" | "backlog" | "archived" | "paused" */
  status?: string | null;
}

export interface ClassifierIssue {
  id?: string;
  title: string;
  description?: string | null;
}

/** Already-classified issues that anchor a project's term profile. */
export interface ProjectSignal {
  projectId: string;
  issues: ClassifierIssue[];
}

export interface ProjectSuggestion {
  projectId: string;
  projectName: string;
  /** 0..1 confidence — fraction of the issue's salient terms the project explains. */
  score: number;
  /** Terms that drove the match, highest-contribution first (for the UI "why"). */
  matchedTerms: string[];
  reason: string;
}

export interface SuggestOptions {
  /** Minimum top score for a one-click-safe suggestion. Default 0.12. */
  minScore?: number;
  /** Top must beat the runner-up by at least this margin to be one-click-safe. Default 0.04. */
  minMargin?: number;
  /** Max suggestions returned (ranked). Default 3. */
  maxSuggestions?: number;
  /** Project ids to never suggest (e.g. catch-all / "미분류" buckets). */
  excludeProjectIds?: string[];
  /** Project statuses to never suggest. Default ["archived", "paused"]. */
  excludeStatuses?: string[];
  /** Max classified issues per project folded into the profile (perf cap). Default 50. */
  maxAnchorIssues?: number;
}

export interface SuggestResult {
  suggestions: ProjectSuggestion[];
  /**
   * The single suggestion that cleared the floor + margin — safe to offer as a
   * pre-filled one-click apply. Null when the signal is too weak/ambiguous, in
   * which case the UI should show ranked options without a default selection.
   */
  topConfident: ProjectSuggestion | null;
}

const DEFAULT_STOPWORDS = new Set<string>([
  // English boilerplate that carries no project signal
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by",
  "is", "are", "be", "with", "from", "this", "that", "it", "as", "via",
  "fix", "fixes", "fixed", "bug", "issue", "issues", "task", "tasks", "review",
  "add", "added", "update", "updated", "wip", "todo", "done", "blocked",
  "feat", "chore", "refactor", "test", "tests", "ci", "pr", "ton",
  // Korean boilerplate
  "및", "관련", "이슈", "작업", "수정", "추가", "개선", "검토", "진행", "정리",
  "기반", "위한", "대한", "통해", "관리", "지원",
]);

/** Unicode-aware tokenizer: letters/digits in any script (keeps Hangul runs). */
function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  const matched = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matched) return [];
  return matched.filter((t) => t.length > 1 && !DEFAULT_STOPWORDS.has(t));
}

/** Saturation constant: project weight pw maps to pw/(pw+k) ∈ [0,1). */
const ANCHOR_SATURATION = 2;

type TermWeights = Map<string, number>;

function addWeighted(into: TermWeights, tokens: string[], weight: number): void {
  for (const t of tokens) into.set(t, (into.get(t) ?? 0) + weight);
}

interface ProjectProfile {
  project: ClassifierProject;
  weights: TermWeights;
}

function buildProfile(
  project: ClassifierProject,
  signal: ProjectSignal | undefined,
  maxAnchorIssues: number,
): ProjectProfile {
  const weights: TermWeights = new Map();
  // Project identity carries the strongest signal.
  addWeighted(weights, tokenize(project.name), 3);
  addWeighted(weights, tokenize(project.description), 2);
  // Anchor issues already filed under the project shape its vocabulary.
  const anchors = signal?.issues.slice(0, maxAnchorIssues) ?? [];
  for (const iss of anchors) {
    addWeighted(weights, tokenize(iss.title), 1);
    addWeighted(weights, tokenize(iss.description), 0.5);
  }
  return { project, weights };
}

/** Inverse document frequency across project profiles, smoothed. */
function computeIdf(profiles: ProjectProfile[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const p of profiles) {
    for (const term of p.weights.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = profiles.length;
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log((n + 1) / (d + 1)) + 1);
  return idf;
}

/**
 * Rank candidate projects for an unclassified issue.
 *
 * @param issue    the issue to classify (title + optional description)
 * @param projects candidate projects
 * @param signals  already-classified issues per project (optional but improves accuracy)
 * @param options  thresholds / exclusions
 */
export function suggestProjectsForIssue(
  issue: ClassifierIssue,
  projects: ClassifierProject[],
  signals: ProjectSignal[] = [],
  options: SuggestOptions = {},
): SuggestResult {
  const {
    minScore = 0.12,
    minMargin = 0.04,
    maxSuggestions = 3,
    excludeProjectIds = [],
    excludeStatuses = ["archived", "paused"],
    maxAnchorIssues = 50,
  } = options;

  const excludeIds = new Set(excludeProjectIds);
  const excludeStatusSet = new Set(excludeStatuses);
  const signalById = new Map(signals.map((s) => [s.projectId, s]));

  const candidates = projects.filter(
    (p) => !excludeIds.has(p.id) && !excludeStatusSet.has((p.status ?? "").toLowerCase()),
  );
  if (candidates.length === 0) return { suggestions: [], topConfident: null };

  const profiles = candidates.map((p) =>
    buildProfile(p, signalById.get(p.id), maxAnchorIssues),
  );
  const idf = computeIdf(profiles);

  // Query: the issue's own salient terms, title weighted over description.
  const query: TermWeights = new Map();
  addWeighted(query, tokenize(issue.title), 2);
  addWeighted(query, tokenize(issue.description), 1);
  // Normalizer = total IDF-weighted mass of the query, so score ≈ fraction explained.
  let queryMass = 0;
  for (const [term, w] of query) queryMass += w * (idf.get(term) ?? 1);
  if (queryMass === 0) return { suggestions: [], topConfident: null };

  const scored: ProjectSuggestion[] = profiles.map(({ project, weights }) => {
    const contributions: Array<{ term: string; value: number }> = [];
    let raw = 0;
    for (const [term, qw] of query) {
      const pw = weights.get(term);
      if (!pw) continue;
      const termIdf = idf.get(term) ?? 1;
      // Saturating project weight in [0,1) so a project can't win purely by
      // anchor volume, and so the per-term ratio (value / qw·idf) never exceeds
      // 1 — which keeps the final score bounded in [0,1].
      const saturated = pw / (pw + ANCHOR_SATURATION);
      const value = qw * termIdf * saturated;
      raw += value;
      contributions.push({ term, value });
    }
    contributions.sort((a, b) => b.value - a.value);
    const matchedTerms = contributions.slice(0, 5).map((c) => c.term);
    const score = queryMass > 0 ? raw / queryMass : 0;
    const reason = matchedTerms.length
      ? `Overlaps on: ${matchedTerms.join(", ")}`
      : "No shared salient terms";
    return { projectId: project.id, projectName: project.name, score, matchedTerms, reason };
  });

  scored.sort((a, b) => b.score - a.score);
  const suggestions = scored.slice(0, maxSuggestions).filter((s) => s.score > 0);

  let topConfident: ProjectSuggestion | null = null;
  const top = scored[0];
  const second = scored[1];
  if (top && top.score >= minScore) {
    const margin = second ? top.score - second.score : top.score;
    if (margin >= minMargin) topConfident = top;
  }

  return { suggestions, topConfident };
}
