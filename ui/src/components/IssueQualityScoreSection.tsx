import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { Check, Copy, Loader2, RefreshCw, Save, Sparkles, SquarePen, Trash2, X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { issuesApi, type IssueQualityScore } from "../api/issues";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { useToastActions } from "../context/ToastContext";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const ISSUE_QUALITY_DOCUMENT_KEY = "issue-quality-score";
const ISSUE_QUALITY_JSON_MARKER = "<!-- issue-quality-score:v1 -->";

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeUiLanguage(language: string | undefined): "en" | "pt-BR" {
  if (!language) return "en";
  const normalized = language.trim().toLowerCase();
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  return "en";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function parseIssueQualityScoreFromMarkdown(markdown: string): IssueQualityScore | null {
  const candidate = markdown.includes(ISSUE_QUALITY_JSON_MARKER)
    ? markdown.slice(markdown.indexOf(ISSUE_QUALITY_JSON_MARKER))
    : markdown;

  const match = candidate.match(/```json\s*([\s\S]*?)\s*```/i) ?? markdown.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    const record = asRecord(parsed);
    if (!record) return null;

    const overallScore = asNumber(record.overallScore);
    const issueId = asString(record.issueId);
    const rating = asString(record.rating) as IssueQualityScore["rating"] | null;
    const ambiguityRiskLevel = asString(record.ambiguityRiskLevel) as IssueQualityScore["ambiguityRiskLevel"] | null;
    const language = asString(record.language) as IssueQualityScore["language"] | null;
    const generatedBy = asString(record.generatedBy) as IssueQualityScore["generatedBy"] | null;
    const analysisMode = asString(record.analysisMode) as IssueQualityScore["analysisMode"] | null;

    if (
      overallScore === null ||
      !issueId ||
      !rating ||
      !ambiguityRiskLevel ||
      !language ||
      !generatedBy ||
      !analysisMode
    ) {
      return null;
    }

    return {
      id: asString(record.id) ?? `${issueId}:${asString(record.createdAt) ?? "unknown"}`,
      issueId,
      overallScore,
      rating,
      clarityScore: asNumber(record.clarityScore) ?? 0,
      problemContextScore: asNumber(record.problemContextScore) ?? 0,
      acceptanceCriteriaScore: asNumber(record.acceptanceCriteriaScore) ?? 0,
      businessRulesScore: asNumber(record.businessRulesScore) ?? 0,
      technicalContextScore: asNumber(record.technicalContextScore) ?? 0,
      testabilityScore: asNumber(record.testabilityScore) ?? 0,
      scopeScore: asNumber(record.scopeScore) ?? 0,
      ambiguityRiskScore: asNumber(record.ambiguityRiskScore) ?? 0,
      ambiguityRiskLevel,
      strengths: asStringArray(record.strengths),
      problems: asStringArray(record.problems),
      suggestions: asStringArray(record.suggestions),
      missingFields: asStringArray(record.missingFields),
      recommendation: asString(record.recommendation) ?? "",
      language,
      generatedBy,
      model: asString(record.model) ?? undefined,
      promptBlueprint: asString(record.promptBlueprint) ?? "",
      analysisMode,
      createdAt: asString(record.createdAt) ?? new Date().toISOString(),
      updatedAt: asString(record.updatedAt) ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function ratingToneClass(score: number): string {
  if (score >= 90) return "text-emerald-600 dark:text-emerald-300";
  if (score >= 75) return "text-green-600 dark:text-green-300";
  if (score >= 60) return "text-amber-600 dark:text-amber-300";
  if (score >= 40) return "text-orange-600 dark:text-orange-300";
  return "text-red-600 dark:text-red-300";
}

export function IssueQualityScoreSection({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [draftBody, setDraftBody] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const [copied, setCopied] = useState(false);
  const [analysisFromGeneration, setAnalysisFromGeneration] = useState<IssueQualityScore | null>(null);
  const generationControllerRef = useRef<AbortController | null>(null);

  const qualityDocumentQuery = useQuery({
    queryKey: queryKeys.issues.document(issue.id, ISSUE_QUALITY_DOCUMENT_KEY),
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issue.id, ISSUE_QUALITY_DOCUMENT_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
  });

  const savedDocument = qualityDocumentQuery.data;

  const saveMutation = useMutation({
    mutationFn: async () => {
      return issuesApi.upsertDocument(issue.id, ISSUE_QUALITY_DOCUMENT_KEY, {
        title: t("issueQuality.documentTitle", { ns: "issues", defaultValue: "Issue Quality Analysis" }),
        format: "markdown",
        body: draftBody,
        baseRevisionId: savedDocument?.latestRevisionId ?? null,
      });
    },
    onSuccess: (document) => {
      queryClient.setQueryData(queryKeys.issues.document(issue.id, ISSUE_QUALITY_DOCUMENT_KEY), document);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      setHasLocalDraft(false);
      setIsEditing(false);
      pushToast({
        title: t("issueQuality.toasts.savedTitle", { ns: "issues", defaultValue: "Issue quality analysis saved" }),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("issueQuality.toasts.savedErrorTitle", { ns: "issues", defaultValue: "Failed to save issue quality analysis" }),
        body: error instanceof Error
          ? error.message
          : t("issueQuality.errors.unexpected", { ns: "issues", defaultValue: "Unexpected error." }),
        tone: "error",
      });
    },
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      generationControllerRef.current?.abort();
      const controller = new AbortController();
      generationControllerRef.current = controller;
      try {
        return await issuesApi.analyzeQualityScore(
          issue.id,
          { language: normalizeUiLanguage(i18n.language) },
          { signal: controller.signal },
        );
      } finally {
        if (generationControllerRef.current === controller) {
          generationControllerRef.current = null;
        }
      }
    },
    onSuccess: (result) => {
      setDraftBody(result.markdown);
      setAnalysisFromGeneration(result.analysis);
      setHasLocalDraft(true);
      setIsEditing(false);
      pushToast({
        title: t("issueQuality.toasts.generatedTitle", { ns: "issues", defaultValue: "Issue quality analysis generated" }),
        tone: "success",
      });
    },
    onError: (error) => {
      if (isAbortError(error)) return;
      pushToast({
        title: t("issueQuality.toasts.generatedErrorTitle", { ns: "issues", defaultValue: "Failed to analyze issue quality" }),
        body: error instanceof Error
          ? error.message
          : t("issueQuality.errors.unexpected", { ns: "issues", defaultValue: "Unexpected error." }),
        tone: "error",
      });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!savedDocument) return;
      await issuesApi.deleteDocument(issue.id, ISSUE_QUALITY_DOCUMENT_KEY);
    },
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.issues.document(issue.id, ISSUE_QUALITY_DOCUMENT_KEY), null);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      setDraftBody("");
      setAnalysisFromGeneration(null);
      setHasLocalDraft(false);
      setIsEditing(false);
      pushToast({
        title: t("issueQuality.toasts.clearedTitle", { ns: "issues", defaultValue: "Issue quality analysis cleared" }),
        tone: "success",
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        setDraftBody("");
        setAnalysisFromGeneration(null);
        setHasLocalDraft(false);
        setIsEditing(false);
        return;
      }
      pushToast({
        title: t("issueQuality.toasts.clearedErrorTitle", { ns: "issues", defaultValue: "Failed to clear issue quality analysis" }),
        body: error instanceof Error
          ? error.message
          : t("issueQuality.errors.unexpected", { ns: "issues", defaultValue: "Unexpected error." }),
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (hasLocalDraft) return;
    setDraftBody(savedDocument?.body ?? "");
    setAnalysisFromGeneration(savedDocument?.body ? parseIssueQualityScoreFromMarkdown(savedDocument.body) : null);
    if (!savedDocument) setIsEditing(false);
  }, [savedDocument?.body, savedDocument?.latestRevisionId, hasLocalDraft, savedDocument]);

  useEffect(() => {
    return () => {
      generationControllerRef.current?.abort();
      generationControllerRef.current = null;
    };
  }, []);

  const parsedAnalysisFromDraft = useMemo(() => parseIssueQualityScoreFromMarkdown(draftBody), [draftBody]);
  const qualityAnalysis = parsedAnalysisFromDraft ?? analysisFromGeneration;

  const canSave = draftBody.trim().length > 0 && !saveMutation.isPending;
  const hasContent = draftBody.trim().length > 0;
  const isDirty = useMemo(() => {
    if (!savedDocument) return hasContent;
    return draftBody !== savedDocument.body;
  }, [draftBody, hasContent, savedDocument]);

  const handleCancelGeneration = () => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    analyzeMutation.reset();
    pushToast({
      title: t("issueQuality.toasts.generationCanceledTitle", { ns: "issues", defaultValue: "Analysis canceled" }),
      tone: "success",
    });
  };

  const handleCopy = async () => {
    if (!hasContent) return;
    await navigator.clipboard.writeText(draftBody);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    pushToast({
      title: t("issueQuality.toasts.copiedTitle", { ns: "issues", defaultValue: "Issue quality analysis copied" }),
      tone: "success",
    });
  };

  const handleCancelEdit = () => {
    setDraftBody(savedDocument?.body ?? "");
    setAnalysisFromGeneration(savedDocument?.body ? parseIssueQualityScoreFromMarkdown(savedDocument.body) : null);
    setHasLocalDraft(false);
    setIsEditing(false);
  };

  const ratingLabel = qualityAnalysis
    ? t(`issueQuality.rating.${qualityAnalysis.rating}`, {
      ns: "issues",
      defaultValue: qualityAnalysis.rating,
    })
    : "";

  const ambiguityRiskLabel = qualityAnalysis
    ? t(`issueQuality.ambiguity.${qualityAnalysis.ambiguityRiskLevel}`, {
      ns: "issues",
      defaultValue: qualityAnalysis.ambiguityRiskLevel,
    })
    : "";

  const criteriaRows = qualityAnalysis
    ? [
      {
        key: "clarity",
        label: t("issueQuality.criteria.clarity", { ns: "issues", defaultValue: "Description clarity" }),
        score: qualityAnalysis.clarityScore,
      },
      {
        key: "problemContext",
        label: t("issueQuality.criteria.problemContext", { ns: "issues", defaultValue: "Problem context" }),
        score: qualityAnalysis.problemContextScore,
      },
      {
        key: "acceptanceCriteria",
        label: t("issueQuality.criteria.acceptanceCriteria", { ns: "issues", defaultValue: "Acceptance criteria" }),
        score: qualityAnalysis.acceptanceCriteriaScore,
      },
      {
        key: "businessRules",
        label: t("issueQuality.criteria.businessRules", { ns: "issues", defaultValue: "Business rules" }),
        score: qualityAnalysis.businessRulesScore,
      },
      {
        key: "technicalContext",
        label: t("issueQuality.criteria.technicalContext", { ns: "issues", defaultValue: "Technical context" }),
        score: qualityAnalysis.technicalContextScore,
      },
      {
        key: "testability",
        label: t("issueQuality.criteria.testability", { ns: "issues", defaultValue: "Testability" }),
        score: qualityAnalysis.testabilityScore,
      },
      {
        key: "scope",
        label: t("issueQuality.criteria.scope", { ns: "issues", defaultValue: "Defined scope" }),
        score: qualityAnalysis.scopeScore,
      },
      {
        key: "ambiguityRisk",
        label: t("issueQuality.criteria.ambiguityRisk", { ns: "issues", defaultValue: "Ambiguity risk (inverse)" }),
        score: qualityAnalysis.ambiguityRiskScore,
      },
    ]
    : [];

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">
            {t("issueQuality.title", { ns: "issues", defaultValue: "Issue Quality" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("issueQuality.description", {
              ns: "issues",
              defaultValue: "Analyze issue readiness with a structured quality score before implementation.",
            })}
          </p>
          {savedDocument ? (
            <p className="text-[11px] text-muted-foreground">
              {t("issueQuality.lastSaved", {
                ns: "issues",
                defaultValue: "Last saved {{timeAgo}}",
                timeAgo: relativeTime(savedDocument.updatedAt),
              })}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {analyzeMutation.isPending ? (
            <Button variant="outline" size="sm" onClick={handleCancelGeneration}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {t("issueQuality.actions.cancelGeneration", { ns: "issues", defaultValue: "Cancel analysis" })}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => analyzeMutation.mutate()}
              disabled={qualityDocumentQuery.isLoading || saveMutation.isPending}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {hasContent
                ? t("issueQuality.actions.reanalyze", { ns: "issues", defaultValue: "Reanalyze quality" })
                : t("issueQuality.actions.analyze", { ns: "issues", defaultValue: "Analyze issue quality" })}
            </Button>
          )}

          <Button variant="ghost" size="sm" onClick={handleCopy} disabled={!hasContent}>
            {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-500" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
            {t("issueQuality.actions.copy", { ns: "issues", defaultValue: "Copy analysis" })}
          </Button>

          {!isEditing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearMutation.mutate()}
              disabled={!hasContent || clearMutation.isPending || saveMutation.isPending || analyzeMutation.isPending}
            >
              {clearMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t("issueQuality.actions.clear", { ns: "issues", defaultValue: "Clear analysis" })}
            </Button>
          ) : null}

          {isEditing ? (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancelEdit} disabled={saveMutation.isPending}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                {t("issueQuality.actions.cancelEdit", { ns: "issues", defaultValue: "Cancel edit" })}
              </Button>
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!canSave || !isDirty}>
                {saveMutation.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t("issueQuality.actions.save", { ns: "issues", defaultValue: "Save analysis" })}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              disabled={!hasContent || analyzeMutation.isPending}
            >
              <SquarePen className="mr-1.5 h-3.5 w-3.5" />
              {t("issueQuality.actions.edit", { ns: "issues", defaultValue: "Edit analysis" })}
            </Button>
          )}
        </div>
      </div>

      {analyzeMutation.isPending ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("issueQuality.loading", {
            ns: "issues",
            defaultValue: "Analyzing issue quality based on current context...",
          })}
        </div>
      ) : null}

      {analyzeMutation.error && !isAbortError(analyzeMutation.error) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("issueQuality.errors.analyze", {
            ns: "issues",
            defaultValue: "Failed to analyze issue quality. Please try again.",
          })}
        </div>
      ) : null}

      {qualityDocumentQuery.isLoading && !hasLocalDraft ? (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {t("issueQuality.loadingSaved", {
            ns: "issues",
            defaultValue: "Loading saved issue quality analysis...",
          })}
        </div>
      ) : null}

      {!hasContent ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          {t("issueQuality.empty", {
            ns: "issues",
            defaultValue: "No issue quality analysis yet. Run analysis to evaluate execution readiness.",
          })}
        </div>
      ) : isEditing ? (
        <Textarea
          value={draftBody}
          onChange={(event) => {
            setDraftBody(event.target.value);
            setHasLocalDraft(true);
          }}
          rows={20}
          className="font-mono text-xs"
          aria-label={t("issueQuality.editorAriaLabel", {
            ns: "issues",
            defaultValue: "Issue quality analysis editor",
          })}
        />
      ) : (
        <div className="space-y-3">
          {qualityAnalysis ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t("issueQuality.summary.scoreLabel", { ns: "issues", defaultValue: "Issue score" })}
                  </p>
                  <p className={`text-2xl font-semibold ${ratingToneClass(qualityAnalysis.overallScore)}`}>
                    {qualityAnalysis.overallScore}/100
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("issueQuality.summary.ratingLabel", { ns: "issues", defaultValue: "Classification" })}: {ratingLabel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("issueQuality.summary.ambiguityLabel", { ns: "issues", defaultValue: "Ambiguity risk" })}: {ambiguityRiskLabel}
                  </p>
                </div>

                <div className="w-full max-w-[260px] space-y-1">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/80"
                      style={{ width: `${Math.max(0, Math.min(100, qualityAnalysis.overallScore))}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t("issueQuality.summary.generatedAt", {
                      ns: "issues",
                      defaultValue: "Generated {{timeAgo}}",
                      timeAgo: relativeTime(qualityAnalysis.createdAt),
                    })}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("issueQuality.criteria.title", { ns: "issues", defaultValue: "Criteria" })}
                </h4>
                <div className="grid gap-2 md:grid-cols-2">
                  {criteriaRows.map((row) => (
                    <div key={row.key} className="space-y-1 rounded-md border border-border/70 p-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">{row.label}</span>
                        <span className="font-medium text-foreground">{row.score}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${Math.max(0, Math.min(100, row.score))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {qualityAnalysis.strengths.length > 0 ? (
                <div className="space-y-1">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("issueQuality.sections.strengths", { ns: "issues", defaultValue: "Strengths" })}
                  </h4>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-foreground">
                    {qualityAnalysis.strengths.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {qualityAnalysis.problems.length > 0 ? (
                <div className="space-y-1">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("issueQuality.sections.problems", { ns: "issues", defaultValue: "Problems found" })}
                  </h4>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-foreground">
                    {qualityAnalysis.problems.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {qualityAnalysis.suggestions.length > 0 ? (
                <div className="space-y-1">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("issueQuality.sections.suggestions", { ns: "issues", defaultValue: "Suggestions" })}
                  </h4>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-foreground">
                    {qualityAnalysis.suggestions.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {qualityAnalysis.missingFields.length > 0 ? (
                <div className="space-y-1">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("issueQuality.sections.missingFields", { ns: "issues", defaultValue: "Missing fields" })}
                  </h4>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-foreground">
                    {qualityAnalysis.missingFields.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {qualityAnalysis.recommendation ? (
                <div className="space-y-1">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("issueQuality.sections.recommendation", { ns: "issues", defaultValue: "Recommendation" })}
                  </h4>
                  <p className="text-xs text-foreground">{qualityAnalysis.recommendation}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-md border border-border p-3">
            <MarkdownBody className="prose prose-sm max-w-none dark:prose-invert" softBreaks={false}>
              {draftBody}
            </MarkdownBody>
          </div>
        </div>
      )}

      {isDirty && !isEditing ? (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-300">
          <RefreshCw className="h-3.5 w-3.5" />
          {t("issueQuality.unsavedNotice", {
            ns: "issues",
            defaultValue: "You have unsaved changes. Switch to edit mode and save to persist this analysis on the issue.",
          })}
        </div>
      ) : null}
    </section>
  );
}
