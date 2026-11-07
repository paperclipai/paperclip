import { resolveUiMessage, uiErrorDescriptor, type UiMessageDescriptor } from "@/lib/localized-ui-error";
import { t, useTranslation } from "@/i18n";
import { useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentWorkspaceRetry } from "./WorkspaceBaseRefRecovery";

export function WorkspaceRetryControl() {
  useTranslation("task-components");
  const retry = useCurrentWorkspaceRetry();
  return retry ? <WorkspaceRetryButton key={`${retry.actionId}:${retry.runId}`} {...retry} /> : null;
}

export function WorkspaceRetryButton({ onRetry, unavailableReason }: {
  onRetry: () => Promise<void>;
  unavailableReason: string | null;
}) {
  useTranslation("task-components");
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<UiMessageDescriptor | { raw: string } | null>(null);
  async function retry() {
    if (inFlight.current || requested || unavailableReason) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try { await onRetry(); setRequested(true); }
    catch (cause) { setError(cause instanceof Error ? uiErrorDescriptor(cause) ?? { raw: cause.message } : { key: "final-components-a:couldnTRetryTryAgain_82242183" }); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <div className="flex flex-col items-start gap-2 py-3">
    <Button size="xs" variant="outline" disabled={pending || requested || Boolean(unavailableReason)}
      title={unavailableReason ?? undefined} onClick={() => void retry()}>
      {pending ? <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : <RotateCcw aria-hidden className="size-3" />}
      {pending || requested ? t("task-components:retrying_a16c8b1c") : t("task-components:retry_942087cc")}
    </Button>
    {error ? <p role="alert" className="text-sm text-destructive">{"raw" in error ? error.raw : resolveUiMessage(error)}</p> : null}
  </div>;
}
