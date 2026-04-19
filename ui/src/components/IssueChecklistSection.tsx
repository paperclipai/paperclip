import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueChecklistItem } from "@paperclipai/shared";
import { ListChecks, Plus, Trash2 } from "lucide-react";
import { issuesApi } from "../api/issues";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

function checklistTimestamp(value: Date | string | null) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortChecklistItems(items: IssueChecklistItem[]) {
  return [...items].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    const createdDiff = checklistTimestamp(a.createdAt) - checklistTimestamp(b.createdAt);
    return createdDiff || a.id.localeCompare(b.id);
  });
}

function optimisticChecklistItem(issue: Issue, title: string, position: number): IssueChecklistItem {
  const now = new Date();
  return {
    id: `optimistic:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    companyId: issue.companyId,
    issueId: issue.id,
    title,
    position,
    completedAt: null,
    completedByAgentId: null,
    completedByUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function IssueChecklistSection({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const hideCompletedId = useId();
  const [draftTitle, setDraftTitle] = useState("");
  const [hideCompleted, setHideCompleted] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const queryKey = queryKeys.issues.checklistItems(issue.id);

  const { data: rawItems = [] } = useQuery({
    queryKey,
    queryFn: () => issuesApi.listChecklistItems(issue.id),
    initialData: issue.checklistItems ?? [],
  });

  const items = useMemo(() => sortChecklistItems(rawItems), [rawItems]);
  const completedCount = items.filter((item) => item.completedAt).length;
  const completionPercent = items.length > 0 ? Math.round((completedCount / items.length) * 100) : 0;
  const visibleItems = useMemo(
    () => hideCompleted ? items.filter((item) => !item.completedAt) : items,
    [hideCompleted, items],
  );
  const nextPosition = items.reduce((max, item) => Math.max(max, item.position), -1) + 1;

  const updateChecklistCache = (updater: (current: IssueChecklistItem[]) => IssueChecklistItem[]) => {
    queryClient.setQueryData<IssueChecklistItem[]>(queryKey, (current = []) => sortChecklistItems(updater(current)));
  };

  const showError = (title: string, err: unknown) => {
    pushToast({
      title,
      body: err instanceof Error ? err.message : "Unable to save checklist changes",
      tone: "error",
    });
  };

  const createItem = useMutation({
    mutationFn: (title: string) => issuesApi.createChecklistItem(issue.id, { title }),
    onMutate: async (title) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueChecklistItem[]>(queryKey) ?? [];
      updateChecklistCache((current) => [...current, optimisticChecklistItem(issue, title, nextPosition)]);
      setDraftTitle("");
      return { previous };
    },
    onSuccess: (created) => {
      updateChecklistCache((current) => [
        ...current.filter((item) => !item.id.startsWith("optimistic:")),
        created,
      ]);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
    onError: (err, _title, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? []);
      showError("Checklist item was not added", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const updateItem = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string; completed?: boolean; position?: number } }) =>
      issuesApi.updateChecklistItem(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueChecklistItem[]>(queryKey) ?? [];
      updateChecklistCache((current) =>
        current.map((item) => {
          if (item.id !== id) return item;
          return {
            ...item,
            ...(data.title !== undefined ? { title: data.title } : {}),
            ...(data.position !== undefined ? { position: data.position } : {}),
            ...(data.completed !== undefined ? { completedAt: data.completed ? new Date() : null } : {}),
            updatedAt: new Date(),
          };
        }),
      );
      return { previous };
    },
    onSuccess: (updated) => {
      updateChecklistCache((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
    onError: (err, _variables, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? []);
      showError("Checklist item was not updated", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const deleteItem = useMutation({
    mutationFn: (id: string) => issuesApi.deleteChecklistItem(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueChecklistItem[]>(queryKey) ?? [];
      updateChecklistCache((current) => current.filter((item) => item.id !== id));
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    },
    onError: (err, _id, context) => {
      queryClient.setQueryData(queryKey, context?.previous ?? []);
      showError("Checklist item was not deleted", err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const submitDraft = () => {
    const title = draftTitle.trim();
    if (!title || createItem.isPending) return;
    createItem.mutate(title);
  };

  const startEditing = (item: IssueChecklistItem) => {
    setEditingId(item.id);
    setEditingTitle(item.title);
  };

  const saveEditing = () => {
    if (!editingId) return;
    const title = editingTitle.trim();
    const item = items.find((candidate) => candidate.id === editingId);
    setEditingId(null);
    setEditingTitle("");
    if (!item || !title || title === item.title) return;
    updateItem.mutate({ id: item.id, data: { title } });
  };

  const handleDraftKeyDown = (evt: KeyboardEvent<HTMLInputElement>) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      submitDraft();
    }
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
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="h-4 w-4 text-muted-foreground shrink-0" />
          <h3 className="text-sm font-medium">Checklist</h3>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {completedCount}/{items.length}
        </span>
      </div>

      {items.length > 0 && (
        <>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Checklist progress"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={completedCount}
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${completionPercent}%` }}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{completionPercent}% complete</span>
            {completedCount > 0 && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={hideCompletedId}
                  checked={hideCompleted}
                  onCheckedChange={(checked) => setHideCompleted(checked === true)}
                  aria-label="Hide checked checklist items"
                />
                <label
                  htmlFor={hideCompletedId}
                  className="cursor-pointer select-none text-xs text-muted-foreground"
                >
                  Hide checked
                </label>
              </div>
            )}
          </div>
        </>
      )}

      <div className="space-y-1">
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            No checklist items
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
            All checked items are hidden
          </div>
        ) : (
          visibleItems.map((item) => {
            const completed = Boolean(item.completedAt);
            const isEditing = editingId === item.id;
            return (
              <div
                key={item.id}
                className="group flex min-h-8 items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/30"
              >
                <Checkbox
                  checked={completed}
                  onCheckedChange={(checked) =>
                    updateItem.mutate({ id: item.id, data: { completed: checked === true } })}
                  aria-label={completed ? "Mark checklist item incomplete" : "Mark checklist item complete"}
                />
                {isEditing ? (
                  <Input
                    value={editingTitle}
                    onChange={(evt) => setEditingTitle(evt.target.value)}
                    onBlur={saveEditing}
                    onKeyDown={handleEditKeyDown}
                    className="h-7 flex-1 px-2 text-sm"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate text-left text-sm",
                      completed && "text-muted-foreground line-through",
                    )}
                    onClick={() => startEditing(item)}
                    title={item.title}
                  >
                    {item.title}
                  </button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => deleteItem.mutate(item.id)}
                  title="Delete checklist item"
                  aria-label="Delete checklist item"
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
          value={draftTitle}
          onChange={(evt) => setDraftTitle(evt.target.value)}
          onKeyDown={handleDraftKeyDown}
          placeholder="Add checklist item..."
          className="h-8 text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shadow-none"
          onClick={submitDraft}
          disabled={!draftTitle.trim() || createItem.isPending}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </section>
  );
}
