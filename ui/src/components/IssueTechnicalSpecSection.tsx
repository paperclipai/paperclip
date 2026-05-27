import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { Check, Copy, Loader2, RefreshCw, Save, Sparkles, SquarePen, X } from "lucide-react";
import { useTranslation } from "@/i18n";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { useToastActions } from "../context/ToastContext";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const TECHNICAL_SPEC_DOCUMENT_KEY = "technical-spec";

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeUiLanguage(language: string | undefined): "en" | "pt-BR" {
  if (!language) return "en";
  const normalized = language.trim().toLowerCase();
  if (normalized === "pt" || normalized.startsWith("pt-")) return "pt-BR";
  return "en";
}

export function IssueTechnicalSpecSection({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [draftBody, setDraftBody] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const [copied, setCopied] = useState(false);
  const generationControllerRef = useRef<AbortController | null>(null);

  const technicalSpecQuery = useQuery({
    queryKey: queryKeys.issues.document(issue.id, TECHNICAL_SPEC_DOCUMENT_KEY),
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issue.id, TECHNICAL_SPEC_DOCUMENT_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
  });

  const savedDocument = technicalSpecQuery.data;

  const saveMutation = useMutation({
    mutationFn: async () => {
      return issuesApi.upsertDocument(issue.id, TECHNICAL_SPEC_DOCUMENT_KEY, {
        title: t("technicalSpec.documentTitle", { ns: "issues", defaultValue: "Technical Spec" }),
        format: "markdown",
        body: draftBody,
        baseRevisionId: savedDocument?.latestRevisionId ?? null,
      });
    },
    onSuccess: (document) => {
      queryClient.setQueryData(queryKeys.issues.document(issue.id, TECHNICAL_SPEC_DOCUMENT_KEY), document);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      setHasLocalDraft(false);
      setIsEditing(false);
      pushToast({
        title: t("technicalSpec.toasts.savedTitle", { ns: "issues", defaultValue: "Technical spec saved" }),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("technicalSpec.toasts.savedErrorTitle", { ns: "issues", defaultValue: "Failed to save technical spec" }),
        body: error instanceof Error ? error.message : t("technicalSpec.errors.unexpected", { ns: "issues", defaultValue: "Unexpected error." }),
        tone: "error",
      });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      generationControllerRef.current?.abort();
      const controller = new AbortController();
      generationControllerRef.current = controller;
      try {
        return await issuesApi.generateTechnicalSpec(
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
      setHasLocalDraft(true);
      setIsEditing(true);
      pushToast({
        title: t("technicalSpec.toasts.generatedTitle", { ns: "issues", defaultValue: "Technical spec generated" }),
        tone: "success",
      });
    },
    onError: (error) => {
      if (isAbortError(error)) return;
      pushToast({
        title: t("technicalSpec.toasts.generatedErrorTitle", { ns: "issues", defaultValue: "Failed to generate technical spec" }),
        body: error instanceof Error ? error.message : t("technicalSpec.errors.unexpected", { ns: "issues", defaultValue: "Unexpected error." }),
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (hasLocalDraft) return;
    setDraftBody(savedDocument?.body ?? "");
    if (!savedDocument) setIsEditing(false);
  }, [savedDocument?.body, savedDocument?.latestRevisionId, hasLocalDraft, savedDocument]);

  useEffect(() => {
    return () => {
      generationControllerRef.current?.abort();
      generationControllerRef.current = null;
    };
  }, []);

  const canSave = draftBody.trim().length > 0 && !saveMutation.isPending;
  const hasContent = draftBody.trim().length > 0;
  const isDirty = useMemo(() => {
    if (!savedDocument) return hasContent;
    return draftBody !== savedDocument.body;
  }, [draftBody, hasContent, savedDocument]);

  const handleCancelGeneration = () => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    generateMutation.reset();
    pushToast({
      title: t("technicalSpec.toasts.generationCanceledTitle", { ns: "issues", defaultValue: "Generation canceled" }),
      tone: "success",
    });
  };

  const handleCopy = async () => {
    if (!hasContent) return;
    await navigator.clipboard.writeText(draftBody);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    pushToast({
      title: t("technicalSpec.toasts.copiedTitle", { ns: "issues", defaultValue: "Technical spec copied" }),
      tone: "success",
    });
  };

  const handleCancelEdit = () => {
    setDraftBody(savedDocument?.body ?? "");
    setHasLocalDraft(false);
    setIsEditing(false);
  };

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-muted-foreground">
            {t("technicalSpec.title", { ns: "issues", defaultValue: "Technical Spec" })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("technicalSpec.description", {
              ns: "issues",
              defaultValue: "Generate, review, and save a structured technical spec without replacing the issue description.",
            })}
          </p>
          {savedDocument ? (
            <p className="text-[11px] text-muted-foreground">
              {t("technicalSpec.lastSaved", {
                ns: "issues",
                defaultValue: "Last saved {{timeAgo}}",
                timeAgo: relativeTime(savedDocument.updatedAt),
              })}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {generateMutation.isPending ? (
            <Button variant="outline" size="sm" onClick={handleCancelGeneration}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {t("technicalSpec.actions.cancelGeneration", { ns: "issues", defaultValue: "Cancel generation" })}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateMutation.mutate()}
              disabled={technicalSpecQuery.isLoading || saveMutation.isPending}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {hasContent
                ? t("technicalSpec.actions.regenerate", { ns: "issues", defaultValue: "Regenerate spec" })
                : t("technicalSpec.actions.generate", { ns: "issues", defaultValue: "Generate technical spec" })}
            </Button>
          )}

          <Button variant="ghost" size="sm" onClick={handleCopy} disabled={!hasContent}>
            {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-green-500" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
            {t("technicalSpec.actions.copy", { ns: "issues", defaultValue: "Copy spec" })}
          </Button>

          {isEditing ? (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancelEdit} disabled={saveMutation.isPending}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                {t("technicalSpec.actions.cancelEdit", { ns: "issues", defaultValue: "Cancel edit" })}
              </Button>
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!canSave || !isDirty}>
                {saveMutation.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t("technicalSpec.actions.save", { ns: "issues", defaultValue: "Save spec" })}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              disabled={!hasContent || generateMutation.isPending}
            >
              <SquarePen className="mr-1.5 h-3.5 w-3.5" />
              {t("technicalSpec.actions.edit", { ns: "issues", defaultValue: "Edit spec" })}
            </Button>
          )}
        </div>
      </div>

      {generateMutation.isPending ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("technicalSpec.loading", {
            ns: "issues",
            defaultValue: "Generating technical spec from the current issue context...",
          })}
        </div>
      ) : null}

      {generateMutation.error && !isAbortError(generateMutation.error) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("technicalSpec.errors.generate", {
            ns: "issues",
            defaultValue: "Failed to generate technical spec. Please try again.",
          })}
        </div>
      ) : null}

      {technicalSpecQuery.isLoading && !hasLocalDraft ? (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {t("technicalSpec.loadingSaved", {
            ns: "issues",
            defaultValue: "Loading saved technical spec...",
          })}
        </div>
      ) : null}

      {!hasContent ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          {t("technicalSpec.empty", {
            ns: "issues",
            defaultValue: "No technical spec yet. Generate one to start with a structured implementation plan.",
          })}
        </div>
      ) : isEditing ? (
        <Textarea
          value={draftBody}
          onChange={(event) => {
            setDraftBody(event.target.value);
            setHasLocalDraft(true);
          }}
          rows={22}
          className="font-mono text-xs"
          aria-label={t("technicalSpec.editorAriaLabel", {
            ns: "issues",
            defaultValue: "Technical spec editor",
          })}
        />
      ) : (
        <div className="rounded-md border border-border p-3">
          <MarkdownBody className="prose prose-sm max-w-none dark:prose-invert" softBreaks={false}>
            {draftBody}
          </MarkdownBody>
        </div>
      )}

      {isDirty && !isEditing ? (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-300">
          <RefreshCw className="h-3.5 w-3.5" />
          {t("technicalSpec.unsavedNotice", {
            ns: "issues",
            defaultValue: "You have unsaved changes. Switch to edit mode and save to persist this spec on the issue.",
          })}
        </div>
      ) : null}
    </section>
  );
}
