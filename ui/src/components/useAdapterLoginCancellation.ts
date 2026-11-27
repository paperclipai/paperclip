import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AiConnectionLoginIntent } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";

type AdapterLoginTarget = { environmentId: string; aiConnection?: AiConnectionLoginIntent };
type AdapterLoginSession = { sessionId: string; environmentId?: string; aiConnection?: AiConnectionLoginIntent };

function connectionTargetKey(intent?: AiConnectionLoginIntent) {
  return intent ? JSON.stringify([intent.provider, intent.method, intent.connectionId, intent.ownership, intent.allAgents, intent.agentIds]) : null;
}

export function matchesAdapterLoginTarget(session: AdapterLoginSession, target: AdapterLoginTarget) {
  return Boolean(target.environmentId) && session.environmentId === target.environmentId
    && connectionTargetKey(session.aiConnection) === connectionTargetKey(target.aiConnection);
}

const pendingCancellations = new Map<string, Promise<unknown>>();
const sessionCancellations = new Map<string, Promise<unknown>>();

export function cancelAdapterLoginSession(companyId: string, adapterType: string, submittedCode: boolean, sessionId: string) {
  const key = JSON.stringify([companyId, adapterType, sessionId]);
  const previous = sessionCancellations.get(key);
  if (previous) return previous;
  const request = (submittedCode
    ? agentsApi.cancelClaudeSetupTokenLogin(companyId, sessionId)
    : agentsApi.cancelAdapterAuthLogin(companyId, adapterType, sessionId)).catch(() => {});
  sessionCancellations.set(key, request);
  void request.then(() => { if (sessionCancellations.get(key) === request) sessionCancellations.delete(key); });
  return request;
}

export function cancelPendingAdapterLogin(companyId: string, adapterType: string, submittedCode: boolean, target: AdapterLoginTarget, pending: Promise<unknown>[] = [], discover = true) {
  const key = JSON.stringify([companyId, adapterType]);
  const previous = pendingCancellations.get(key);
  const cleanup = Promise.allSettled([...(previous ? [previous] : []), ...pending]).then(async () => {
    if (!discover) return;
    const session = submittedCode
      ? await agentsApi.getActiveClaudeSetupTokenLoginSession(companyId, { fresh: true })
      : await agentsApi.getActiveAdapterAuthLoginSession(companyId, adapterType, { fresh: true });
    if (session && matchesAdapterLoginTarget(session, target)) await cancelAdapterLoginSession(companyId, adapterType, submittedCode, session.sessionId);
  }).catch(() => {});
  pendingCancellations.set(key, cleanup);
  void cleanup.then(() => { if (pendingCancellations.get(key) === cleanup) pendingCancellations.delete(key); });
  return cleanup;
}

export function useAdapterLoginCancellation(active: boolean, companyId: string, adapterType: string, submittedCode: boolean, sessionId: string | null, target: AdapterLoginTarget) {
  const queryClient = useQueryClient();
  const ownerKey = JSON.stringify([companyId, adapterType]);
  const targetKey = JSON.stringify([companyId, adapterType, target.environmentId, connectionTargetKey(target.aiConnection)]);
  const attemptTarget = useMemo(() => target, [targetKey]);
  const scope = useRef({ active, generation: 0, targetKey });
  if (scope.current.active !== active || scope.current.targetKey !== targetKey) scope.current = { active, generation: scope.current.generation + 1, targetKey };
  const requests = useRef(new Set<Promise<unknown>>());
  const cancelled = useRef(new Map<string, Promise<unknown>>());
  const cancel = useCallback((id: string) => {
    const previous = cancelled.current.get(id);
    if (previous) return previous;
    const request = cancelAdapterLoginSession(companyId, adapterType, submittedCode, id);
    cancelled.current.set(id, request);
    return request;
  }, [companyId, adapterType, submittedCode]);

  const accept = useCallback(<T extends AdapterLoginSession>(request: () => Promise<T | null>, resumed = false): Promise<T | null> => {
    const generation = scope.current.generation;
    const result = (async () => {
      await pendingCancellations.get(ownerKey);
      if (!scope.current.active || scope.current.generation !== generation) return null;
      const session = await request();
      if (session && (!scope.current.active || scope.current.generation !== generation)) {
        if (!resumed || matchesAdapterLoginTarget(session, attemptTarget)) await cancel(session.sessionId);
        return null;
      }
      return session;
    })();
    requests.current.add(result);
    const forget = () => { requests.current.delete(result); };
    void result.then(forget, forget);
    return result;
  }, [cancel, ownerKey, attemptTarget]);

  useEffect(() => {
    if (active) return;
    const keys = submittedCode
      ? [["claude-setup-token-active-session", companyId], ["claude-setup-token-status", companyId], ["claude-setup-token-prompt", companyId]]
      : [["adapter-login-active-session", companyId, adapterType], ["adapter-login-status", companyId, adapterType]];
    for (const queryKey of keys) void queryClient.cancelQueries({ queryKey });
    void cancelPendingAdapterLogin(companyId, adapterType, submittedCode, attemptTarget,
      [...requests.current, ...(sessionId ? [cancel(sessionId)] : [])], !sessionId);
  }, [active, companyId, adapterType, submittedCode, sessionId, queryClient, cancel, ownerKey, attemptTarget]);

  return { accept, resume: <T extends AdapterLoginSession>(request: () => Promise<T | null>) => accept(request, true), isActive: () => scope.current.active };
}
