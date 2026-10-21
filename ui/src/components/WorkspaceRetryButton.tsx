import { useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentWorkspaceRetry } from "./WorkspaceBaseRefRecovery";

export function WorkspaceRetryControl() {
  const retry = useCurrentWorkspaceRetry();
  return retry ? <WorkspaceRetryButton key={`${retry.actionId}:${retry.runId}`} {...retry} /> : null;
}

export function WorkspaceRetryButton({ onRetry, unavailableReason }: {
  onRetry: () => Promise<void>;
  unavailableReason: string | null;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function retry() {
    if (inFlight.current || requested || unavailableReason) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try { await onRetry(); setRequested(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t retry. Try again."); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="flex flex-col items-start gap-2 py-3">
    <Button size="xs" variant="outline" disabled={pending || requested || Boolean(unavailableReason)}
      title={unavailableReason ?? undefined} onClick={() => void retry()}>
      {pending ? <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : <RotateCcw aria-hidden className="size-3" />}
      {pending || requested ? "Retrying…" : "Retry"}
    </Button>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </div>;
}
