import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentMemory } from "@paperclipai/shared";
import { agentMemoriesApi } from "../api/agent-memories";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Plus, Pencil, X, Check } from "lucide-react";

const CATEGORY_COLORS: Record<string, string> = {
  pattern: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  preference: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
  decision: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  learning: "bg-green-500/10 text-green-700 dark:text-green-400",
  context: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
  general: "bg-neutral-500/10 text-neutral-700 dark:text-neutral-400",
};

function CategoryBadge({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.general;
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", color)}>
      {category}
    </span>
  );
}

function ImportanceDots({ value }: { value: number }) {
  return (
    <span className="flex gap-0.5" title={`Importance: ${value}/10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            i < value ? "bg-amber-500" : "bg-neutral-200 dark:bg-neutral-700",
          )}
        />
      ))}
    </span>
  );
}

interface AgentMemoriesProps {
  agentId: string;
}

export function AgentMemories({ agentId }: AgentMemoriesProps) {
  const queryClient = useQueryClient();
  const [filterCategory, setFilterCategory] = useState<string | undefined>();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const { data: allMemories = [], isLoading } = useQuery({
    queryKey: queryKeys.agentMemories.list(agentId),
    queryFn: () => agentMemoriesApi.list(agentId),
  });

  const memories = filterCategory
    ? allMemories.filter((m) => m.category === filterCategory)
    : allMemories;

  const createMemory = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentMemoriesApi.create(agentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-memories", agentId] });
      setShowAdd(false);
    },
  });

  const updateMemory = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      agentMemoriesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-memories", agentId] });
      setEditingId(null);
    },
  });

  const deleteMemory = useMutation({
    mutationFn: (id: string) => agentMemoriesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-memories", agentId] });
    },
  });

  const categories = [...new Set(allMemories.map((m) => m.category))].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            className={cn(
              "px-2 py-1 rounded text-xs font-medium transition-colors",
              !filterCategory
                ? "bg-primary text-primary-foreground"
                : "bg-accent/50 hover:bg-accent",
            )}
            onClick={() => setFilterCategory(undefined)}
          >
            All ({allMemories.length})
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={cn(
                "px-2 py-1 rounded text-xs font-medium transition-colors",
                filterCategory === cat
                  ? "bg-primary text-primary-foreground"
                  : "bg-accent/50 hover:bg-accent",
              )}
              onClick={() => setFilterCategory(filterCategory === cat ? undefined : cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>

      {showAdd && (
        <AddMemoryForm
          onSubmit={(data) => createMemory.mutate(data)}
          onCancel={() => setShowAdd(false)}
          isPending={createMemory.isPending}
        />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading memories...</p>}

      {!isLoading && memories.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No memories yet. Agents save memories during heartbeat runs to persist knowledge across sessions.
        </p>
      )}

      <div className="space-y-2">
        {memories.map((memory) => (
          <div
            key={memory.id}
            className="border rounded-lg p-3 space-y-2 bg-card"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <CategoryBadge category={memory.category} />
                <span className="text-xs font-mono text-muted-foreground truncate">
                  {memory.key}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <ImportanceDots value={memory.importance} />
                <button
                  className="p-1 rounded hover:bg-accent/50 text-muted-foreground"
                  onClick={() => {
                    setEditingId(memory.id);
                    setEditContent(memory.content);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  onClick={() => deleteMemory.mutate(memory.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
            {editingId === memory.id ? (
              <div className="flex gap-2">
                <textarea
                  className="flex-1 text-sm bg-background border rounded px-2 py-1 min-h-[60px] resize-y"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
                <div className="flex flex-col gap-1">
                  <button
                    className="p-1 rounded hover:bg-accent/50 text-green-600"
                    onClick={() =>
                      updateMemory.mutate({ id: memory.id, data: { content: editContent } })
                    }
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="p-1 rounded hover:bg-accent/50 text-muted-foreground"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap">{memory.content}</p>
            )}
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>Updated {new Date(memory.updatedAt).toLocaleDateString()}</span>
              {memory.expiresAt && (
                <span>Expires {new Date(memory.expiresAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddMemoryForm({
  onSubmit,
  onCancel,
  isPending,
}: {
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [category, setCategory] = useState("general");
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [importance, setImportance] = useState(5);

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-card">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Category</label>
          <select
            className="w-full text-sm bg-background border rounded px-2 py-1.5"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {["general", "pattern", "preference", "decision", "learning", "context"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Importance (1-10)</label>
          <Input
            type="number"
            min={1}
            max={10}
            value={importance}
            onChange={(e) => setImportance(Number(e.target.value))}
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Key</label>
        <Input
          placeholder="e.g., coding-style, deploy-process"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Content</label>
        <textarea
          className="w-full text-sm bg-background border rounded px-2 py-1.5 min-h-[80px] resize-y"
          placeholder="What should the agent remember?"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!key.trim() || !content.trim() || isPending}
          onClick={() => onSubmit({ category, key, content, importance })}
        >
          {isPending ? "Saving..." : "Save Memory"}
        </Button>
      </div>
    </div>
  );
}
