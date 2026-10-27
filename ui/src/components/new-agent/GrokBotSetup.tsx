import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateGrokInvitation, DotPairing, GrokInvitation } from "@paperclipai/shared";
import { grokBotApi } from "@/api/grokBot";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { GrokBotSetupContent, type GrokSetupStep } from "./GrokBotSetupContent";

export function GrokBotSetup({ companyId, companyName, onBack, onClose }: {
  companyId: string; companyName: string; onBack: () => void; onClose: () => void;
}) {
  const cache = useQueryClient();
  const [invitation, setInvitation] = useState<GrokInvitation | null>(null);
  const [details, setDetails] = useState<CreateGrokInvitation>({ name: "", botName: "", role: "general", reportsTo: null });
  const [step, setStep] = useState<GrokSetupStep>(0);
  const [pairing, setPairing] = useState<DotPairing | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const [editingCredentials, setEditingCredentials] = useState(false);
  const attemptedPairing = useRef(false);
  const restored = useRef(false);
  const verifyRequest = useRef<string | null>(null);
  const resume = useQuery({ queryKey: ["grok-invitation", companyId], queryFn: () => grokBotApi.resume(companyId), retry: false, staleTime: 0 });
  const managers = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  useEffect(() => {
    if (!resume.isFetchedAfterMount || !resume.isSuccess || restored.current) return;
    restored.current = true;
    if (resume.data) {
      setInvitation(resume.data);
      setDetails({ name: resume.data.agent.name, botName: resume.data.agent.botName, role: resume.data.agent.role, reportsTo: resume.data.agent.reportsTo });
      setStep(resume.data.binding?.routine?.configured ? 3 : resume.data.binding?.connected ? 2 : 1);
    }
  }, [resume.isFetchedAfterMount, resume.isSuccess, resume.data]);
  const key = ["grok-binding", companyId, invitation?.agent.id];
  const connection = useQuery({ queryKey: key,
    queryFn: ({ signal }) => grokBotApi.connection(companyId, invitation!.agent.id, signal),
    enabled: !!invitation, retry: false, staleTime: 0, refetchInterval: 2500 });
  const create = useMutation({ mutationFn: async () => {
    const value = await grokBotApi.create(companyId, details); setInvitation(value);
    await cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }); return value;
  }, onSuccess: () => setStep(1) });
  const pair = useMutation({ mutationFn: async (replaceBindingId?: string) => {
    setPairing(await grokBotApi.pair(companyId, invitation!.agent.id, replaceBindingId));
  }, gcTime: 0, onSettled: () => { void connection.refetch(); } });
  const binding = connection.data?.binding;
  useEffect(() => {
    if (!invitation || !connection.isFetchedAfterMount || connection.isFetching || connection.error
      || !connection.data?.enabled || !connection.data.canConfigureConnection || binding?.connected
      || pairing || attemptedPairing.current || pair.isPending) return;
    attemptedPairing.current = true;
    pair.mutate(binding?.status === "pairing" ? binding.id : undefined);
  }, [invitation, connection.isFetchedAfterMount, connection.isFetching, connection.error, connection.data, binding, pairing, pair.isPending, pair.mutate]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => { attemptedPairing.current = false; setPairing(null); void connection.refetch(); }, Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  const configure = useMutation({ mutationFn: async () => {
    await grokBotApi.configure(companyId, invitation!.agent.id, { bindingId: binding!.id, expectedRevision: binding?.routine?.revision ?? 0, botName: details.botName, webhookUrl, webhookKey });
    setWebhookUrl(""); setWebhookKey(""); setEditingCredentials(false); verifyRequest.current = null; await connection.refetch(); setStep(3);
  }, gcTime: 0 });
  const verify = useMutation({ mutationFn: async () => {
    if (["rejected", "cancelled"].includes(binding?.routine?.lastExchange?.status ?? "")) verifyRequest.current = null;
    verifyRequest.current ??= crypto.randomUUID();
    await grokBotApi.verify(companyId, invitation!.agent.id, binding!.id, verifyRequest.current);
    await connection.refetch();
  }, gcTime: 0 });
  const routine = binding?.routine;
  const ready = routine?.verified && !routine.recoveryNeeded && connection.data?.agentLifecycleState === "ready" && connection.data.canConfigureConnection;
  const busy = create.isPending || pair.isPending || configure.isPending || verify.isPending;
  const error = resume.error ?? connection.error ?? create.error ?? pair.error ?? configure.error ?? verify.error;
  const next = () => {
    if (step === 0) { if (invitation) setStep(1); else create.mutate(); }
    else if (step === 1) setStep(2);
    else if (step === 2) { if (routine?.configured && !editingCredentials && !webhookUrl && !webhookKey) setStep(3); else configure.mutate(); }
    else if (ready) onClose();
    else verify.mutate();
  };
  return <GrokBotSetupContent step={step} companyName={companyName} details={details} created={!!invitation}
    managers={(managers.data ?? []).filter(agent => agent.status !== "terminated" && agent.id !== invitation?.agent.id)}
    loading={resume.isPending} busy={busy} error={error?.message} connection={connection.data} pairing={binding?.connected ? null : pairing}
    approvalHref={invitation?.approvalId && (connection.data?.agentStatus ?? invitation.agent.status) === "pending_approval" ? `/approvals/${invitation.approvalId}` : undefined}
    webhookUrl={webhookUrl} webhookKey={webhookKey} editingCredentials={editingCredentials} onEditCredentials={() => setEditingCredentials(true)} onDetails={setDetails} onCredentials={(url, key) => { setWebhookUrl(url); setWebhookKey(key); }}
    onBack={() => step === 0 ? onBack() : setStep((step - 1) as GrokSetupStep)}
    onExit={() => { if (!invitation && details.name.trim() && details.botName.trim()) create.mutate(undefined, { onSuccess: onClose }); else if (step === 2 && webhookUrl && webhookKey) configure.mutate(undefined, { onSuccess: onClose }); else onClose(); }}
    onNext={next} onRetry={() => { if (connection.error) void connection.refetch(); else if (resume.error) void resume.refetch(); else if (pair.error) pair.mutate(binding?.id); else next(); }} />;
}
