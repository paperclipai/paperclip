import { useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deriveExternalLinkTitle,
  isAllowedStoredLinkUrl,
  isAppleNotesLinkUrl,
  type Issue,
  type IssueLink,
} from "@paperclipai/shared";
import { Check, ExternalLink, Link2, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { issuesApi } from "../api/issues";
import { AppleNotesLinkHelp } from "./AppleNotesLinkHelp";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const LINK_URL_ERROR = "Paste a valid http(s), iCloud Notes, or Apple Notes app link.";
const APPLE_NOTES_URL_ERROR = "Paste an iCloud Notes link or Apple Notes app deep link.";

type CreateLinkInput = {
  url: string;
  title?: string | null;
  source?: "generic" | "apple-note";
};

function linkTimestamp(value: Date | string | null) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortIssueLinks(links: IssueLink[]) {
  return [...links].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    const createdDiff = linkTimestamp(a.createdAt) - linkTimestamp(b.createdAt);
    return createdDiff || a.id.localeCompare(b.id);
  });
}

function linkLabel(link: IssueLink) {
  if (link.title) return link.title;
  return deriveExternalLinkTitle(link.url);
}

function optimisticLink(issue: Issue, url: string, title: string | null, position: number): IssueLink {
  const now = new Date();
  return {
    id: `optimistic:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    companyId: issue.companyId,
    issueId: issue.id,
    url,
    title,
    position,
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function IssueLinksSection({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draftUrl, setDraftUrl] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [appleNoteOpen, setAppleNoteOpen] = useState(false);
  const [appleNoteTitle, setAppleNoteTitle] = useState("Apple Note");
  const [appleNoteUrl, setAppleNoteUrl] = useState("");
  const [appleNoteError, setAppleNoteError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const [editingError, setEditingError] = useState<string | null>(null);
  const queryKey = queryKeys.issues.links(issue.id);

  const { data: rawLinks = [] } = useQuery({
    queryKey,
    queryFn: () => issuesApi.listLinks(issue.id),
    initialData: issue.links ?? [],
  });

  const links = useMemo(() => sortIssueLinks(rawLinks), [rawLinks]);
  const nextPosition = links.reduce((max, link) => Math.max(max, link.position), -1) + 1;

  const updateLinksCache = (updater: (current: IssueLink[]) => IssueLink[]) => {
    queryClient.setQueryData<IssueLink[]>(queryKey, (current = []) => sortIssueLinks(updater(current)));
  };

  const showError = (title: string, err: unknown) => {
    pushToast({
      title,
      body: err instanceof Error ? err.message : "Unable to save task links",
      tone: "error",
    });
  };

  const createLink = useMutation({
    mutationFn: (input: CreateLinkInput) => {
      const payload: { url: string; title?: string | null } = { url: input.url };
      if (input.title !== undefined) payload.title = input.title;
      return issuesApi.createLink(issue.id, payload);
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueLink[]>(queryKey) ?? [];
      updateLinksCache((current) => [
        ...current,
        optimisticLink(issue, input.url, input.title ?? null, nextPosition),
      ]);
      if (input.source === "apple-note") {
        setAppleNoteOpen(false);
        setAppleNoteTitle("Apple Note");
        setAppleNoteUrl("");
        setAppleNoteError(null);
      } else {
        setDraftUrl("");
        setDraftError(null);
      }
      return { previous };
    },
    onSuccess: (created) => {
      updateLinksCache((current) => [
        ...current.filter((link) => !link.id.startsWith("optimistic:")),
        created,
      ]);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
    onError: (err, _url, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? []);
      showError("Link was not added", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const updateLink = useMutation({
    mutationFn: ({ id, title, url }: { id: string; title: string | null; url: string }) =>
      issuesApi.updateLink(id, { title, url }),
    onMutate: async ({ id, title, url }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueLink[]>(queryKey) ?? [];
      updateLinksCache((current) =>
        current.map((link) => link.id === id ? { ...link, title, url, updatedAt: new Date() } : link),
      );
      return { previous };
    },
    onSuccess: (updated) => {
      updateLinksCache((current) => current.map((link) => link.id === updated.id ? updated : link));
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
    onError: (err, _variables, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? []);
      showError("Link was not updated", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteLink = useMutation({
    mutationFn: (id: string) => issuesApi.deleteLink(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueLink[]>(queryKey) ?? [];
      updateLinksCache((current) => current.filter((link) => link.id !== id));
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
    onError: (err, _id, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? []);
      showError("Link was not deleted", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const submitDraft = () => {
    const url = draftUrl.trim();
    if (!url || createLink.isPending) return;
    if (!isAllowedStoredLinkUrl(url)) {
      setDraftError(LINK_URL_ERROR);
      return;
    }
    createLink.mutate({ url, source: "generic" });
  };

  const submitAppleNote = () => {
    const url = appleNoteUrl.trim();
    if (!url || createLink.isPending) return;
    if (!isAppleNotesLinkUrl(url)) {
      setAppleNoteError(APPLE_NOTES_URL_ERROR);
      return;
    }
    createLink.mutate({
      url,
      title: appleNoteTitle.trim() || deriveExternalLinkTitle(url),
      source: "apple-note",
    });
  };

  const saveEditing = () => {
    if (!editingId) return;
    const title = editingTitle.trim();
    const url = editingUrl.trim();
    if (!isAllowedStoredLinkUrl(url)) {
      setEditingError(LINK_URL_ERROR);
      return;
    }
    const link = links.find((candidate) => candidate.id === editingId);
    setEditingId(null);
    setEditingTitle("");
    setEditingUrl("");
    setEditingError(null);
    if (!link) return;
    updateLink.mutate({ id: link.id, title: title || null, url });
  };

  const handleDraftKeyDown = (evt: KeyboardEvent<HTMLInputElement>) => {
    if (evt.key !== "Enter") return;
    evt.preventDefault();
    submitDraft();
  };

  const handleEditKeyDown = (evt: KeyboardEvent<HTMLInputElement>) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      saveEditing();
    }
    if (evt.key === "Escape") {
      evt.preventDefault();
      setEditingId(null);
      setEditingTitle("");
      setEditingUrl("");
      setEditingError(null);
    }
  };

  return (
    <section className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h3 className="text-sm font-medium">Links</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground">{links.length}</span>
          <AppleNotesLinkHelp />
          <Button
            type="button"
            variant={appleNoteOpen ? "secondary" : "outline"}
            size="xs"
            className="h-7 px-2"
            onClick={() => setAppleNoteOpen((value) => !value)}
            title="Add Apple Note"
            aria-label="Add Apple Note"
          >
            <StickyNote className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Apple Note</span>
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        {links.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No links
          </div>
        ) : (
          links.map((link) => {
            const isEditing = editingId === link.id;
            const isAppleNote = isAppleNotesLinkUrl(link.url);
            const LinkIcon = isAppleNote ? StickyNote : ExternalLink;
            return (
              <div
                key={link.id}
                className="group flex min-h-8 items-start gap-2 rounded-md px-2 py-1 hover:bg-accent/30"
              >
                <LinkIcon
                  className={cn(
                    "mt-1 h-3.5 w-3.5 shrink-0",
                    isAppleNote ? "text-amber-500" : "text-muted-foreground",
                  )}
                />
                {isEditing ? (
                  <div className="min-w-0 flex-1 space-y-1">
                    <Input
                      value={editingTitle}
                      onChange={(evt) => setEditingTitle(evt.target.value)}
                      onKeyDown={handleEditKeyDown}
                      autoFocus
                      className="h-7 text-sm"
                      aria-label="Link title"
                    />
                    <Input
                      value={editingUrl}
                      onChange={(evt) => {
                        setEditingUrl(evt.target.value);
                        setEditingError(null);
                      }}
                      onKeyDown={handleEditKeyDown}
                      className="h-7 text-sm"
                      aria-label="Link URL"
                      aria-invalid={Boolean(editingError)}
                    />
                    {editingError ? <p className="px-1 text-xs text-destructive">{editingError}</p> : null}
                  </div>
                ) : (
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate text-sm hover:underline"
                    title={link.url}
                    onDoubleClick={(evt) => {
                      evt.preventDefault();
                      setEditingId(link.id);
                      setEditingTitle(link.title ?? linkLabel(link));
                      setEditingUrl(link.url);
                      setEditingError(null);
                    }}
                  >
                    {linkLabel(link)}
                  </a>
                )}
                {!isEditing && isAppleNote ? (
                  <span className="mt-0.5 hidden shrink-0 rounded-md border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-600 sm:inline-flex">
                    Apple Note
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="h-6 w-6 shrink-0 text-muted-foreground"
                      onClick={saveEditing}
                      title="Save link"
                      aria-label="Save link"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="h-6 w-6 shrink-0 text-muted-foreground"
                      onClick={() => {
                        setEditingId(null);
                        setEditingTitle("");
                        setEditingUrl("");
                        setEditingError(null);
                      }}
                      title="Cancel editing link"
                      aria-label="Cancel editing link"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
                      onClick={() => {
                        setEditingId(link.id);
                        setEditingTitle(link.title ?? linkLabel(link));
                        setEditingUrl(link.url);
                        setEditingError(null);
                      }}
                      title="Edit link"
                      aria-label="Edit link"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                      onClick={() => deleteLink.mutate(link.id)}
                      disabled={deleteLink.isPending}
                      title="Delete link"
                      aria-label="Delete link"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {appleNoteOpen ? (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2">
          <Input
            value={appleNoteTitle}
            onChange={(evt) => setAppleNoteTitle(evt.target.value)}
            placeholder="Apple Note"
            aria-label="Apple Note title"
            className="h-8 text-sm"
          />
          <Input
            value={appleNoteUrl}
            onChange={(evt) => {
              setAppleNoteUrl(evt.target.value);
              setAppleNoteError(null);
            }}
            onKeyDown={(evt) => {
              if (evt.key !== "Enter") return;
              evt.preventDefault();
              submitAppleNote();
            }}
            placeholder="Paste iCloud Notes or app link..."
            aria-label="Apple Note URL"
            aria-invalid={Boolean(appleNoteError)}
            className="h-8 text-sm"
          />
          {appleNoteError ? <p className="px-1 text-xs text-destructive">{appleNoteError}</p> : null}
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 px-2"
              onClick={() => {
                setAppleNoteOpen(false);
                setAppleNoteTitle("Apple Note");
                setAppleNoteUrl("");
                setAppleNoteError(null);
              }}
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              className="h-7 px-2"
              onClick={submitAppleNote}
              disabled={!appleNoteUrl.trim() || createLink.isPending}
            >
              <Check className="h-3 w-3" />
              Add
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Input
            value={draftUrl}
            onChange={(evt) => {
              setDraftUrl(evt.target.value);
              setDraftError(null);
            }}
            onKeyDown={handleDraftKeyDown}
            placeholder="Paste link..."
            aria-label="New link URL"
            aria-invalid={Boolean(draftError)}
            className="h-8 flex-1 text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={submitDraft}
            disabled={!draftUrl.trim() || createLink.isPending}
            title="Add link"
            aria-label="Add link"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {draftError ? <p className="px-1 text-xs text-destructive">{draftError}</p> : null}
      </div>
    </section>
  );
}
