import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rt2V33DailyWikiPages } from "@paperclipai/db";
import type { Rt2DailyWikiPage } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// Extended wiki page type with DB fields
export type WikiPageWithDbFields = Rt2DailyWikiPage & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Rt2WikiLintIssue = {
  pageId: string;
  pageKey: string;
  reportDate: string;
  issueType: "empty" | "too_short" | "missing_summary" | "no_activity" | "stale" | "embedding_consistency";
  severity: "info" | "warning" | "error";
  message: string;
  evidence?: Rt2WikiLintEvidence[];
  relatedPageId?: string;
  relatedPageKey?: string;
  confidence?: number;
};

export type Rt2WikiLintResult = {
  companyId: string;
  projectId: string;
  checkedPages: number;
  semanticComparisons: number;
  issues: Rt2WikiLintIssue[];
  summary: {
    empty: number;
    tooShort: number;
    missingSummary: number;
    noActivity: number;
    stale: number;
    embeddingConsistency: number;
  };
};

export type Rt2WikiLintEvidence = {
  pageId: string;
  pageKey: string;
  reportDate: string;
  snippet: string;
};

export type Rt2WikiConsistencyAnalyzer = (
  current: WikiPageWithDbFields,
  candidate: WikiPageWithDbFields,
) => Rt2WikiLintIssue | null | Promise<Rt2WikiLintIssue | null>;

export type Rt2WikiLintRunSummary = {
  startedAt: Date;
  finishedAt: Date;
  projectsChecked: number;
  checkedPages: number;
  issues: number;
  semanticComparisons: number;
};

const STALE_DAYS = 7;
const MIN_SUMMARY_LINES = 1;
const MIN_ACTIVITY_ENTRIES = 1;
const DEFAULT_LINT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_NIGHTLY_RUN_HOUR = 2;
const MIN_SEMANTIC_TOKEN_OVERLAP = 0.15;

const POSITIVE_TERMS = [
  "approved",
  "complete",
  "completed",
  "done",
  "finished",
  "resolved",
  "success",
  "성공",
  "완료",
  "승인",
];
const NEGATIVE_TERMS = [
  "blocked",
  "cancelled",
  "canceled",
  "failed",
  "incomplete",
  "rejected",
  "stuck",
  "실패",
  "차단",
  "취소",
  "거절",
  "미완료",
];

