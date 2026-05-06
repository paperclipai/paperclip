import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import type { ExecutionGateView } from "../lib/issue-execution-state";

interface ExecutionPolicyGateProps {
  view: ExecutionGateView;
  onSubmitDecision: (input: {
    decision: "approve" | "request_changes";
    comment: string;
  }) => Promise<void> | void;
  className?: string;
}

export function ExecutionPolicyGate({
  view,
  onSubmitDecision,
  className,
}: ExecutionPolicyGateProps) {
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusedOnceRef = useRef(false);
  const helperId = useId();
  const errorId = useId();

  // Move focus to the comment textarea the first time the gate becomes the
  // active "self" affordance for the viewer. Guarded so we never steal focus
  // on subsequent re-renders while the user is typing elsewhere.
  useEffect(() => {
    if (view.kind === "self" && !focusedOnceRef.current) {
      focusedOnceRef.current = true;
      textareaRef.current?.focus();
    }
    if (view.kind !== "self") {
      focusedOnceRef.current = false;
    }
  }, [view.kind]);

  if (view.kind === "none") return null;

  if (view.kind === "passive") {
    return (
      <span
        className={cn("text-sm", className)}
        data-testid="execution-gate-passive"
      >
        {view.passiveText}
      </span>
    );
  }

  const trimmed = comment.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setComment(event.target.value);
    if (error) setError(null);
  };

  const submit = async (decision: "approve" | "request_changes") => {
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmitDecision({ decision, comment: trimmed });
      setComment("");
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : "Failed to submit decision.";
      setError(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-card/50 p-3",
        className,
      )}
      aria-busy={pending || undefined}
      data-testid="execution-gate-self"
    >
      <div className="text-xs font-medium text-muted-foreground">
        {view.stageLabel} pending with you
      </div>
      <textarea
        ref={textareaRef}
        value={comment}
        onChange={handleChange}
        placeholder={
          view.stageLabel === "Review"
            ? "Add a review note (required)…"
            : "Add an approval note (required)…"
        }
        className="w-full min-h-[64px] resize-y rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${view.stageLabel} comment`}
        aria-required="true"
        aria-describedby={error ? `${helperId} ${errorId}` : helperId}
        data-testid="execution-gate-comment"
      />
      <div
        id={helperId}
        className="text-[11px] text-muted-foreground"
        data-testid="execution-gate-hint"
      >
        Comment is required to submit a decision.
      </div>
      {error && (
        <div
          id={errorId}
          className="text-xs text-destructive"
          role="alert"
          data-testid="execution-gate-error"
        >
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={!canSubmit}
          onClick={() => void submit("approve")}
          data-testid="execution-gate-approve"
        >
          {pending ? "Submitting…" : "Approve"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canSubmit}
          onClick={() => void submit("request_changes")}
          data-testid="execution-gate-request-changes"
        >
          {pending ? "Submitting…" : "Request changes"}
        </Button>
      </div>
      {pending && (
        <span className="sr-only" role="status" data-testid="execution-gate-status">
          Submitting decision…
        </span>
      )}
    </div>
  );
}
