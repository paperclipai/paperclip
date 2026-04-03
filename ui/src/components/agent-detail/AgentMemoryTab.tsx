import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentMemoryApi, type AgentMemoryEntry } from "../../api/agentMemory";
import { queryKeys } from "../../lib/queryKeys";
import { cn, relativeTime } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MEMORY_TYPES,
  MEMORY_TYPE_LABELS,
  type MemoryType,
} from "@ironworksai/shared";
import { Brain, ChevronDown, ChevronRight, Plus, X } from "lucide-react";

const memoryTypeColors: Record<string, string> = {
  episodic: "bg-violet-500/10 text-violet-600 dark:text-violet-400 ring-violet-500/20",
  semantic: "bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-blue-500/20",
  procedural: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/20",
};

function MemoryCard({
  entry,
  onDelete,
  isDeleting,
}: {
  entry: AgentMemoryEntry;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = entry.content;
  const isLong = content.length > 200;

  return (
    <div className="border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
              memoryTypeColors[entry.memoryType] ?? "bg-muted text-muted-foreground ring-border",
            )}
          >
            {(MEMORY_TYPE_LABELS as Record<string, string>)[entry.memoryType] ?? entry.memoryType}
          </span>
          {entry.category && (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground ring-1 ring-inset ring-border">
              {entry.category}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-muted-foreground">
            {relativeTime(entry.createdAt)}
          </span>
          <button
            onClick={onDelete}
            disabled={isDeleting}
            className="text-muted-foreground hover:text-destructive transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="text-sm">
        {isLong && !expanded ? (
          <>
            <p className="text-foreground/90">{content.slice(0, 200)}...</p>
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1"
            >
              <ChevronRight className="h-3 w-3" />
              Show more
            </button>
          </>
        ) : (
          <>
            <p className="text-foreground/90 whitespace-pre-wrap">{content}</p>
            {isLong && (
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1"
              >
                <ChevronDown className="h-3 w-3" />
                Show less
              </button>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Confidence</span>
          <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full",
                entry.confidence >= 80 ? "bg-emerald-500" : entry.confidence >= 50 ? "bg-amber-500" : "bg-red-500",
              )}
              style={{ width: `${entry.confidence}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground tabular-nums">{entry.confidence}%</span>
        </div>
        {entry.accessCount > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Accessed {entry.accessCount}x
          </span>
        )}
      </div>
    </div>
  );
}

function AddMemoryForm({
  onSubmit,
  onCancel,
  isPending,
}: {
  onSubmit: (data: { memoryType: string; category: string; content: string }) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [memoryType, setMemoryType] = useState<string>("semantic");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <h4 className="text-sm font-medium">Add Memory Entry</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Type</label>
          <select
            value={memoryType}
            onChange={(e) => setMemoryType(e.target.value)}
            className="w-full text-xs bg-transparent border border-border rounded px-2 py-1.5"
          >
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>{(MEMORY_TYPE_LABELS as Record<string, string>)[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Category</label>
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. project-x, preference"
            className="text-xs h-7"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder="Memory content..."
          className="w-full text-xs bg-transparent border border-border rounded px-2 py-1.5 resize-none"
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSubmit({ memoryType, category, content })}
          disabled={isPending || !content.trim()}
        >
          {isPending ? "Adding..." : "Add"}
        </Button>
      </div>
    </div>
  );
}

export function AgentMemoryTab({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showAddForm, setShowAddForm] = useState(false);

  const { data: memories, isLoading } = useQuery({
    queryKey: queryKeys.agentMemory.list(companyId, agentId, typeFilter !== "all" ? typeFilter : undefined),
    queryFn: () =>
      agentMemoryApi.list(companyId, agentId, typeFilter !== "all" ? { memoryType: typeFilter } : undefined),
    enabled: !!companyId && !!agentId,
  });

  const addMutation = useMutation({
    mutationFn: (data: { memoryType: string; category: string; content: string }) =>
      agentMemoryApi.create(companyId, agentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-memory", companyId, agentId] });
      setShowAddForm(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (entryId: string) => agentMemoryApi.remove(companyId, agentId, entryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-memory", companyId, agentId] });
    },
  });

  const activeEntries = (memories ?? []).filter((m) => !m.archivedAt);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Agent Memory</h3>
          <span className="text-xs text-muted-foreground">
            {activeEntries.length} {activeEntries.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="text-xs bg-transparent border border-border rounded px-1.5 py-1"
          >
            <option value="all">All types</option>
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>{(MEMORY_TYPE_LABELS as Record<string, string>)[t]}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Memory
          </Button>
        </div>
      </div>

      {showAddForm && (
        <AddMemoryForm
          onSubmit={(data) => addMutation.mutate(data)}
          onCancel={() => setShowAddForm(false)}
          isPending={addMutation.isPending}
        />
      )}

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="border border-border rounded-lg p-3 h-24 animate-pulse bg-muted/30" />
          ))}
        </div>
      )}

      {!isLoading && activeEntries.length === 0 && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No memory entries yet. Add one to help this agent remember important context.
        </div>
      )}

      {!isLoading && activeEntries.length > 0 && (
        <div className="space-y-3">
          {activeEntries.map((entry) => (
            <MemoryCard
              key={entry.id}
              entry={entry}
              onDelete={() => deleteMutation.mutate(entry.id)}
              isDeleting={deleteMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
