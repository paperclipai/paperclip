import { describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { StopVerificationError } from "@/lib/wait-for-stopped-runs";

/** Keeps stop requests independent of draft submission and prevents double clicks. */
export function useComposerStop(onStop?: () => Promise<void>, pending = false, confirmedStoppedRunIds?: ReadonlySet<string>) {
  useTranslation("display");
  const inFlight = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<{ cause: unknown; runIds?: readonly string[] } | null>(null);
  useEffect(() => {
    if (failure?.runIds?.length && failure.runIds.every((id) => confirmedStoppedRunIds?.has(id))) {
      // A queued effect from an older attempt must not clear a newer failure.
      setFailure((current) => current === failure ? null : current);
    }
  }, [failure, confirmedStoppedRunIds]);

  async function stop() {
    if (!onStop || inFlight.current || pending) return;
    inFlight.current = true;
    setStopping(true);
    setFailure(null);
    try {
      await onStop();
    } catch (err) {
      setFailure({ cause: err,
        ...(err instanceof StopVerificationError ? { runIds: err.runIds } : {}) });
    } finally {
      inFlight.current = false;
      setStopping(false);
    }
  }

  return { stop, stopping: stopping || pending, error: failure ? failure.cause instanceof Error ? describeUiError(failure.cause).body : t("display:copy_d007a223526d") : null };
}
