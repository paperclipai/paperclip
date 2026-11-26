import { useEffect, useRef, useState } from "react";
import { StopVerificationError } from "@/lib/wait-for-stopped-runs";

/** Keeps stop requests independent of draft submission and prevents double clicks. */
export function useComposerStop(onStop?: () => Promise<void>, pending = false, confirmedStoppedRunIds?: ReadonlySet<string>) {
  const inFlight = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<{ message: string; runIds?: readonly string[] } | null>(null);
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
      setFailure({ message: err instanceof Error ? err.message : "Unable to stop. Try again.",
        ...(err instanceof StopVerificationError ? { runIds: err.runIds } : {}) });
    } finally {
      inFlight.current = false;
      setStopping(false);
    }
  }

  return { stop, stopping: stopping || pending, error: failure?.message ?? null };
}
