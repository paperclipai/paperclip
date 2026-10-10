import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MuseBinding, MusePairing, MusePairingInput, MuseAttestStopInput } from "@paperclipai/shared";
import { museInvitationsApi } from "@/api/museInvitations";
import { useAccountIdentity } from "@/api/companies-query";
import type { MuseConnectionState } from "@/components/new-agent/ExternalAgentInviteContent";

export function museConnectionState(connection: import("@paperclipai/shared").MuseConnection | undefined,
  { offline = false, promptUnavailable = false }: { offline?: boolean; promptUnavailable?: boolean } = {}): MuseConnectionState {
  const b = connection?.binding;
  const passed = !!b?.paired && b.receiverDetected && b.backgroundReplyVerified;
  const finishing = connection?.canConfigureConnection && ["preparing", "verifying"].includes(connection.agentLifecycleState);
  const ready = passed && b.status === "ready" && connection?.agentLifecycleState === "ready"
    && connection.canConfigureConnection && connection.enabled && connection.agentStatus !== "pending_approval";
  const expiredTest = !!b?.challengeExpiresAt && Date.parse(b.challengeExpiresAt) <= Date.now() && !b.backgroundReplyVerified;
  return {
    paired: b?.paired ?? false, receiverDetected: b?.receiverDetected ?? false,
    backgroundReplyVerified: b?.backgroundReplyVerified ?? false, ready, finishing,
    problem: offline ? "offline" : b?.status === "revoked" ? "disconnected" : connection && !connection.enabled ? "disabled" : promptUnavailable && !b?.paired ? "prompt_unavailable"
      : passed && !ready && !finishing ? "agent_unavailable" : expiredTest ? "no_recent_response" : undefined,
  };
}

export function museBindingRevision(binding: MuseBinding) {
  return { bindingId: binding.id, generation: binding.generation, expectedRevision: binding.revision };
}

/** Read queries contain only public evidence. Pairing results live in this mounted hook. */
export function useMuseConnection(companyId: string | undefined, agentId: string | undefined, enabled = true) {
  const cache = useQueryClient();
  const identity = useAccountIdentity();
  const key = ["muse-binding", companyId, identity.userId, agentId];
  const scope = `${companyId}:${agentId}:${identity.userId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [pairing, setPairing] = useState<MusePairing | null>(null);
  const state = useQuery({ queryKey: key, enabled: enabled && identity.settled && !!companyId && !!agentId,
    queryFn: ({ signal }) => museInvitationsApi.connection(companyId!, agentId!, signal), retry: false, staleTime: 0,
    refetchInterval: query => query.state.error ? false : query.state.data?.binding ? 5000 : false });
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const pair = useMutation({ mutationFn: async (input: MusePairingInput) => {
    const requestScope = scope;
    const result = await museInvitationsApi.pair(companyId!, agentId!, input);
    if (currentScope.current === requestScope) setPairing(result);
    // Returning void prevents the transient capability entering the mutation cache.
  }, onSuccess: () => { void refresh(); }, onError: () => { setPairing(null); void state.refetch(); }, gcTime: 0 });
  const verify = useMutation({ mutationFn: async (binding: MuseBinding) => {
    await museInvitationsApi.verify(companyId!, agentId!, museBindingRevision(binding));
  }, onSuccess: () => { void refresh(); }, onError: () => { void state.refetch(); } });
  const revoke = useMutation({ mutationFn: async (binding: MuseBinding) => {
    await museInvitationsApi.revoke(companyId!, agentId!, museBindingRevision(binding));
  }, onSuccess: () => { setPairing(null); void refresh(); } });
  const attest = useMutation({ mutationFn: (input: MuseAttestStopInput) => museInvitationsApi.attestStop(companyId!, agentId!, input),
    onSuccess: () => { void refresh(); }, onError: () => { void state.refetch(); } });
  useEffect(() => { setPairing(null); }, [companyId, agentId, identity.userId]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  const binding = state.data?.binding;
  const currentPairing = pairing && pairing.bindingId === binding?.id && pairing.generation === binding.generation
    && pairing.revision === binding.revision && !binding.paired ? pairing : null;
  return { state, binding, pairing: currentPairing, pair, verify, revoke, attest,
    repair: () => pair.mutate(binding && binding.status !== "revoked" ? { replaceBindingId: binding.id, expectedRevision: binding.revision } : {}),
    key, identity, refresh };
}
