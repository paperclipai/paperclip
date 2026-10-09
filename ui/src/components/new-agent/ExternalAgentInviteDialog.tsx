import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { dotInvitationsApi, type DotInvitation, type DotPairing } from "@/api/dotInvitations";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { buildDotSetupPrompt } from "@/lib/dot-setup-prompt";
import { AnimatedDialogContent } from "../AnimatedDialogContent";
import { Dialog } from "../ui/dialog";
import { ExternalAgentInviteContent, type DotConnectionState, type ExternalAgentPreset } from "./ExternalAgentInviteContent";

/** Pairing secrets live only in this mounted dialog. Reloads resume the agent, never duplicate it. */
export function ExternalAgentInviteDialog({ companyId, onClose, onBack }: {
  companyId: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const cache = useQueryClient();
  const { selectedCompany } = useCompany();
  const [preset, setPreset] = useState<ExternalAgentPreset | null>(null);
  const [invitation, setInvitation] = useState<DotInvitation | null>(null);
  const [pairing, setPairing] = useState<DotPairing | null>(null);
  const [expiredPairingBindingId, setExpiredPairingBindingId] = useState<string | null>(null);
  const [genericPrompt, setGenericPrompt] = useState("");
  const attemptedAutomaticPairing = useRef(false);
  const experimental = useQuery({ queryKey: queryKeys.instance.experimentalSettings, queryFn: instanceSettingsApi.getExperimental });
  const dotDisabledReason = experimental.isPending ? "Loading available agents…"
    : experimental.error ? "Unable to load experimental settings. Try again after refreshing."
    : !experimental.data?.enableOpenAiDot || !experimental.data.enablePublicMcp
      ? "Enable OpenAI Dot and Assistant connections (MCP) in experimental settings." : undefined;
  const key = ["dot-binding", companyId, invitation?.agent.id];
  const state = useQuery({ queryKey: key,
    queryFn: ({ signal }) => dotInvitationsApi.connection(companyId, invitation!.agent.id, signal),
    enabled: preset === "dot" && !!invitation,
    retry: false,
    staleTime: 0,
    refetchInterval: query => query.state.error ? false : query.state.data?.agentLifecycleState === "ready" && query.state.data.canConfigureConnection
      && query.state.data.binding?.status === "ready" && query.state.data.binding.subscriptionVerified ? false : 2500,
  });
  const generate = useMutation({
    mutationFn: async (kind: ExternalAgentPreset) => {
      if (kind === "dot") {
        const result = await dotInvitationsApi.create(companyId);
        setInvitation(result);
        await cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
        return;
      }
      const invite = await accessApi.createCompanyInvite(companyId, { allowedJoinTypes: "agent", humanRole: null, agentMessage: null });
      void cache.invalidateQueries({ queryKey: queryKeys.access.invites(companyId, "all", 5) });
      const path = invite.onboardingTextUrl ?? invite.onboardingTextPath ?? `/api/invites/${invite.token}/onboarding.txt`;
      const manifest = await accessApi.getInviteOnboarding(invite.token).catch(() => null);
      setGenericPrompt(buildAgentOnboardingPrompt({ onboardingTextUrl: new URL(path, window.location.origin).href,
        connectionCandidates: manifest?.onboarding.connectivity?.connectionCandidates ?? null,
        testResolutionUrl: manifest?.onboarding.connectivity?.testResolutionEndpoint?.url ?? null }));
    },
    gcTime: 0,
  });
  const pair = useMutation({
    mutationFn: async (replaceBindingId?: string) => {
      const result = await dotInvitationsApi.pair(companyId, invitation!.agent.id, replaceBindingId);
      setPairing(result);
      setExpiredPairingBindingId(null);
      // Do not retain a one-use code in React Query's mutation cache.
    },
    onSuccess: () => { void cache.invalidateQueries({ queryKey: key }); },
    onError: () => { void state.refetch(); },
    gcTime: 0,
  });
  const test = useMutation({ mutationFn: () => dotInvitationsApi.retry(companyId, invitation!.agent.id, state.data!.binding!.id),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: key }); } });
  const binding = state.data?.binding;
  const canPreparePairing = preset === "dot" && state.data?.enabled && !!state.data.resourceUrl
    && state.data.canConfigureConnection
    && (!binding || binding.status === "pairing");
  const preparePairing = canPreparePairing && !pairing && !state.error && !pair.isError
    && !attemptedAutomaticPairing.current
    && (!expiredPairingBindingId || binding?.id === expiredPairingBindingId);
  useEffect(() => {
    // Revalidate cached connection state before rotating an unfinished capability.
    // Attempt once per opening/expiry, so failed requests and other tabs cannot cause a renewal loop.
    if (preparePairing && state.isFetchedAfterMount && !state.isFetching && !pair.isPending) {
      attemptedAutomaticPairing.current = true;
      pair.mutate(binding?.id);
    }
  }, [preparePairing, state.isFetchedAfterMount, state.isFetching, pair.isPending, pair.mutate, binding?.id]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => {
      attemptedAutomaticPairing.current = false;
      setExpiredPairingBindingId(pairing.bindingId);
      setPairing(null);
    }, Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  const connection: DotConnectionState = {
    phase: binding?.status === "ready" && binding.subscriptionVerified
      ? state.data?.agentLifecycleState === "ready" && state.data.canConfigureConnection ? "ready" : "finishing"
      : binding?.hasPendingChallenge ? "testing" : binding?.subscriptionVerified ? "subscribed" : binding?.connected ? "connected" : "waiting",
    problem: state.error ? "offline"
      : binding?.status === "pairing" && !preparePairing && !pair.isPending && !state.isFetching && !pair.isError && pairing?.bindingId !== binding.id ? "prompt_unavailable"
      : binding?.challengeExpiresAt && !binding.hasPendingChallenge && binding.status !== "ready" ? "event_timeout" : undefined,
  };
  const pendingApproval = (state.data?.agentStatus ?? invitation?.agent.status) === "pending_approval";
  const unavailable = state.data && !state.data.canConfigureConnection && !pendingApproval;
  const prompt = preset === "dot" ? pairing && pairing.bindingId === binding?.id && state.data?.resourceUrl && invitation
    ? buildDotSetupPrompt({ companyId, agentId: invitation.agent.id, resourceUrl: state.data.resourceUrl, ...pairing }) : "" : genericPrompt;
  const error = (generate.variables === preset ? generate.error : null) ?? (preset === "dot" ? (binding?.connected ? null : pair.error) ?? test.error : null);
  const busy = generate.isPending || pair.isPending || test.isPending || preparePairing
    || (preset === "dot" && !!invitation && (state.isPending || (!prompt && state.isFetching)));
  const retry = () => {
    if (unavailable) { void state.refetch(); return; }
    if (state.error) { void state.refetch(); return; }
    if (generate.error || !invitation) { if (preset) generate.mutate(preset); return; }
    if (pair.error && !binding?.connected) { pair.mutate(binding?.status === "pairing" ? binding.id : undefined); return; }
    test.mutate();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <AnimatedDialogContent className="sm:max-w-(--sz-560px)">
      <ExternalAgentInviteContent preset={preset} prompt={prompt} companyName={selectedCompany?.name ?? "your organization"}
        connection={connection} dotDisabledReason={dotDisabledReason} busy={busy}
        error={error?.message ?? (unavailable ? "Resume this agent before connecting Dot." : undefined)}
        approvalHref={pendingApproval && invitation?.approvalId ? `/approvals/${invitation.approvalId}` : undefined}
        onSelect={kind => { setPreset(kind); if (kind === "dot" ? !invitation : !genericPrompt) generate.mutate(kind); }}
        onBack={() => setPreset(null)} onClose={preset ? onClose : onBack} onCopied={() => { if (preset === "dot") void state.refetch(); }}
        onRetry={retry} onNewPrompt={() => pair.mutate(binding?.id)} />
    </AnimatedDialogContent>
  </Dialog>;
}
