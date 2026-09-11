import { useEffect, useRef, useState } from "react";
import type { AiConnectionLoginIntent, LocalAiLoginAttempt } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";

/** Every authentication host uses the same isolated terminal-login lifecycle. */
export function useLocalAiLogin(companyId: string | null, intent: AiConnectionLoginIntent, enabled: boolean) {
  const isolated = intent.provider === "openai" || intent.provider === "xai";
  const active = Boolean(companyId && enabled && isolated);
  const [attempt, setAttempt] = useState<LocalAiLoginAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const latestIntent = useRef(intent);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef<{ key: string; companyId: string; request: Promise<LocalAiLoginAttempt> } | null>(null);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelCurrent() {
    const previous = current.current;
    current.current = null;
    if (previous) pending.current = previous.request
      .then((result) => aiConnectionsApi.cancelLocalLogin(previous.companyId, result.sessionId)).catch(() => {});
  }
  latestIntent.current = intent;
  // Renaming the account does not restart sign-in; access/target changes do.
  const target = JSON.stringify({ ...intent, name: undefined });
  useEffect(() => {
    setAttempt(null);
    setError(null);
    const key = JSON.stringify([companyId, target, generation]);
    if (!active || !companyId) { cancelCurrent(); return; }
    let cancelled = false;
    if (current.current?.key !== key) {
      cancelCurrent();
      const input = latestIntent.current;
      const request = pending.current.then(() => aiConnectionsApi.startLocalLogin(companyId, input));
      current.current = { key, companyId, request };
      pending.current = request.catch(() => {});
    }
    const request = current.current.request;
    void request.then((result) => {
      if (!cancelled) setAttempt(result);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not prepare local sign-in.");
    });
    return () => { cancelled = true; };
  }, [companyId, active, target, generation]);
  useEffect(() => {
    if (unmountTimer.current) clearTimeout(unmountTimer.current);
    // React StrictMode replays effects on mount. Cancelling during that replay
    // would destroy a resumed login (and any credential just written to it).
    // Only a real unmount cancels; access changes/retries cancel synchronously above.
    return () => { unmountTimer.current = setTimeout(cancelCurrent, 0); };
  }, []);
  return {
    command: attempt?.command,
    preparing: active && !attempt && !error,
    error,
    retry: () => setGeneration((value) => value + 1),
    connect: (input = intent) => {
      if (!companyId) throw new Error("Choose a company before connecting.");
      if (isolated && !attempt) throw new Error("Prepare local sign-in before connecting.");
      return aiConnectionsApi.connectLocal(companyId, { ...input, ...(attempt ? { localSessionId: attempt.sessionId } : {}) });
    },
  };
}
