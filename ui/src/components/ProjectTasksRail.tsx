import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deriveExternalLinkTitle,
  isAllowedStoredLinkUrl,
  isAppleNotesLinkUrl,
  isHttpUrl,
  type ContextSourceStatus,
  type ProjectQuickLink,
  type ProjectQuickLinkPreview,
} from "@paperclipai/shared";
import { Check, ExternalLink, FileText, ImageIcon, Link2, Loader2, Pencil, Plus, StickyNote, Target, Trash2, X } from "lucide-react";
import { projectContextApi } from "../api/projectContext";
import { projectQuickLinksApi } from "../api/projectQuickLinks";
import { AppleNotesLinkHelp } from "./AppleNotesLinkHelp";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function stripMarkdown(value: string) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_#>~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hostFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return value;
  }
}

function statusLabel(status: ContextSourceStatus) {
  if (status === "ready") return "Ready";
  if (status === "syncing") return "Syncing";
  if (status === "error") return "Error";
  return "Disabled";
}

function statusTone(status: ContextSourceStatus) {
  if (status === "ready") return "bg-emerald-500";
  if (status === "syncing") return "bg-sky-400";
  if (status === "error") return "bg-red-400";
  return "bg-muted-foreground/50";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const QUICK_LINK_URL_ERROR = "Paste a valid http(s), iCloud Notes, or Apple Notes app link.";
const APPLE_NOTES_URL_ERROR = "Paste an iCloud Notes link or Apple Notes app deep link.";

type QuickLinkFormInput = {
  title?: string;
  url: string;
  siteName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  faviconUrl?: string | null;
};

type QuickLinkFormMode = "generic" | "apple-note";

function previewMetadata(preview: ProjectQuickLinkPreview | null) {
  if (!preview) return {};
  return {
    siteName: preview.siteName,
    description: preview.description,
    imageUrl: preview.imageUrl,
    faviconUrl: preview.faviconUrl,
  };
}

function QuickLinkForm({
  initialTitle = "",
  initialUrl = "",
  initialPreview = null,
  submitLabel,
  isPending,
  onPreview,
  onSubmit,
  onCancel,
  mode = "generic",
}: {
  initialTitle?: string;
  initialUrl?: string;
  initialPreview?: ProjectQuickLinkPreview | null;
  submitLabel: string;
  isPending: boolean;
  onPreview: (url: string) => Promise<ProjectQuickLinkPreview>;
  onSubmit: (input: QuickLinkFormInput) => void;
  onCancel?: () => void;
  mode?: QuickLinkFormMode;
}) {
  const [title, setTitle] = useState(initialTitle || (mode === "apple-note" ? "Apple Note" : ""));
  const [url, setUrl] = useState(initialUrl);
  const [titleTouched, setTitleTouched] = useState(false);
  const [preview, setPreview] = useState<ProjectQuickLinkPreview | null>(initialPreview);
  const [previewUrl, setPreviewUrl] = useState(initialPreview?.url ?? initialUrl);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const previewRequestId = useRef(0);
  const trimmedUrl = url.trim();
  const previewHost = preview?.siteName ?? (preview ? hostFromUrl(preview.url) : null);
  const namePlaceholder = mode === "apple-note" ? "Apple Note" : "Name";
  const urlPlaceholder = mode === "apple-note" ? "Paste iCloud Notes or app link..." : "https://...";

  const runPreview = useCallback(async (candidateUrl = url) => {
    const nextUrl = candidateUrl.trim();
    if (!nextUrl || previewPending || previewUrl === nextUrl) return;
    if (!isHttpUrl(nextUrl) || isAppleNotesLinkUrl(nextUrl)) {
      setPreview(null);
      setPreviewUrl("");
      setPreviewError(null);
      return;
    }
    const requestId = previewRequestId.current + 1;
    previewRequestId.current = requestId;
    setPreviewPending(true);
    setPreviewError(null);
    try {
      const nextPreview = await onPreview(nextUrl);
      if (previewRequestId.current !== requestId) return;
      setPreview(nextPreview);
      setPreviewUrl(nextUrl);
      if ((!titleTouched || !title.trim()) && nextPreview.title) {
        setTitle(nextPreview.title);
      }
    } catch (error) {
      if (previewRequestId.current !== requestId) return;
      setPreview(null);
      setPreviewUrl("");
      setPreviewError(errorMessage(error, "Could not fetch link details."));
    } finally {
      if (previewRequestId.current === requestId) setPreviewPending(false);
    }
  }, [onPreview, previewPending, previewUrl, title, titleTouched, url]);

  const submit = () => {
    if (!trimmedUrl) return;
    if (mode === "apple-note" ? !isAppleNotesLinkUrl(trimmedUrl) : !isAllowedStoredLinkUrl(trimmedUrl)) {
      setFormError(mode === "apple-note" ? APPLE_NOTES_URL_ERROR : QUICK_LINK_URL_ERROR);
      return;
    }
    const trimmedTitle = title.trim();
    onSubmit({
      title: trimmedTitle || (mode === "apple-note" ? deriveExternalLinkTitle(trimmedUrl) : undefined),
      url: trimmedUrl,
      ...previewMetadata(preview),
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2">
      <Input
        value={title}
        onChange={(event) => {
          setTitleTouched(true);
          setTitle(event.target.value);
        }}
        placeholder={namePlaceholder}
        className="h-8 text-xs"
        aria-label="Quick link name"
      />
      <Input
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          if (preview && event.target.value.trim() !== previewUrl) {
            setPreview(null);
          }
          setPreviewError(null);
          setFormError(null);
        }}
        onBlur={() => {
          void runPreview();
        }}
        onPaste={(event) => {
          const input = event.currentTarget;
          window.setTimeout(() => {
            void runPreview(input.value);
          }, 0);
        }}
        placeholder={urlPlaceholder}
        className="h-8 text-xs"
        aria-label="Quick link URL"
        aria-invalid={Boolean(formError)}
      />
      {mode === "apple-note" ? (
        <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
          <StickyNote className="h-3 w-3 shrink-0 text-amber-500" />
          Apple Note
        </div>
      ) : null}
      {previewPending ? (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Fetching link details...
        </p>
      ) : previewError ? (
        <p className="px-1 text-xs text-destructive">{previewError}</p>
      ) : preview ? (
        <div className="flex gap-2 rounded-md border border-border/70 bg-background/80 p-2">
          {preview.faviconUrl ? (
            <img src={preview.faviconUrl} alt="" className="mt-0.5 h-4 w-4 shrink-0 rounded-sm" />
          ) : (
            <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{preview.title}</p>
            {previewHost ? <p className="truncate text-[11px] text-muted-foreground">{previewHost}</p> : null}
            {preview.description ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{preview.description}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {formError ? <p className="px-1 text-xs text-destructive">{formError}</p> : null}
      <div className="flex items-center justify-end gap-1.5">
        {onCancel ? (
          <Button type="button" variant="ghost" size="xs" className="h-7 px-2" onClick={onCancel}>
            <X className="h-3 w-3" />
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          className="h-7 px-2"
          disabled={!trimmedUrl || isPending || previewPending}
          onClick={submit}
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function QuickLinkRow({
  link,
  editing,
  isPending,
  onEdit,
  onCancelEdit,
  onSave,
  onRemove,
}: {
  link: ProjectQuickLink;
  editing: boolean;
  isPending: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (input: QuickLinkFormInput) => void;
  onRemove: () => void;
}) {
  const isAppleNote = isAppleNotesLinkUrl(link.url);
  const preview = useMemo<ProjectQuickLinkPreview | null>(() => {
    if (!link.siteName && !link.description && !link.imageUrl && !link.faviconUrl) return null;
    return {
      url: link.url,
      title: link.title,
      siteName: link.siteName,
      description: link.description,
      imageUrl: link.imageUrl,
      faviconUrl: link.faviconUrl,
    };
  }, [link.description, link.faviconUrl, link.imageUrl, link.siteName, link.title, link.url]);

  if (editing) {
    return (
      <QuickLinkForm
        initialTitle={link.title}
        initialUrl={link.url}
        initialPreview={preview}
        submitLabel="Save"
        isPending={isPending}
        onPreview={(url) => projectQuickLinksApi.preview(link.companyId, link.projectId, { url })}
        onSubmit={onSave}
        onCancel={onCancelEdit}
      />
    );
  }

  return (
    <div className="group/link flex items-start gap-2 rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-muted/20">
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 gap-2 text-sm text-foreground no-underline"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background">
          {isAppleNote ? (
            <StickyNote className="h-3.5 w-3.5 text-amber-500" />
          ) : link.faviconUrl ? (
            <img src={link.faviconUrl} alt="" className="h-4 w-4 rounded-sm" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-2">
          <span className="min-w-0">
            <span className="block truncate">{link.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {isAppleNote ? "Apple Note" : link.siteName ?? hostFromUrl(link.url)}
            </span>
            {link.description ? (
              <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-muted-foreground">{link.description}</span>
            ) : null}
          </span>
          {link.imageUrl ? (
            <span className="flex h-12 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-muted/30">
              <img src={link.imageUrl} alt="" className="h-full w-full object-cover" />
            </span>
          ) : preview ? (
            <span className="hidden h-12 w-14 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/20 sm:flex">
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
            </span>
          ) : null}
        </span>
      </a>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/link:opacity-100 group-focus-within/link:opacity-100">
        <Button type="button" variant="ghost" size="icon-xs" className="h-7 w-7" onClick={onEdit} aria-label={`Edit ${link.title}`}>
          <Pencil className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          disabled={isPending}
          aria-label={`Remove ${link.title}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export function ProjectTasksRail({
  companyId,
  projectId,
  projectRef,
  placement = "rail",
}: {
  companyId: string;
  projectId: string;
  projectRef: string;
  placement?: "rail" | "top";
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const quickLinksKey = queryKeys.projects.quickLinks(companyId, projectId);
  const contextKey = queryKeys.projects.context(companyId, projectId);
  const [addingMode, setAddingMode] = useState<QuickLinkFormMode | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const quickLinksQuery = useQuery({
    queryKey: quickLinksKey,
    queryFn: () => projectQuickLinksApi.list(companyId, projectId),
  });

  const contextQuery = useQuery({
    queryKey: contextKey,
    queryFn: () => projectContextApi.overview(companyId, projectId),
  });

  const invalidateQuickLinks = () => queryClient.invalidateQueries({ queryKey: quickLinksKey });

  const createQuickLink = useMutation({
    mutationFn: (input: QuickLinkFormInput) =>
      projectQuickLinksApi.create(companyId, projectId, input),
    onSuccess: () => {
      setAddingMode(null);
      invalidateQuickLinks();
      pushToast({ title: "Quick link added", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: errorMessage(error, "Failed to add quick link"), tone: "error" });
    },
  });

  const updateQuickLink = useMutation({
    mutationFn: ({ linkId, input }: { linkId: string; input: QuickLinkFormInput }) =>
      projectQuickLinksApi.update(companyId, projectId, linkId, input),
    onSuccess: () => {
      setEditingId(null);
      invalidateQuickLinks();
      pushToast({ title: "Quick link saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: errorMessage(error, "Failed to save quick link"), tone: "error" });
    },
  });

  const removeQuickLink = useMutation({
    mutationFn: (linkId: string) => projectQuickLinksApi.remove(companyId, projectId, linkId),
    onSuccess: () => {
      invalidateQuickLinks();
      pushToast({ title: "Quick link removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: errorMessage(error, "Failed to remove quick link"), tone: "error" });
    },
  });

  const quickLinks = quickLinksQuery.data ?? [];
  const context = contextQuery.data;
  const goalExcerpt = useMemo(() => {
    const stripped = stripMarkdown(context?.profile.goalMarkdown ?? "");
    return stripped ? stripped.slice(0, 220) : "";
  }, [context?.profile.goalMarkdown]);
  const instructionsExcerpt = useMemo(() => {
    const stripped = stripMarkdown(context?.profile.instructionsMarkdown ?? "");
    return stripped ? stripped.slice(0, 220) : "";
  }, [context?.profile.instructionsMarkdown]);
  const sourceStatusCounts = useMemo(() => {
    const counts = new Map<ContextSourceStatus, number>();
    for (const source of context?.sources ?? []) {
      counts.set(source.status, (counts.get(source.status) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [context?.sources]);
  const skillKeys = context?.profile.defaultSkillKeys ?? [];
  const isTopPlacement = placement === "top";

  return (
    <aside
      className={cn(
        isTopPlacement
          ? "grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]"
          : "space-y-3 xl:sticky xl:top-4",
      )}
    >
      <section className="min-w-0 rounded-lg border border-border bg-card p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-sm font-semibold">Quick Links</h3>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AppleNotesLinkHelp />
            <Button
              type="button"
              variant={addingMode === "apple-note" ? "secondary" : "outline"}
              size="xs"
              className="h-7 px-2"
              onClick={() => setAddingMode((value) => value === "apple-note" ? null : "apple-note")}
              aria-label="Add Apple Note"
              title="Add Apple Note"
            >
              <StickyNote className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Apple Note</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7 shrink-0"
              onClick={() => setAddingMode((value) => value === "generic" ? null : "generic")}
              aria-label="Add quick link"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          {quickLinksQuery.isLoading ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">Loading links...</p>
          ) : quickLinksQuery.error ? (
            <p className="px-2 py-2 text-sm text-destructive">{quickLinksQuery.error.message}</p>
          ) : quickLinks.length > 0 ? (
            quickLinks.map((link) => (
              <QuickLinkRow
                key={link.id}
                link={link}
                editing={editingId === link.id}
                isPending={updateQuickLink.isPending || removeQuickLink.isPending}
                onEdit={() => setEditingId(link.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={(input) => updateQuickLink.mutate({ linkId: link.id, input })}
                onRemove={() => removeQuickLink.mutate(link.id)}
              />
            ))
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
              onClick={() => setAddingMode("generic")}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              Add link
            </button>
          )}

          {addingMode ? (
            <QuickLinkForm
              mode={addingMode}
              submitLabel="Add"
              isPending={createQuickLink.isPending}
              onPreview={(url) => projectQuickLinksApi.preview(companyId, projectId, { url })}
              onSubmit={(input) => createQuickLink.mutate(input)}
              onCancel={() => setAddingMode(null)}
            />
          ) : null}
        </div>
      </section>

      <Link
        to={`/projects/${projectRef}/context`}
        className={cn(
          "block min-w-0 rounded-lg border border-border bg-card p-3 text-inherit no-underline transition-colors",
          "hover:border-border/80 hover:bg-accent/20",
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-sm font-semibold">Context Overview</h3>
          </div>
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </div>

        {contextQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading context...</p>
        ) : contextQuery.error ? (
          <p className="text-sm text-destructive">{contextQuery.error.message}</p>
        ) : context ? (
          <div className="space-y-3">
            {goalExcerpt ? (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Target className="h-3.5 w-3.5 shrink-0" />
                  Project Goal
                </div>
                <p className="line-clamp-3 text-sm leading-5 text-muted-foreground">{goalExcerpt}</p>
              </div>
            ) : null}

            {instructionsExcerpt ? (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  Instructions
                </div>
                <p className="line-clamp-4 text-sm leading-5 text-muted-foreground">{instructionsExcerpt}</p>
              </div>
            ) : !goalExcerpt ? (
              <p className="text-sm text-muted-foreground">No project goal or instructions yet.</p>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">{skillKeys.length} skills</Badge>
              <Badge variant="outline">{context.sources.length} sources</Badge>
              {context.profile.retrievalEnabled ? <Badge variant="secondary">Retrieval on</Badge> : <Badge variant="outline">Retrieval off</Badge>}
            </div>

            {skillKeys.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {skillKeys.slice(0, 3).map((skillKey) => (
                  <span key={skillKey} className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {skillKey}
                  </span>
                ))}
                {skillKeys.length > 3 ? (
                  <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    +{skillKeys.length - 3}
                  </span>
                ) : null}
              </div>
            ) : null}

            {sourceStatusCounts.length > 0 ? (
              <div className="space-y-1">
                {sourceStatusCounts.map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone(status)}`} />
                      {statusLabel(status)}
                    </span>
                    <span className="tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Link>
    </aside>
  );
}
