import { useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueLink } from "@paperclipai/shared";
import { ExternalLink, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { issuesApi } from "../api/issues";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  try {
    const url = new URL(link.url);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return link.url;
  }
}

function optimisticLink(issue: Issue, url: string, position: number): IssueLink {
  const now = new Date();
  return {
    id: `optimistic:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    companyId: issue.companyId,
    issueId: issue.id,
    url,
    title: null,
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
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
    mutationFn: (url: string) => issuesApi.createLink(issue.id, { url }),
    onMutate: async (url) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueLink[]>(queryKey) ?? [];
      updateLinksCache((current) => [...current, optimisticLink(issue, url, nextPosition)]);
      setDraftUrl("");
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
    mutationFn: ({ id, title }: { id: string; title: string | null }) =>
      issuesApi.updateLink(id, { title }),
    onMutate: async ({ id, title }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueLink[]>(queryKey) ?? [];
      updateLinksCache((current) =>
        current.map((link) => link.id === id ? { ...link, title, updatedAt: new Date() } : link),
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
    createLink.mutate(url);
  };

  const saveEditing = () => {
    if (!editingId) return;
    const title = editingTitle.trim();
    const link = links.find((candidate) => candidate.id === editingId);
    setEditingId(null);
    setEditingTitle("");
    if (!link) return;
    updateLink.mutate({ id: link.id, title: title || null });
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
    }
  };

  return (
    <section className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h3 className="text-sm font-medium">Links</h3>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{links.length}</span>
      </div>

      <div className="space-y-1">
        {links.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No links
          </div>
        ) : (
          links.map((link) => {
            const isEditing = editingId === link.id;
            return (
              <div
                key={link.id}
                className="group flex min-h-8 items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/30"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {isEditing ? (
                  <Input
                    value={editingTitle}
                    onChange={(evt) => setEditingTitle(evt.target.value)}
                    onBlur={saveEditing}
                    onKeyDown={handleEditKeyDown}
                    autoFocus
                    className="h-7 flex-1 text-sm"
                    aria-label="Link title"
                  />
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
                    }}
                  >
                    {linkLabel(link)}
                  </a>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "h-6 w-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100",
                    isEditing && "opacity-100",
                  )}
                  onClick={() => {
                    setEditingId(link.id);
                    setEditingTitle(link.title ?? linkLabel(link));
                  }}
                  title="Edit link title"
                  aria-label="Edit link title"
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
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draftUrl}
          onChange={(evt) => setDraftUrl(evt.target.value)}
          onKeyDown={handleDraftKeyDown}
          placeholder="Paste link..."
          aria-label="New link URL"
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
    </section>
  );
}
