import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { LazyFileEditor } from "./LazyFileEditor";
import { Pencil, Send, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

interface BoardInterventionPanelProps {
  issueId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FILENAME_OPTIONS = [
  { value: "intervention.md", label: "Markdown" },
  { value: "intervention.ts", label: "TypeScript" },
  { value: "intervention.json", label: "JSON" },
  { value: "intervention.js", label: "JavaScript" },
];

export function BoardInterventionPanel({ issueId, open, onOpenChange }: BoardInterventionPanelProps) {
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("intervention.md");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const postComment = useMutation({
    mutationFn: async () => {
      const wrappedBody = filename.endsWith(".md") ? content : `\`\`\`${filename.split(".").pop()}\n${content}\n\`\`\``;
      await issuesApi.addComment(issueId, wrappedBody, false, true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(issueId),
      });
      pushToast({ title: "Intervention posted", tone: "success" });
      setContent("");
      onOpenChange(false);
    },
    onError: () => {
      pushToast({ title: "Failed to post intervention", tone: "error" });
    },
  });

  const handlePost = useCallback(() => {
    if (!content.trim()) return;
    postComment.mutate();
  }, [content, postComment]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl lg:max-w-2xl flex flex-col" showCloseButton>
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Board Intervention
          </SheetTitle>
          <SheetDescription>
            Write code or instructions to redirect the agent. Posted as a comment with interrupt flag.
          </SheetDescription>
        </SheetHeader>

        {/* Language selector */}
        <div className="flex items-center gap-2 px-4 shrink-0">
          <span className="text-xs text-muted-foreground">Language:</span>
          <div className="flex gap-1">
            {FILENAME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={cn(
                  "rounded px-2 py-0.5 text-xs transition-colors",
                  filename === opt.value
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setFilename(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 min-h-0 px-4 overflow-hidden">
          <LazyFileEditor
            filename={filename}
            value={content}
            onChange={setContent}
            className="h-full max-h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            {open && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/[0.08] px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                Human editing
              </span>
            )}
          </div>
          <Button
            size="sm"
            disabled={!content.trim() || postComment.isPending}
            onClick={handlePost}
            className="gap-1.5"
          >
            {postComment.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Post Intervention
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Small button to trigger the intervention panel.
 * Can be placed alongside other run action buttons.
 */
export function InterventionButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/[0.12] dark:text-amber-300",
        className,
      )}
    >
      <Pencil className="h-2.5 w-2.5" />
      Intervene
    </button>
  );
}
