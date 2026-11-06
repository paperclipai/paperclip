import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";

const pendingCancellations = new Map<string, Promise<unknown>>();

export function useAdapterLoginCancellation(active: boolean, companyId: string, adapterType: string, submittedCode: boolean, sessionId: string | null) {
  const queryClient = useQueryClient();
  const ownerKey = JSON.stringify([companyId, adapterType]);
  const scope = useRef({ active, generation: 0 });
  if (scope.current.active !== active) scope.current = { active, generation: scope.current.generation + 1 };
  const requests = useRef(new Set<Promise<unknown>>());
  const cancelled = useRef(new Map<string, Promise<unknown>>());
  const cancel = useCallback((id: string) => {
    const previous = cancelled.current.get(id);
    if (previous) return previous;
    const request = (submittedCode
      ? agentsApi.cancelClaudeSetupTokenLogin(companyId, id)
      : agentsApi.cancelAdapterAuthLogin(companyId, adapterType, id)).catch(() => {});
    cancelled.current.set(id, request);
    return request;
  }, [companyId, adapterType, submittedCode]);

  const accept = useCallback(<T extends { sessionId: string }>(request: () => Promise<T | null>): Promise<T | null> => {
    const generation = scope.current.generation;
    const result = (async () => {
      await pendingCancellations.get(ownerKey);
      if (!scope.current.active || scope.current.generation !== generation) return null;
      const session = await request();
      if (session && (!scope.current.active || scope.current.generation !== generation)) {
        await cancel(session.sessionId);
        return null;
      }
      return session;
    })();
    requests.current.add(result);
    const forget = () => { requests.current.delete(result); };
    void result.then(forget, forget);
    return result;
  }, [cancel, ownerKey]);

  useEffect(() => {
    if (active) return;
    const keys = submittedCode
      ? [["claude-setup-token-active-session", companyId], ["claude-setup-token-status", companyId], ["claude-setup-token-prompt", companyId]]
      : [["adapter-login-active-session", companyId, adapterType], ["adapter-login-status", companyId, adapterType]];
    for (const queryKey of keys) void queryClient.cancelQueries({ queryKey });
    const cleanup = Promise.allSettled([...requests.current, ...(sessionId ? [cancel(sessionId)] : [])]);
    pendingCancellations.set(ownerKey, cleanup);
    void cleanup.then(() => {
      if (pendingCancellations.get(ownerKey) === cleanup) pendingCancellations.delete(ownerKey);
    });
  }, [active, companyId, adapterType, submittedCode, sessionId, queryClient, cancel, ownerKey]);

  return { accept, isActive: () => scope.current.active };
}
