import { useEffect, useRef, useState } from "react";
import type { AiConnectionLoginIntent, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { describeError } from "@/api/errors";

/** Every authentication host uses the same local credential check and login lifecycle. */
export function useLocalAiLogin(companyId: string | null, intent: AiConnectionLoginIntent, enabled: boolean) {
  const isolated = true;
  const active = Boolean(companyId && enabled);
  const [attempt, setAttempt] = useState<LocalAiLoginAttempt | null>(null);
  const [status, setStatus] = useState<LocalAiLoginStatus["status"] | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const latestIntent = useRef(intent);
  const restartRequested = useRef(false);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef<{ key: string; companyId: string; request: Promise<LocalAiLoginAttempt> } | null>(null);
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
    setStatus(null);
    setAuthorizationUrl(null);
    setCode(null);
    if (!active || !companyId) return;
    let cancelled = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = JSON.stringify([companyId, target, generation]);
    if (isolated && current.current?.key !== key) {
      cancelCurrent();
      const input = { ...latestIntent.current, ...(restartRequested.current ? { restart: true } : {}) };
      restartRequested.current = false;
      const request = pending.current.then(() => aiConnectionsApi.startLocalLogin(companyId, input));
      current.current = { key, companyId, request };
      pending.current = request.catch(() => {});
    }
    const request = isolated ? current.current!.request : Promise.resolve(null);
    async function check() {
      if (checking || cancelled) return;
      checking = true;
      clearTimeout(timer);
      try {
        const result = await request;
        if (cancelled) return;
        setAttempt(result);
        const next = await aiConnectionsApi.checkLocalLogin(companyId!, {
          ...latestIntent.current, ...(result ? { localSessionId: result.sessionId } : {}),
        });
        if (cancelled) return;
        setStatus(next.status);
        setAuthorizationUrl(next.authorizationUrl ?? null);
        setCode(next.code ?? null);
        setError(next.error ?? (next.status === "expired" ? "This sign-in attempt expired. Start sign-in again." : null));
        // Stop polling a verified account. Focus rechecks after the provider
        // browser visit; sign-in never requires repeated Connect clicks.
        if (next.status === "sign_in_required") timer = setTimeout(() => void check(), 5000);
      } catch (cause) {
        if (!cancelled) setError(describeError(cause).body);
      } finally { checking = false; }
    }
    const onFocus = () => { if (!document.hidden) void check(); };
    void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      // Navigation is not cancellation. The server resumes this bounded attempt
      // when the user returns and reaps abandoned attempts after expiry.
    };
  }, [companyId, active, isolated, target, generation]);
  return {
    isolated,
    command: attempt?.command,
    authorizationUrl,
    code,
    status,
    preparing: active && !status && !error,
    error,
    retry: () => { restartRequested.current = true; cancelCurrent(); setGeneration((value) => value + 1); },
    submitCode: async (browserCode: string) => {
      if (!companyId || !attempt) throw new Error("Start sign-in before submitting a code.");
      try {
        await aiConnectionsApi.submitLocalLoginCode(companyId, attempt.sessionId, browserCode);
      } catch (cause) {
        setError("Could not submit the authorization code. Start sign-in again.");
        throw cause;
      }
    },
    connect: (input = intent) => {
      if (!companyId) throw new Error("Choose a company before connecting.");
      if (isolated && !attempt) throw new Error("Prepare local sign-in before connecting.");
      return aiConnectionsApi.connectLocal(companyId, { ...input, ...(attempt ? { localSessionId: attempt.sessionId } : {}) });
    },
  };
}
