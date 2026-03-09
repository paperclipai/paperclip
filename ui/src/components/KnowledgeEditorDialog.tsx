import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { KnowledgeItem, UpdateKnowledgeItem } from "@paperclipai/shared";
import { knowledgeApi } from "../api/knowledge";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function buildUpdatePayload(
  item: KnowledgeItem,
  values: { title: string; summary: string; body: string; sourceUrl: string },
): UpdateKnowledgeItem {
  if (item.kind === "note") {
    return {
      title: values.title.trim(),
      summary: values.summary.trim() ? values.summary.trim() : null,
      body: values.body.trim(),
    };
  }

  if (item.kind === "url") {
    return {
      title: values.title.trim(),
      summary: values.summary.trim() ? values.summary.trim() : null,
      sourceUrl: values.sourceUrl.trim(),
    };
  }

  return {
    title: values.title.trim(),
    summary: values.summary.trim() ? values.summary.trim() : null,
  };
}

export function KnowledgeEditorDialog({
  item,
  open,
  onOpenChange,
}: {
  item: KnowledgeItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    if (!item || !open) return;
    setTitle(item.title);
    setSummary(item.summary ?? "");
    setBody(item.body ?? "");
    setSourceUrl(item.sourceUrl ?? "");
  }, [item, open]);

  const canSubmit = useMemo(() => {
    if (!item) return false;
    if (!title.trim()) return false;
    if (item.kind === "note") return body.trim().length > 0;
    if (item.kind === "url") return sourceUrl.trim().length > 0;
    return true;
  }, [body, item, sourceUrl, title]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error("Knowledge item is required");
      return knowledgeApi.update(item.id, buildUpdatePayload(item, { title, summary, body, sourceUrl }));
    },
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(updated.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.detail(updated.id) }),
        queryClient.invalidateQueries({ queryKey: ["issues", "knowledge"] }),
      ]);
      pushToast({ title: "Knowledge item updated", tone: "success" });
      onOpenChange(false);
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to update knowledge item",
        tone: "error",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(85vh,720px)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit knowledge</DialogTitle>
          <DialogDescription>
            Update the shared reference so future issue runs use the latest version.
          </DialogDescription>
        </DialogHeader>

        {item ? (
          <div className="grid min-w-0 gap-3">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Title"
              className="min-w-0"
            />
            <Input
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Summary (optional)"
              className="min-w-0"
            />
            {item.kind === "note" ? (
              <Textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Write the reusable note..."
                className="min-h-56 min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              />
            ) : item.kind === "url" ? (
              <Input
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder="https://example.com/reference"
                className="min-w-0"
              />
            ) : (
              <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
                Asset-backed knowledge can update the title and summary here. The linked asset remains unchanged.
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={updateMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => updateMutation.mutate()}
            disabled={!item || !canSubmit || updateMutation.isPending}
          >
            {updateMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