function lintPage(page: WikiPageWithDbFields): Rt2WikiLintIssue[] {
  const issues: Rt2WikiLintIssue[] = [];

  // Check for empty page
  if (page.shortSummary.length === 0 || (page.shortSummary.length === 1 && page.shortSummary[0] === "오늘은 기록이 없습니다.")) {
    issues.push({
      pageId: page.id,
      pageKey: page.pageKey,
      reportDate: page.reportDate,
      issueType: "empty",
      severity: "error",
      message: "위키 페이지가 비어있습니다.",
    });
  }

  // Check for missing summary
  if (page.shortSummary.length === 0) {
    issues.push({
      pageId: page.id,
      pageKey: page.pageKey,
      reportDate: page.reportDate,
      issueType: "missing_summary",
      severity: "warning",
      message: "short_summary이 없습니다.",
    });
  }

  // Check for no activity (empty history)
  if (page.history.length < MIN_ACTIVITY_ENTRIES) {
    issues.push({
      pageId: page.id,
      pageKey: page.pageKey,
      reportDate: page.reportDate,
      issueType: "no_activity",
      severity: "info",
      message: "활동 기록이 없습니다.",
    });
  }

  // Check for stale page (not updated in 7+ days)
  const updatedDate = new Date(page.updatedAt);
  const daysSinceUpdate = Math.floor((Date.now() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceUpdate > STALE_DAYS) {
    issues.push({
      pageId: page.id,
      pageKey: page.pageKey,
      reportDate: page.reportDate,
      issueType: "stale",
      severity: "warning",
      message: `${daysSinceUpdate}일 동안 업데이트되지 않았습니다.`,
    });
  }

  return issues;
}

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractEvidenceSnippet(page: WikiPageWithDbFields, terms: string[]): string {
  const lines = [
    ...page.shortSummary,
    ...page.markdown.split(/\r?\n/),
    ...page.history.map((entry) => entry.summary),
  ]
    .map((line) => line.trim())
    .filter(Boolean);
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const matched = lines.find((line) => {
    const lowerLine = line.toLowerCase();
    return loweredTerms.some((term) => lowerLine.includes(term));
  }) ?? lines[0] ?? "";
  return matched.length > 240 ? `${matched.slice(0, 237)}...` : matched;
}

function containsAny(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

export function analyzeWikiPageConsistency(
  current: WikiPageWithDbFields,
  candidate: WikiPageWithDbFields,
): Rt2WikiLintIssue | null {
  const currentText = `${current.shortSummary.join("\n")}\n${current.markdown}`;
  const candidateText = `${candidate.shortSummary.join("\n")}\n${candidate.markdown}`;
  const similarity = jaccardSimilarity(tokenize(currentText), tokenize(candidateText));

  if (similarity < MIN_SEMANTIC_TOKEN_OVERLAP) return null;

  const currentPositive = containsAny(currentText, POSITIVE_TERMS);
  const currentNegative = containsAny(currentText, NEGATIVE_TERMS);
  const candidatePositive = containsAny(candidateText, POSITIVE_TERMS);
  const candidateNegative = containsAny(candidateText, NEGATIVE_TERMS);
  const polarityConflict = (currentPositive && candidateNegative) || (currentNegative && candidatePositive);

  if (!polarityConflict) return null;

  const currentTerms = currentPositive ? POSITIVE_TERMS : NEGATIVE_TERMS;
  const candidateTerms = candidatePositive ? POSITIVE_TERMS : NEGATIVE_TERMS;

  return {
    pageId: current.id,
    pageKey: current.pageKey,
    reportDate: current.reportDate,
    issueType: "embedding_consistency",
    severity: "warning",
    message: `위키 페이지 간 의미가 충돌할 수 있습니다: ${current.pageKey} ↔ ${candidate.pageKey}`,
    relatedPageId: candidate.id,
    relatedPageKey: candidate.pageKey,
    confidence: Number(similarity.toFixed(3)),
    evidence: [
      {
        pageId: current.id,
        pageKey: current.pageKey,
        reportDate: current.reportDate,
        snippet: extractEvidenceSnippet(current, currentTerms),
      },
      {
        pageId: candidate.id,
        pageKey: candidate.pageKey,
        reportDate: candidate.reportDate,
        snippet: extractEvidenceSnippet(candidate, candidateTerms),
      },
    ],
  };
}

export function rt2WikiLintService(
  db: Db,
  options: {
    consistencyAnalyzer?: Rt2WikiConsistencyAnalyzer;
  } = {},
) {
  const consistencyAnalyzer = options.consistencyAnalyzer ?? analyzeWikiPageConsistency;

  /**
   * M2.5: Lint wiki pages for a project
   */
  async function lintWikiPages(
    companyId: string,
    projectId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<Rt2WikiLintResult> {
    // Build query conditions
    const conditions = [
      eq(rt2V33DailyWikiPages.companyId, companyId),
      eq(rt2V33DailyWikiPages.projectId, projectId),
    ];

    if (startDate) {
      conditions.push(gte(rt2V33DailyWikiPages.reportDate, startDate));
    }
    if (endDate) {
      conditions.push(lte(rt2V33DailyWikiPages.reportDate, endDate));
    }

    const pages = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(and(...conditions))
      .orderBy(desc(rt2V33DailyWikiPages.reportDate));

    const allIssues: Rt2WikiLintIssue[] = [];
    for (const page of pages) {
      const pageIssues = lintPage(page as WikiPageWithDbFields);
      allIssues.push(...pageIssues);
    }
    let semanticComparisons = 0;
    for (let currentIndex = 0; currentIndex < pages.length; currentIndex++) {
      for (let candidateIndex = currentIndex + 1; candidateIndex < pages.length; candidateIndex++) {
        semanticComparisons++;
        const issue = await consistencyAnalyzer(
          pages[currentIndex] as WikiPageWithDbFields,
          pages[candidateIndex] as WikiPageWithDbFields,
        );
        if (issue) allIssues.push(issue);
      }
    }

    // Count issues by type
    const summary = {
      empty: allIssues.filter(i => i.issueType === "empty").length,
      tooShort: allIssues.filter(i => i.issueType === "too_short").length,
      missingSummary: allIssues.filter(i => i.issueType === "missing_summary").length,
      noActivity: allIssues.filter(i => i.issueType === "no_activity").length,
      stale: allIssues.filter(i => i.issueType === "stale").length,
      embeddingConsistency: allIssues.filter(i => i.issueType === "embedding_consistency").length,
    };

    return {
      companyId,
      projectId,
      checkedPages: pages.length,
      semanticComparisons,
      issues: allIssues,
      summary,
    };
  }

  /**
   * M2.5: Get wiki quality score for a project (0-100)
   */
  async function getWikiQualityScore(companyId: string, projectId: string): Promise<number> {
    const result = await lintWikiPages(companyId, projectId);

    if (result.checkedPages === 0) {
      return 100; // No pages = perfect score
    }

    // Calculate score based on issues
    // Each error = -10, warning = -5, info = -1
    let deductions = 0;
    for (const issue of result.issues) {
      switch (issue.severity) {
        case "error":
          deductions += 10;
          break;
        case "warning":
          deductions += 5;
          break;
        case "info":
          deductions += 1;
          break;
      }
    }

    // Also penalize for empty/stale pages ratio
    const emptyOrStale = result.summary.empty + result.summary.stale;
    const emptyRatio = emptyOrStale / result.checkedPages;
    deductions += emptyRatio * 20;

    return Math.max(0, Math.min(100, 100 - deductions));
  }

  return {
    lintWikiPages,
    getWikiQualityScore,
  };
}

export function createRt2WikiLintScheduler(
  db: Db,
  options: {
    intervalMs?: number;
    nightlyRunHour?: number;
    now?: () => Date;
    service?: ReturnType<typeof rt2WikiLintService>;
  } = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_LINT_INTERVAL_MS;
  const nightlyRunHour = options.nightlyRunHour ?? DEFAULT_NIGHTLY_RUN_HOUR;
  const now = options.now ?? (() => new Date());
  const svc = options.service ?? rt2WikiLintService(db);
  const log = logger.child({ service: "rt2-wiki-lint-scheduler" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let runInProgress = false;
  let lastRunDate: string | null = null;
  let lastRunSummary: Rt2WikiLintRunSummary | null = null;

  async function listProjectScopes(): Promise<Array<{ companyId: string; projectId: string }>> {
    const pages = await db
      .select({
        companyId: rt2V33DailyWikiPages.companyId,
        projectId: rt2V33DailyWikiPages.projectId,
      })
      .from(rt2V33DailyWikiPages);

    const seen = new Set<string>();
    const scopes: Array<{ companyId: string; projectId: string }> = [];
    for (const page of pages) {
      const key = `${page.companyId}:${page.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push({ companyId: page.companyId, projectId: page.projectId });
    }
    return scopes;
  }

  function shouldRun(checkTime = now()): boolean {
    const runDate = checkTime.toISOString().slice(0, 10);
    return checkTime.getHours() >= nightlyRunHour && lastRunDate !== runDate;
  }

  async function runScheduledLintNow(): Promise<Rt2WikiLintRunSummary | null> {
    if (runInProgress) {
      log.debug("skipping scheduled wiki lint — previous run still in progress");
      return null;
    }

    runInProgress = true;
    const startedAt = now();
    try {
      const scopes = await listProjectScopes();
      let checkedPages = 0;
      let issues = 0;
      let semanticComparisons = 0;

      for (const scope of scopes) {
        const result = await svc.lintWikiPages(scope.companyId, scope.projectId);
        checkedPages += result.checkedPages;
        issues += result.issues.length;
        semanticComparisons += result.semanticComparisons;
      }

      lastRunDate = startedAt.toISOString().slice(0, 10);
      lastRunSummary = {
        startedAt,
        finishedAt: now(),
        projectsChecked: scopes.length,
        checkedPages,
        issues,
        semanticComparisons,
      };
      log.info(lastRunSummary, "scheduled wiki lint completed");
      return lastRunSummary;
    } catch (err) {
      log.error({ err }, "scheduled wiki lint failed");
      throw err;
    } finally {
      runInProgress = false;
    }
  }

  function tick(): void {
    if (!shouldRun()) return;
    void runScheduledLintNow().catch(() => {
      // Error was already logged; keep the scheduler alive for the next tick.
    });
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    shouldRun,
    runScheduledLintNow,
    getLastRunSummary: () => lastRunSummary,
  };
}
