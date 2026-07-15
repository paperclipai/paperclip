import { useId, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface ExecutionPolicyGateProps {
  stageLabel: "Review" | "Approval";
  onSubmitDecision: (input: {
    status: "done" | "in_progress";
    comment: string;
  }) => Promise<unknown> | unknown;
  className?: string;
}

export function ExecutionPolicyGate({
  stageLabel,
  onSubmitDecision,
  className,
}: ExecutionPolicyGateProps) {
  const [comment, setComment] = useState("");
  const [pendingStatus, setPendingStatus] = useState<"done" | "in_progress" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const helperId = useId();
  const errorId = useId();

  const trimmedComment = comment.trim();
  const pending = pendingStatus !== null;
  const canSubmit = trimmedComment.length > 0 && !pending;

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setComment(event.target.value);
    if (error) setError(null);
  };

  const submit = async (status: "done" | "in_progress") => {
    if (!trimmedComment || pending) return;
    setPendingStatus(status);
    setError(null);
    try {
      await onSubmitDecision({ status, comment: trimmedComment });
      setComment("");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Decision failed. Try again.");
    } finally {
      setPendingStatus(null);
    }
  };

  return (
    <div
      className={cn("flex flex-col gap-2 rounded-md border border-border bg-card/50 p-3", className)}
      aria-busy={pending || undefined}
      data-testid="execution-gate-self"
    >
      <div className="text-xs font-medium text-muted-foreground">
        {stageLabel} pending with you
      </div>
      <Textarea
        value={comment}
        onChange={handleChange}
        placeholder={stageLabel === "Review" ? "Add a review note…" : "Add an approval note…"}
        aria-label={`${stageLabel} note`}
        aria-required="true"
        aria-describedby={error ? `${helperId} ${errorId}` : helperId}
        data-testid="execution-gate-comment"
      />
      <div id={helperId} className="text-xs text-muted-foreground">
        A note is required.
      </div>
      {error ? (
        <div id={errorId} className="text-xs text-destructive" role="alert" data-testid="execution-gate-error">
          {error}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          disabled={!canSubmit}
          onClick={() => void submit("done")}
          data-testid="execution-gate-approve"
        >
          {pendingStatus === "done" ? "Approving…" : "Approve"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          disabled={!canSubmit}
          onClick={() => void submit("in_progress")}
          data-testid="execution-gate-request-changes"
        >
          {pendingStatus === "in_progress" ? "Requesting…" : "Request changes"}
        </Button>
      </div>
      {pending ? <span className="sr-only" role="status">Saving decision…</span> : null}
    </div>
  );
}
