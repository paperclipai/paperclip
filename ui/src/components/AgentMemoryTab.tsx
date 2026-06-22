import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentMemory, AgentMemoryType } from "@paperclipai/shared";
import { agentMemoriesApi } from "../api/agentMemories";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToastActions } from "../context/ToastContext";

const MEMORY_TYPES: AgentMemoryType[] = ["semantic", "procedural", "lesson", "episodic"];
const TYPE_LABELS: Record<AgentMemoryType, string> = {
  semantic: "Facts",
  procedural: "Procedures",
  lesson: "Lessons",
  episodic: "Episodes",
};
const TYPE_BADGE: Record<AgentMemoryType, "default" | "secondary" | "outline"> = {
  semantic: "default",
  procedural: "secondary",
  lesson: "outline",
  episodic: "outline",
};

function memoriesKey(agentId: string) {
  return ["agents", "memories", agentId] as const;
}

export function AgentMemoryTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [type, setType] = useState<AgentMemoryType>("semantic");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");

  const { data: memories = [], isLoading, error } = useQuery({
    queryKey: memoriesKey(agentId),
    queryFn: () => agentMemoriesApi.list(agentId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: memoriesKey(agentId) });

  const createMutation = useMutation({
    mutationFn: () =>
      agentMemoriesApi.create(agentId, {
        type,
        title: title.trim(),
        body: body.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        confidence: 50,
      }),
    onSuccess: () => {
      setTitle("");
      setBody("");
      setTags("");
      pushToast({ title: "Memory saved", tone: "success" });
      void invalidate();
    },
    onError: (err) => pushToast({ title: "Save failed", body: String(err), tone: "error" }),
  });

  const forgetMutation = useMutation({
    mutationFn: (memoryId: string) => agentMemoriesApi.forget(agentId, memoryId),
    onSuccess: () => {
      pushToast({ title: "Memory forgotten", tone: "info" });
      void invalidate();
    },
    onError: (err) => pushToast({ title: "Forget failed", body: String(err), tone: "error" }),
  });

  const grouped = useMemo(() => {
    const map: Record<AgentMemoryType, AgentMemory[]> = {
      semantic: [],
      procedural: [],
      lesson: [],
      episodic: [],
    };
    for (const m of memories) map[m.type]?.push(m);
    return map;
  }, [memories]);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !createMutation.isPending;

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Add a memory</h3>
          <p className="text-xs text-muted-foreground">
            Durable, per-agent long-term memory. Secrets are redacted before being stored.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {MEMORY_TYPES.map((t) => (
            <Button
              key={t}
              type="button"
              size="sm"
              variant={t === type ? "default" : "outline"}
              onClick={() => setType(t)}
            >
              {TYPE_LABELS[t]}
            </Button>
          ))}
        </div>
        <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          placeholder="What should this agent remember?"
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
        />
        <Input
          placeholder="tags (comma separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <div>
          <Button type="button" disabled={!canSubmit} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? "Saving..." : "Save memory"}
          </Button>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">
          Memories <span className="text-muted-foreground">({memories.length})</span>
        </h3>
        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {error && <p className="text-sm text-destructive">Failed to load memories.</p>}
        {!isLoading && memories.length === 0 && (
          <p className="text-sm text-muted-foreground">No memories yet.</p>
        )}

        {MEMORY_TYPES.map((t) => {
          const items = grouped[t];
          if (!items || items.length === 0) return null;
          return (
            <div key={t} className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {TYPE_LABELS[t]}
              </div>
              {items.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={TYPE_BADGE[t]}>{t}</Badge>
                      <span className="truncate text-sm font-medium text-foreground">{m.title}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{m.body}</p>
                    {m.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {m.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={forgetMutation.isPending}
                    onClick={() => forgetMutation.mutate(m.id)}
                  >
                    Forget
                  </Button>
                </div>
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}
