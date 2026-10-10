import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MuseInvitation } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { museInvitationsApi } from "@/api/museInvitations";
import { useAccountIdentity } from "@/api/companies-query";
import { useMuseConnection, useMuseConnectionState } from "@/hooks/useMuseConnection";
import { clearMuseInvitationDraft, readMuseInvitationDraft, saveMuseInvitationDraft, type MuseInvitationDraft } from "@/lib/muse-invitation-draft";
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
export function ExternalAgentInviteDialog({ companyId, onClose, onBack, initialPreset = null, initialMuseName = "" }: {
  companyId: string;
  initialPreset?: ExternalAgentPreset | null;
  initialMuseName?: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const cache = useQueryClient();
  const { selectedCompany } = useCompany();
  const [preset, setPreset] = useState<ExternalAgentPreset | null>(initialPreset);
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
  const checksReady = binding?.status === "ready" && binding.subscriptionVerified;
  const agentReady = state.data?.agentLifecycleState === "ready" && state.data.canConfigureConnection;
  const finishingSetup = ["preparing", "verifying"].includes(state.data?.agentLifecycleState ?? "")
    && state.data?.canConfigureConnection;
  const connection: DotConnectionState = {
    phase: checksReady ? agentReady ? "ready" : finishingSetup ? "finishing" : "ready"
      : binding?.hasPendingChallenge ? "testing" : binding?.subscriptionVerified ? "subscribed" : binding?.connected ? "connected" : "waiting",
    problem: state.error ? "offline"
      : checksReady && !agentReady && !finishingSetup ? "agent_unavailable"
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
    if (preset === "muse") { void experimental.refetch(); return; }
    if (unavailable) { void state.refetch(); return; }
    if (state.error) { void state.refetch(); return; }
    if (generate.error || !invitation) { if (preset) generate.mutate(preset); return; }
    if (pair.error && !binding?.connected) { pair.mutate(binding?.status === "pairing" ? binding.id : undefined); return; }
    test.mutate();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <AnimatedDialogContent className="flex max-h-(--sz-calc-18) flex-col gap-0 overflow-hidden p-0 sm:max-w-(--sz-560px)">
      {preset === "muse" && experimental.data?.enableMuse && experimental.data?.enableNativeRunner ? <MuseInvitationController initialName={initialMuseName} companyId={companyId} companyName={selectedCompany?.name ?? "your organization"} onClose={onClose} onBack={() => setPreset(null)} /> :
      <ExternalAgentInviteContent preset={preset === "muse" ? null : preset} prompt={prompt} companyName={selectedCompany?.name ?? "your organization"}
        connection={connection} museEnabled={experimental.data?.enableMuse === true && experimental.data?.enableNativeRunner === true} dotDisabledReason={dotDisabledReason} busy={busy}
        error={preset === "muse" ? experimental.isPending ? undefined : "Enable Muse and Paperclip Runner in experimental settings to connect your personal Muse." : error?.message ?? (unavailable ? state.data?.agentLifecycleState === "terminated" ? "This agent was terminated. Invite another agent to connect Dot." : "Resume this agent before connecting Dot." : undefined)}
        approvalHref={pendingApproval && invitation?.approvalId ? `/approvals/${invitation.approvalId}` : undefined}
        onSelect={kind => { setPreset(kind); if (kind !== "muse" && (kind === "dot" ? !invitation : !genericPrompt)) generate.mutate(kind); }}
        onBack={() => setPreset(null)} onClose={preset ? onClose : onBack} onCopied={() => { if (preset === "dot") void state.refetch(); }}
        onRetry={retry} onNewPrompt={() => pair.mutate(binding?.id)} />}
    </AnimatedDialogContent>
  </Dialog>;
}


function MuseInvitationController({ companyId, companyName, onClose, onBack, initialName }: {
  companyId: string; companyName: string; initialName: string; onClose: () => void; onBack: () => void;
}) {
  const cache = useQueryClient();
  const identity = useAccountIdentity();
  const scopeKey = `${companyId}:${identity.userId}`;
  const loadDraft = () => { const value = readMuseInvitationDraft(companyId, identity.userId); return { ...value, name: value.name || initialName }; };
  const [draftState, setDraftState] = useState(() => ({ scopeKey, value: loadDraft() }));
  if (draftState.scopeKey !== scopeKey) setDraftState({ scopeKey, value: loadDraft() });
  const draft = draftState.value;
  const [created, setCreated] = useState<{ scopeKey: string; invitation: MuseInvitation } | null>(null);
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const invitationKey = ["muse-invitation", companyId, identity.userId];
  const resume = useQuery({ queryKey: invitationKey,
    queryFn: ({ signal }) => museInvitationsApi.resume(companyId, signal), enabled: identity.settled,
    retry: false, staleTime: 0, refetchOnMount: "always",
    refetchInterval: query => query.state.data?.agent.status === "pending_approval" ? 2500 : false });
  const resumedInvitation = resume.isFetchedAfterMount ? resume.data : null;
  const createdInvitation = created?.scopeKey === scopeKey ? created.invitation : null;
  // Resume omits completed bindings; keep this mounted hire while accepting its fresh server status.
  const invitation = createdInvitation
    ? resumedInvitation?.agent.id === createdInvitation.agent.id ? resumedInvitation : createdInvitation
    : resumedInvitation;
  const muse = useMuseConnection(companyId, invitation?.agent.id);
  const attemptedAutomaticPairing = useRef(false);
  const attemptedAutomaticVerification = useRef<string | null>(null);
  useEffect(() => { attemptedAutomaticPairing.current = false; attemptedAutomaticVerification.current = null; }, [scopeKey, invitation?.agent.id]);
  const create = useMutation({ mutationFn: async (input: MuseInvitationDraft) => {
    const requestScope = scopeKey;
    const result = await museInvitationsApi.create(companyId, { name: input.name.trim(), role: input.role });
    if (currentScope.current === requestScope) {
      setCreated({ scopeKey: requestScope, invitation: result });
      cache.setQueryData(invitationKey, result);
      void cache.invalidateQueries({ queryKey: invitationKey, exact: true });
    }
    void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    // The creation receipt contains no ticket; pairing happens in the mounted connection hook.
  }, gcTime: 0 });
  const b = muse.binding;
  const canPrepare = !!invitation && muse.state.data?.enabled && muse.state.data.canConfigureConnection
    && !!muse.state.data.publicOrigin && (!b || b.status === "pairing");
  useEffect(() => {
    if (canPrepare && muse.state.isFetchedAfterMount && !muse.state.isFetching && !muse.pair.isPending
      && !muse.pairing && !attemptedAutomaticPairing.current) {
      attemptedAutomaticPairing.current = true;
      muse.repair();
    }
  }, [canPrepare, muse.state.isFetchedAfterMount, muse.state.isFetching, muse.pair.isPending, muse.pairing, b?.id, b?.revision]);
  useEffect(() => {
    if (b?.paired && b.receiverDetected && !b.backgroundReplyVerified && !b.challengeExpiresAt
      && muse.state.data?.enabled && muse.state.data.canConfigureConnection
      && muse.state.isFetchedAfterMount && !muse.state.isFetching && !muse.verify.isPending && !muse.verify.isError) {
      const identity = `${b.id}:${b.generation}`;
      if (attemptedAutomaticVerification.current !== identity) {
        attemptedAutomaticVerification.current = identity;
        muse.verify.mutate(b);
      }
    }
  }, [b, muse.state.data, muse.state.isFetchedAfterMount, muse.state.isFetching, muse.verify.isPending, muse.verify.isError]);
  const pendingApproval = (muse.state.data?.agentStatus ?? invitation?.agent.status) === "pending_approval";
  const busy = create.isPending || muse.pair.isPending || muse.verify.isPending || (!invitation && (resume.isPending && !identity.failed || !identity.settled && !identity.failed))
    || (!!invitation && muse.state.isPending);
  const promptUnavailable = !!b && !b.paired && b.status === "pairing" && !muse.pairing
    && attemptedAutomaticPairing.current && !muse.pair.isPending && !muse.state.isFetching;
  const connection = useMuseConnectionState(muse.state.data, { offline: muse.state.isError, promptUnavailable });
  const verifyError = muse.verify.error instanceof ApiError && muse.verify.error.status === 409 && b?.challengeExpiresAt
    && Date.parse(b.challengeExpiresAt) > Date.now() ? null : muse.verify.error;
  const error = create.error ?? resume.error ?? muse.pair.error ?? verifyError;
  const operatorRequired = error instanceof ApiError && (error.status === 401 || error.status === 403)
    && !invitation;
  const missingPublicOrigin = !!invitation && muse.state.isSuccess && !muse.state.data.publicOrigin;
  const errorMessage = missingPublicOrigin ? "This instance has no public HTTPS URL for Muse. Ask your instance administrator to configure a stable public HTTPS address, then refresh setup. Muse cannot connect through a local-only address." : operatorRequired ? "Use an authenticated Paperclip instance with a public HTTPS URL and a company operator account. Local trusted access alone cannot connect Muse." : error?.message;
  return <ExternalAgentInviteContent preset="muse" companyName={companyName} prompt={muse.pairing?.setupInstruction ?? ""}
    connection={{ phase: "waiting" }} museConnection={invitation && !missingPublicOrigin && b ? connection : undefined} busy={busy} error={identity.failed ? "Unable to confirm your account. Refresh to resume Muse setup." : errorMessage}
    approvalHref={pendingApproval && invitation?.approvalId ? `/approvals/${invitation.approvalId}` : undefined}
    museDraft={!invitation && resume.isSuccess && identity.settled ? draft : undefined}
    onMuseDraftChange={value => { setDraftState({ scopeKey, value }); saveMuseInvitationDraft(companyId, identity.userId, value); }}
    onMuseContinue={() => create.mutate(draft)} onSelect={() => {}} onBack={onBack}
    onClose={() => { if (connection.ready) { clearMuseInvitationDraft(companyId, identity.userId); void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }); } onClose(); }}
    onCopied={() => { void muse.state.refetch(); }}
    onRetry={() => { if (identity.failed) { void cache.invalidateQueries({ queryKey: queryKeys.auth.session }); return; } if (resume.isError) { void resume.refetch(); return; } if (missingPublicOrigin) { void muse.state.refetch(); return; } if (create.isError && !invitation) { create.mutate(draft); return; }
      if (muse.state.isError) { void muse.state.refetch(); return; } if (b?.paired) muse.verify.mutate(b); else muse.repair(); }}
    onNewPrompt={() => muse.repair()} />;
}
