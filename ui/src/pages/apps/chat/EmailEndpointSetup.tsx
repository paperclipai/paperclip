import { t, useTranslation } from "@/i18n";
import { chatLabel } from "./chat-copy";
import { isUuidLike } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { AgentMailCredentialField } from "@/features/connections/AgentMailCredentialField";
import { AgentMailApiKeyField } from "@/features/connections/AgentMailApiKeyField";
import { useEmailAddressCheck } from "@/features/connections/useEmailAddressCheck";
import { ChatSetupNavigation } from "@/components/chat/ChatSetupNavigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Mail,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardDescription } from "@/components/ui/card";
import { CopyText } from "@/components/CopyText";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTime } from "@/lib/utils";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { TrustPresetSection } from "@/components/TrustPresetSection";
import { EmailSafetyNotice } from "@/components/EmailSafetyNotice";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  getTrustPreset,
  getLowTrustBoundary,
  lowTrustBoundaryHasScope,
} from "@/lib/trust-policy-ui";
import { queryKeys } from "@/lib/queryKeys";
import type {
  AgentPermissions,
  EmailEndpointSummary,
} from "@paperclipai/shared";
const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

interface EmailSetupDraft {
  connectionId: string; step: 0 | 1; agentId: string; requestId: string;
  addressMode: "new" | "existing"; inboxId: string; username: string; domain: string;
  mode: "websocket" | "webhook";
  domainSelected: boolean;
  takenAddresses: string[];
  allowInboxKey: boolean;
  selectedCredentialId: string | null;
}
function readEmailSetupDraft(key: string): Partial<EmailSetupDraft> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const draft: Partial<EmailSetupDraft> = {};
    for (const field of ["connectionId", "agentId", "inboxId", "username", "domain"] as const) {
      if (typeof value[field] === "string") draft[field] = value[field];
    }
    if (value.step === 0 || value.step === 1) draft.step = value.step;
    if (typeof value.requestId === "string" && isUuidLike(value.requestId)) draft.requestId = value.requestId;
    if (value.addressMode === "new" || value.addressMode === "existing") draft.addressMode = value.addressMode;
    if (value.mode === "websocket" || value.mode === "webhook") draft.mode = value.mode;
    if (value.selectedCredentialId === null || typeof value.selectedCredentialId === "string") draft.selectedCredentialId = value.selectedCredentialId;
    if (typeof value.allowInboxKey === "boolean") draft.allowInboxKey = value.allowInboxKey;
    if (typeof value.domainSelected === "boolean") draft.domainSelected = value.domainSelected;
    if (Array.isArray(value.takenAddresses)) draft.takenAddresses = value.takenAddresses
      .filter((address: unknown): address is string => typeof address === "string" && address.length <= 320).slice(-20);
    return draft;
  } catch { return {}; }
}

export function EmailEndpointSetup() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const [params] = useSearchParams();
  if (!selectedCompanyId) return <p role="status" className="p-6 text-sm text-muted-foreground">{t("oct5Apps.copy088")}</p>;
  return <EmailEndpointSetupForm key={`${selectedCompanyId}:${params.get("resume") ?? params.get("setupId") ?? params.get("connectionId") ?? "new"}:${params.get("agentId") ?? "choose"}`} companyId={selectedCompanyId} />;
}

function EmailEndpointSetupForm({ companyId }: { companyId: string }) {
  useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const resumeId = params.get("resume");
  const setupId = params.get("setupId");
  const draftKey = `paperclip.agentmail-setup:${companyId}:${resumeId ?? setupId ?? params.get("connectionId") ?? "new"}:${params.get("agentId") ?? "choose"}`;
  const [draft] = useState(() => {
    const saved = readEmailSetupDraft(draftKey);
    // A Finish setup link always names its original inbox, including when an
    // older client accidentally stored a replacement under that resume key.
    return resumeId && saved.requestId && saved.requestId !== resumeId ? {} : saved;
  });
  const [connectionId, setConnectionId] = useState(draft.connectionId ?? params.get("connectionId") ?? "");
  const [step, setStep] = useState<0 | 1 | 2>(draft.step ?? (resumeId ? 1 : 0));
  const [agentId, setAgentId] = useState(draft.agentId ?? params.get("agentId") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(draft.selectedCredentialId !== undefined ? draft.selectedCredentialId : connectionId || null);
  const [restrictedInbox, setRestrictedInbox] = useState("");
  const [allowInboxKey, setAllowInboxKey] = useState(draft.allowInboxKey ?? false);
  const [requestId] = useState(() => draft.requestId ?? resumeId ?? (setupId && isUuidLike(setupId) ? setupId : crypto.randomUUID()));
  const [addressMode, setAddressMode] = useState<"new" | "existing">(draft.addressMode ?? "new");
  const [inboxId, setInboxId] = useState(draft.inboxId ?? "");
  const [username, setUsername] = useState(draft.username ?? "");
  const [domain, setDomain] = useState(draft.domain ?? "agentmail.to");
  const [domainSelected, setDomainSelected] = useState(draft.domainSelected ?? (!!draft.domain && draft.domain !== "agentmail.to"));
  const [takenAddresses, setTakenAddresses] = useState<string[]>(draft.takenAddresses ?? []);
  const [mode, setMode] = useState<"websocket" | "webhook">(draft.mode ?? "websocket");
  const [trustOpen, setTrustOpen] = useState(false);
  const [permissions, setPermissions] = useState<Partial<AgentPermissions>>({});
  const suggestedUsername = useRef(false);
  useEffect(() => {
    if (!companyId) return;
    // Save progress, never the API key. The same request ID resumes partial setup.
    try {
      if (step === 2) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ connectionId, step, agentId,
        requestId, addressMode, inboxId, username, domain, domainSelected, takenAddresses, mode, allowInboxKey, selectedCredentialId }));
    } catch { /* Setup remains usable when browser storage is unavailable. */ }
  }, [companyId, draftKey, connectionId, step, agentId, requestId, addressMode, inboxId, username, domain, domainSelected, takenAddresses, mode, allowInboxKey, selectedCredentialId]);
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId), enabled: !!companyId });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId), enabled: !!companyId && trustOpen });
  const boundaryIssues = useQuery({ queryKey: ["email-boundary-issues", companyId],
    queryFn: () => issuesApi.list(companyId), enabled: !!companyId && trustOpen });
  const chosen = agents.data?.find(a => a.id === agentId);
  const lowTrust = getTrustPreset(chosen?.permissions) === "low_trust_review";
  const scoped = lowTrustBoundaryHasScope(getLowTrustBoundary(chosen?.permissions));
  const inspected = useQuery({ queryKey: ["email-credential-inspect", companyId, connectionId],
    queryFn: () => emailApi.inspectSaved(companyId, connectionId),
    enabled: !!companyId && !!connectionId, retry: false });
  const inboxes = useQuery({ queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId), enabled: !!companyId });
  // A provider failure can leave an inbox allocated under this request. Resume
  // that exact endpoint; its agent and address are already fixed server-side.
  const pendingEndpoint = inboxes.data?.find(i => i.id === requestId && i.status !== "archived");
  const pendingAddress = pendingEndpoint?.address;
  const resumeAccount = useQuery({
    queryKey: ["email-resume-account", companyId, pendingEndpoint?.connectionId],
    queryFn: () => toolsApi.getConnection(pendingEndpoint!.connectionId),
    enabled: !!resumeId && requestId === resumeId && !!pendingEndpoint && !connectionId,
    retry: false,
  });
  useEffect(() => {
    if (!resumeId || !pendingEndpoint || connectionId || !resumeAccount.isSuccess) return;
    const savedAccount = resumeAccount.data?.config?.credentialConnectionId;
    if (typeof savedAccount === "string") setConnectionId(savedAccount);
    else setStep(0);
    setMode(pendingEndpoint.receiveMode);
  }, [resumeId, pendingEndpoint, connectionId, resumeAccount.isSuccess, resumeAccount.data]);
  useEffect(() => {
    if (pendingEndpoint) setAgentId(pendingEndpoint.assignedAgentId);
  }, [pendingEndpoint]);
  const scopedKey = inspected.data?.scope.scope_type === "inbox";
  const customDomains = [...new Set(inspected.data?.domains
    .filter(d => d.status === "VERIFIED" && d.domain.toLowerCase() !== "agentmail.to")
    .map(d => d.domain.toLowerCase()) ?? [])];
  const defaultDomain = customDomains[0] ?? "agentmail.to";
  useEffect(() => {
    if (inspected.isSuccess && !domainSelected && !pendingAddress) setDomain(defaultDomain);
  }, [inspected.isSuccess, domainSelected, pendingAddress, defaultDomain]);
  useEffect(() => {
    if (!scopedKey || !inboxes.isSuccess) return;
    if (pendingAddress || allowInboxKey) {
      setAddressMode("existing");
      setInboxId(inspected.data?.inboxes[0]?.inbox_id ?? "");
    } else if (step === 1) {
      // Old drafts must recover at the key choice, not return to a locked form.
      setRestrictedInbox(inspected.data?.inboxes[0]?.inbox_id ?? "this inbox");
      setSelectedCredentialId(null);
      setStep(0);
    }
  }, [scopedKey, inspected.data, inboxes.isSuccess, pendingAddress, allowInboxKey, step]);
  useEffect(() => {
    if (chosen && !suggestedUsername.current) {
      suggestedUsername.current = true;
      if (!username) setUsername(chosen.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64));
    }
  }, [chosen, username]);
  const connect = useMutation({
    mutationFn: async () => {
      if (pendingAddress) return true;
      const details = selectedCredentialId
        ? await emailApi.inspectSaved(companyId, selectedCredentialId)
        : await emailApi.inspect(companyId, apiKey.trim());
      if (details.scope.scope_type === "inbox" && !allowInboxKey) {
        setRestrictedInbox(details.inboxes[0]?.inbox_id ?? "this inbox");
        return false;
      }
      const changingAccount = !!connectionId && selectedCredentialId !== connectionId;
      const nextRequestId = changingAccount ? crypto.randomUUID() : requestId;
      let id = selectedCredentialId;
      if (!id) {
        const result = await emailApi.connect(companyId, {
          apiKey: apiKey.trim(), grantKind: "organization", allAgents: false,
          agentIds: [agentId], idempotencyKey: nextRequestId,
        });
        id = result.id;
      }
      cache.setQueryData(["email-credential-inspect", companyId, id], details);
      setSelectedCredentialId(id);
      setApiKey("");
      void cache.invalidateQueries({ queryKey: ["email-credentials", companyId] });
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      if (changingAccount) {
        // Save the replacement credential before retiring the original draft.
        // A failed save/cleanup leaves the original URL recoverable; a completed
        // switch gets its own URL so refreshing cannot revive an archived draft.
        if (pendingEndpoint) {
          await emailApi.control(pendingEndpoint.id, "remove");
          await cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
        }
        openDraft({
          connectionId: id, selectedCredentialId: id, agentId, step: 1,
          requestId: nextRequestId, addressMode: details.scope.scope_type === "inbox" ? "existing" : "new",
          inboxId: details.scope.scope_type === "inbox" ? details.inboxes[0]?.inbox_id ?? "" : "",
          username, domain: "agentmail.to", domainSelected: false, takenAddresses: [], mode, allowInboxKey,
        });
        return false;
      }
      setConnectionId(id);
      setRestrictedInbox("");
      setAddressMode(details.scope.scope_type === "inbox" ? "existing" : "new");
      if (details.scope.scope_type === "inbox") setInboxId(details.inboxes[0]?.inbox_id ?? "");
      return true;
    },
    onSuccess: ready => { if (ready) setStep(1); },
  });
  function selectCredential(id: string) {
    setSelectedCredentialId(id);
    setApiKey("");
    setRestrictedInbox("");
    setAllowInboxKey(false);
    setDomainSelected(false);
    setTakenAddresses([]);
    connect.reset();
  }
  const agentDetail = useQuery({ queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId), enabled: !!agentId && trustOpen });
  const trust = useMutation({
    mutationFn: () => agentsApi.updatePermissions(agentId, {
      ...permissions,
      canCreateAgents: permissions.canCreateAgents ?? false,
      canCreateSkills: permissions.canCreateSkills ?? true,
      canAssignTasks: agentDetail.data?.access?.canAssignTasks ?? false,
    }, companyId),
    onSuccess: () => {
      setTrustOpen(false);
      void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });
  const setup = useMutation({
    mutationFn: () => emailApi.setup(companyId, {
      assignedAgentId: agentId, credentialConnectionId: connectionId,
      ...(pendingAddress ? { inboxId: pendingAddress } : addressMode === "existing" ? { inboxId } : { username, domain }),
      receiveMode: mode, idempotencyKey: requestId,
    }),
    onError: async (error) => {
      if (error instanceof ApiError && (error.body as { code?: string } | null)?.code === "agentmail_address_taken") {
        setTakenAddresses(previous => [...new Set([...previous, `${username}@${domain}`.toLowerCase()])].slice(-20));
      }
      await cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
      void cache.invalidateQueries({ queryKey: queryKeys.chatEndpoints.list(companyId) });
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      void cache.invalidateQueries({ queryKey: queryKeys.tools.connectionInstalls(connectionId) });
      setStep(2);
    },
  });
  const address = pendingAddress ?? (addressMode === "existing" ? inboxId : `${username}@${domain}`);
  const knownAddresses = new Set([...takenAddresses, ...(inspected.data?.inboxes.map(i => i.inbox_id.toLowerCase()) ?? [])]);
  const checkingNewAddress = step === 1 && addressMode === "new" && !pendingAddress && !scopedKey;
  const knownAddress = checkingNewAddress && knownAddresses.has(address.toLowerCase());
  const validUsername = /^[a-z0-9][a-z0-9._-]*$/.test(username) && username.length <= 64;
  const addressCheck = useEmailAddressCheck(companyId, connectionId, username, domain,
    checkingNewAddress && validUsername && !!inspected.data && !knownAddress);
  const addressTaken = knownAddress || addressCheck.result?.status === "taken";
  const suggestions = checkingNewAddress && validUsername && (addressTaken || addressCheck.result?.status === "unknown")
    ? ["-agent", "-team", `-${requestId.slice(0, 6)}`]
      .map(suffix => `${username.slice(0, 64 - suffix.length)}${suffix}`)
      .filter(name => !knownAddresses.has(`${name}@${domain}`)) : [];
  const assignedInbox = addressMode === "existing" && inboxes.data?.some(i => i.id !== requestId && i.address === address && i.status !== "archived");
  const addressError = addressTaken ? t("oct5Apps.copy089")
    : assignedInbox ? t("oct5Apps.copy090") : null;
  const error = connect.error ?? (!addressTaken ? setup.error : null) ?? resumeAccount.error ?? inspected.error ?? agents.error;
  const busy = connect.isPending || setup.isPending;
  const identityReady = inboxes.isSuccess && (!resumeId || requestId !== resumeId || !!pendingEndpoint) && (!pendingEndpoint || pendingEndpoint.assignedAgentId === agentId);
  const canContinue = identityReady && !!chosen && !busy && !(lowTrust && !scoped) && (!!pendingAddress || !!selectedCredentialId || !!apiKey.trim());
  const canCreate = identityReady && !!chosen && !busy && !!inspected.data && !(lowTrust && !scoped) && !addressError && !addressCheck.checking
    && (!!pendingAddress || (addressMode === "existing" ? !!inboxId : validUsername));
  const openTrust = () => { if (chosen) { setPermissions(chosen.permissions); setTrustOpen(true); } };
  const leave = () => navigate(`/apps/chat/${setup.data?.id ?? pendingEndpoint?.id}/settings`);
  const cancel = () => { try { sessionStorage.removeItem(draftKey); } catch {} navigate("/apps"); };
  function openDraft(nextDraft: EmailSetupDraft & { requestId: string; connectionId: string }) {
    try {
      sessionStorage.setItem(`paperclip.agentmail-setup:${companyId}:${nextDraft.requestId}:${agentId}`, JSON.stringify(nextDraft));
    } catch { /* The new link still restores the agent and saved account. */ }
    navigate(`/apps/chat/connect?${new URLSearchParams({ provider: "agentmail", purpose: "chat", setupId: nextDraft.requestId, agentId, connectionId: nextDraft.connectionId })}`);
  }
  const chooseAnotherAddress = () => {
    // Preserve the allocated inbox and its resumable setup. A different address
    // must use a new provider client_id, never silently rename a retry.
    const nextRequestId = crypto.randomUUID();
    openDraft({
      connectionId, selectedCredentialId: connectionId, agentId, step: 1,
      requestId: nextRequestId, addressMode: "new", username: "", inboxId: "",
      domain: pendingAddress?.slice(pendingAddress.lastIndexOf("@") + 1) ?? domain,
      domainSelected: true, takenAddresses, mode, allowInboxKey: false,
    });
  };
  return <div className="mx-auto max-w-xl space-y-6 p-6">
    <header className="space-y-2">
      <h1 className="text-xl font-bold">{step === 2 ? t("oct5Apps.copy091") : t("oct5Apps.copy092")}</h1>
    </header>
    {step < 2 && inboxes.isError && <div role="alert" className="space-y-2 text-sm">
      <p className="text-destructive">{t("oct5Apps.copy093")} {inboxes.error.message}</p>
      <Button type="button" variant="outline" size="sm" disabled={busy || inboxes.isFetching} onClick={() => { void inboxes.refetch(); }}>
        {inboxes.isFetching ? t("pages.secrets.status.loading") : t("oct5Apps.copy094")}
      </Button>
    </div>}
    {step < 2 && resumeId === requestId && inboxes.isSuccess && !pendingEndpoint && <p role="alert" className="text-sm text-destructive">{t("oct5Apps.copy095")}</p>}
    {step < 2 && <ChatSetupNavigation labels={[t("pages.agentDetail.agentFallback"), t("sep12Connections.emailAddress")]} step={step}
      availableStep={step} disabled={busy} onSelect={index => { setup.reset(); setStep(index as 0 | 1); }} />}
    {step === 0 && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canContinue) connect.mutate(); }}>
      <div className="space-y-2">
        <Label htmlFor="email-agent">{t("pages.agentDetail.agentFallback")}</Label>
        <AgentSelect id="email-agent" value={agentId} disabled={busy || agents.isPending || !inboxes.isSuccess || !!pendingEndpoint}
          placeholder={t("sep12Connections.chooseAgent")} emptyMessage={t("oct5Apps.copy096")} triggerClassName="h-10"
          agents={(agents.data ?? []).filter(a => !["terminated", "pending_approval"].includes(a.status))}
          onChange={id => { setAgentId(id); setUsername((agents.data?.find(a => a.id === id)?.name ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64)); }} />
      </div>
      {!pendingAddress && <AgentMailCredentialField companyId={companyId} connectionId={selectedCredentialId}
        onConnectionChange={selectCredential} value={apiKey} onChange={value => { setApiKey(value); connect.reset(); }} disabled={busy} />}
      {restrictedInbox && <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{t("oct5Apps.restrictedKey", { inbox: restrictedInbox })}</p>
        <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy || !(selectedCredentialId || apiKey.trim())}
          onClick={() => { setAllowInboxKey(true); setRestrictedInbox(""); connect.reset(); }}>{t("oct5Apps.copy097")}</Button>
      </div>}
      {lowTrust && !scoped && <div role="alert" className="space-y-2 text-sm">
        <p>{t("oct5Apps.copy098")}</p>
        <Button type="button" variant="outline" size="sm" onClick={openTrust}>{t("oct5Apps.copy099")}</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>{t("pages.cliAuth.cancel")}</Button>
        <Button disabled={!canContinue}>{connect.isPending ? t("sep12Connections.connecting") : t("pages.inviteLanding.actions.continue")}<ArrowRight className="size-4" /></Button>
      </div>
    </form>}
    {step === 1 && <form className="space-y-6" onSubmit={event => { event.preventDefault(); if (canCreate) setup.mutate(); }}>
      <div className="space-y-2">
        <Label htmlFor={addressMode === "new" ? "email-name" : "email-existing"}>{t("oct5Apps.agentEmail", { agent: chosen?.name })}</Label>
        {pendingAddress ? <>
          <p className="text-sm font-medium">{pendingAddress}</p>
          <p className="text-sm text-muted-foreground">{t(scopedKey ? "oct5Apps.pendingAddress" : "oct5Apps.pendingAddressChoice", { agent: chosen?.name })}</p>
          {!scopedKey && <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={chooseAnotherAddress}>{t("oct5Apps.copy100")}</Button>}
        </> : addressMode === "new" ? <>
          <div className="flex items-center gap-2">
            <Input id="email-name" className="min-w-0" value={username} maxLength={64} autoComplete="off" spellCheck={false} disabled={busy}
              aria-invalid={!!addressError} aria-describedby={addressError ? "email-address-error" : "email-address-status"}
              onChange={event => { setUsername(event.target.value.toLowerCase()); setup.reset(); }} />
            <select id="email-domain" aria-label={t("oct5Apps.copy101")} className={`${selectClass} max-w-1/2 shrink-0`} value={domain}
              disabled={busy || !inspected.data} onChange={event => { setDomainSelected(true); setDomain(event.target.value); setup.reset(); }}>
              {[...new Set([...customDomains, "agentmail.to", domain])]
                .map(value => <option key={value} value={value}>@{value}</option>)}
            </select>
          </div>
        </> : <select id="email-existing" className={selectClass} value={pendingAddress ?? inboxId} disabled={busy || scopedKey || !!pendingAddress}
          aria-invalid={!!addressError} aria-describedby={addressError ? "email-address-error" : undefined}
          onChange={event => { setInboxId(event.target.value); setup.reset(); }}>
          <option value="">{t("oct5Apps.copy102")}</option>
          {inspected.data?.inboxes.map(i => {
            const assigned = inboxes.data?.some(e => e.id !== requestId && e.address === i.inbox_id && e.status !== "archived");
            return <option key={i.inbox_id} value={i.inbox_id} disabled={assigned}>{assigned ? t("oct5Apps.assignedInbox", { address: i.inbox_id }) : i.inbox_id}</option>;
          })}
        </select>}
        {scopedKey && !pendingAddress && <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy}
          onClick={() => { setAllowInboxKey(false); setStep(0); }}>{t("oct5Apps.copy103")}</Button>}
        {addressError && <p id="email-address-error" role="alert" className="text-sm text-destructive">{addressError}</p>}
        {checkingNewAddress && !addressError && <p id="email-address-status" role="status" className="text-sm text-muted-foreground">
          {addressCheck.checking ? t("oct5Apps.copy104") : addressCheck.error ? t("oct5Apps.addressCheckFailed", { error: addressCheck.error })
            : addressCheck.result?.status === "unknown" ? t("oct5Apps.copy105") : null}
        </p>}
        {suggestions.length > 0 && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" aria-label={t("oct5Apps.copy106")}>
          <span className="text-muted-foreground">{t("oct5Apps.copy107")}</span>
          {suggestions.map(name => <Button key={name} type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy}
            onClick={() => { setUsername(name); setup.reset(); }}>{name}@{domain}</Button>)}
        </div>}
        {!scopedKey && !pendingAddress && <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy}
          onClick={() => { setAddressMode(addressMode === "new" ? "existing" : "new"); setup.reset(); }}>
          {addressMode === "new" ? t("oct5Apps.copy108") : t("oct5Apps.copy109")}
        </Button>}
      </div>
      <Card className="py-4">
        <CardHeader className="px-4">
          <h2 className="text-sm font-medium">{t("oct5Apps.copy110")}</h2>
          <CardDescription>{t("oct5Apps.emailTasks", { agent: chosen?.name })}</CardDescription>
        </CardHeader>
      </Card>
      <details className="space-y-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("localizationSchemaForm.advancedOptions")}</summary>
        <div className="space-y-4">
          {addressMode === "new" && <div className="space-y-2">
            <a className="text-sm underline" href="https://docs.agentmail.to/custom-domains" target="_blank" rel="noreferrer">{t("oct5Apps.copy111")}</a>
          </div>}
          <div className="space-y-2">
            <Label htmlFor="email-mode">{t("oct5Apps.copy112")}</Label>
            <select id="email-mode" value={mode} disabled={busy} className={selectClass} onChange={event => setMode(event.target.value as typeof mode)}>
              <option value="websocket">{t("sep12Connections.liveConnection")}</option><option value="webhook">{t("localizationRoutines.webhook")}</option>
            </select>
          </div>
          <EmailSafetyNotice />
          <div className="space-y-2 text-sm">
            <p>{lowTrust && scoped ? t("sep12Connections.lowTrustConfigured") : t("oct5Apps.copy139")}</p>
            <Button type="button" variant="outline" size="sm" onClick={openTrust}>{t("sep12Connections.reviewTrust")}</Button>
          </div>
        </div>
      </details>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {inspected.isPending && <p role="status" className="text-sm text-muted-foreground">{t("oct5Apps.copy113")}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setup.reset(); setStep(0); }}><ArrowLeft className="size-4" />{t("pages.secrets.actions.back")}</Button>
        <Button disabled={!canCreate}>
          {setup.isPending ? t("sep12Connections.connecting") : pendingAddress ? t("oct5Apps.copy114") : addressMode === "new" ? t("oct5Apps.copy115") : t("oct5Apps.copy116")}<ArrowRight className="size-4" />
        </Button>
      </div>
    </form>}
    {step === 2 && <div className="space-y-6">
      <div className="space-y-2"><p className="flex items-center gap-2 font-medium"><Check className="size-4" />{setup.data?.address}</p>
        <p className="text-sm text-muted-foreground">{t("oct5Apps.receiveEmail", { agent: chosen?.name })}</p></div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <Button variant="ghost" onClick={leave}>{t("oct5Apps.copy117")}</Button><Button onClick={() => navigate("/apps")}>{t("common.done")}</Button>
      </div>
    </div>}
      <Dialog open={trustOpen} onOpenChange={setTrustOpen}>
        <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("sep12Connections.trustSettings", { agent: chosen?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("sep12Connections.trustChangesApply")}
            </DialogDescription>
          </DialogHeader>
          <TrustPresetSection
            permissions={permissions}
            onChange={setPermissions}
            companyId={companyId}
            projectCandidates={(projects.data ?? []).map((p) => ({
              id: p.id,
              label: p.name,
            }))}
            issueCandidates={(boundaryIssues.data ?? []).map((issue) => ({
              id: issue.id,
              label: `${issue.identifier} · ${issue.title}`,
            }))}
            allowSingleIssue={false}
            candidatesLoading={projects.isPending || boundaryIssues.isPending}
          />
          <p className="text-xs text-muted-foreground">
            {t("sep12Connections.lowTrustLimits")}
          </p>
          {(trust.error || projects.error || boundaryIssues.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(trust.error ?? projects.error ?? boundaryIssues.error)?.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTrustOpen(false)}>
              {t("sep12Connections.cancel")}
            </Button>
            <Button
              disabled={
                trust.isPending ||
                agentDetail.isPending ||
                !!agentDetail.error ||
                (getTrustPreset(permissions) === "low_trust_review" &&
                  !lowTrustBoundaryHasScope(getLowTrustBoundary(permissions)))
              }
              onClick={() => trust.mutate()}
            >
              {t("sep12Connections.saveTrustSettings")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  </div>;
}

export function EmailConnectionInboxes({
  companyId,
  connectionId,
  canConfigure,
}: {
  companyId: string;
  connectionId: string;
  canConfigure: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const children = new Set(
    connections.data?.connections
      .filter((c) => c.config?.credentialConnectionId === connectionId)
      .map((c) => c.id),
  );
  const inboxes =
    query.data?.filter(
      (i) => i.connectionId === connectionId || children.has(i.connectionId),
    ) ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {t("sep12Connections.giveAgentEmail")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("sep12Connections.eachConversationTask")}
          </p>
        </div>
        {canConfigure && (
          <Button asChild size="lg">
            <Link
              to={`/apps/chat/connect?provider=agentmail&connectionId=${connectionId}`}
            >
              {t("sep12Connections.giveAgentEmail")}
            </Link>
          </Button>
        )}
      </div>
      {inboxes.map((i) => (
        <div
          key={i.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
        >
          <Link
            className="text-sm underline"
            to={`/apps/chat/${i.id}/settings`}
          >
            {i.address}
          </Link>
          <span className="text-xs text-muted-foreground">
            {i.lastError ??
              (i.status === "active" ? t("sep12Connections.receivingEmail") : chatLabel(i.status))}
          </span>
        </div>
      ))}
      {!!inboxes.length && <EmailSafetyNotice />}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
    </section>
  );
}
export function EmailEndpointSettings({
  endpointId,
  companyId,
  assignedAgentName,
}: {
  endpointId: string;
  companyId: string;
  assignedAgentName: string;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["email-inboxes", companyId],
    queryFn: () => emailApi.list(companyId),
    refetchInterval: 10_000,
  });
  const inbox = query.data?.find(
    (row: EmailEndpointSummary) => row.id === endpointId,
  );
  const [removed, setRemoved] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [reconnectOpen, setReconnectOpen] = useState(false);
  useEffect(() => {
    if (inbox?.lastError) setReconnectOpen(true);
  }, [inbox?.lastError]);
  const [receiveMode, setReceiveMode] = useState<"websocket" | "webhook" | "">(
    "",
  );
  const reconnect = useMutation({
    mutationFn: () =>
      emailApi.reconnect(
        endpointId,
        replacementKey,
        receiveMode || inbox!.receiveMode,
      ),
    onSuccess: () => {
      setReplacementKey("");
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      emailApi.control(endpointId, action),
    onSuccess: (result) => {
      setRemoved(result.status === "archived");
      void cache.invalidateQueries({ queryKey: ["email-inboxes", companyId] });
    },
  });
  if (removed)
    return <p>{t("sep12Connections.inboxDisconnected")}</p>;
  if (!inbox)
    return (
      <p role={query.error ? "alert" : undefined}>
        {query.error?.message ?? t("sep12Connections.loadingInbox")}
      </p>
    );
  return (
    <div className="max-w-2xl space-y-8 pb-8">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("oct5Apps.agentEmail", { agent: assignedAgentName })}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 aria-label={inbox.address ?? undefined} className="min-w-0 break-all text-xl font-bold">
            {inbox.address ? (
              <CopyText text={inbox.address} ariaLabel={t("oct5Apps.copy118")} title={t("oct5Apps.copy118")}
                containerClassName="max-w-full" className="flex min-w-0 items-center gap-2 rounded-md text-left">
                <span className="min-w-0 break-all">{inbox.address}</span>
                <Copy aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </CopyText>
            ) : t("oct5Apps.copy119")}
          </h1>
          {inbox.address && (
            <a href={`https://console.agentmail.to/dashboard/inboxes/${encodeURIComponent(inbox.address)}`}
              target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">{t("oct5Apps.copy120")}<ExternalLink aria-hidden="true" className="size-3" />
            </a>
          )}
        </div>
        {inbox.status === "active" && inbox.address && (
          <p className="text-sm text-muted-foreground">
            {t("oct5Apps.sendEmailTask", { agent: assignedAgentName })}
          </p>
        )}
      </header>

      <Card className="gap-2 p-4">
        <h2 className="text-sm font-semibold">{t("oct5Apps.copy110")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("oct5Apps.emailTasksInternal", { agent: assignedAgentName })}
        </p>
      </Card>

      <section aria-labelledby="email-receiving-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 id="email-receiving-heading" className="text-sm font-semibold">{t("oct5Apps.copy121")}</h2>
            {(inbox.status !== "active" || inbox.lastError) && (
              <StatusBadge status={inbox.status === "active" ? "attention" : inbox.status}
                label={inbox.status === "active" ? t("status.attention") : inbox.status === "revoked" ? t("oct5Apps.copy122") : undefined} />
            )}
          </div>
          {["active", "paused"].includes(inbox.status) && (
            <Button variant="outline" size="sm" disabled={control.isPending}
              onClick={() => control.mutate(inbox.status === "active" ? "pause" : "resume")}>
              {inbox.status === "active" ? t("localizationRoutines.pause") : t("pages.agentDetail.resume")}
            </Button>
          )}
        </div>
        {inbox.status === "paused" && (
          <p className="text-sm text-muted-foreground">{t("oct5Apps.copy123")}</p>
        )}
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("sep12Connections.receivingMode")}</dt>
            <dd className="text-sm">{inbox.receiveMode === "websocket" ? t("sep12Connections.liveConnection") : t("localizationRoutines.webhook")}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("oct5Apps.copy124")}</dt>
            <dd className="font-mono text-xs">{inbox.lastSyncAt ? formatDateTime(inbox.lastSyncAt) : t("oct5Apps.copy125")}</dd>
          </div>
        </dl>
        {inbox.lastError && <p role="alert" className="text-sm text-destructive">{inbox.lastError}</p>}
        {control.error && control.variables !== "remove" && (
          <p role="alert" className="text-sm text-destructive">{control.error.message}</p>
        )}
      </section>

      <details open={reconnectOpen} onToggle={(event) => setReconnectOpen(event.currentTarget.open)} className="border-t border-border pt-5">
        <summary className="cursor-pointer text-sm font-medium">{t("sep12Connections.reconnectInbox")}</summary>
        <div className="space-y-4 pt-4">
          <p className="text-sm text-muted-foreground">{t("oct5Apps.copy126")}</p>
          <AgentMailApiKeyField label={t("oct5Apps.copy034")} value={replacementKey} onChange={setReplacementKey} disabled={reconnect.isPending} />
          <div className="space-y-2">
            <Label htmlFor="email-reconnect-mode">{t("sep12Connections.receivingMode")}</Label>
            <select id="email-reconnect-mode" className={selectClass}
              disabled={reconnect.isPending} value={receiveMode || inbox.receiveMode}
              onChange={(e) => setReceiveMode(e.target.value as "websocket" | "webhook")}>
              <option value="websocket">{t("sep12Connections.liveConnection")}</option>
              <option value="webhook">{t("localizationRoutines.webhook")}</option>
            </select>
          </div>
          {reconnect.error && <p role="alert" className="text-sm text-destructive">{reconnect.error.message}</p>}
          {reconnect.isSuccess && <p role="status" className="text-sm">{t("oct5Apps.copy127")}</p>}
          <div className="flex justify-end">
            <Button variant="outline" disabled={!replacementKey || reconnect.isPending} onClick={() => reconnect.mutate()}>
              {reconnect.isPending ? t("localizationActivity.reconnecting") : t("sep12Connections.reconnectInbox")}
            </Button>
          </div>
        </div>
      </details>

      <section aria-labelledby="email-disconnect-heading" className="space-y-3 border-t border-border pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 id="email-disconnect-heading" className="text-sm font-semibold">{t("sep12Connections.disconnectInbox")}</h2>
            <p className="text-sm text-muted-foreground">{t("oct5Apps.copy128")}</p>
          </div>
          <Button variant="outline" size="sm" disabled={control.isPending}
            onClick={() => control.mutate("remove")}>{t("sep12Connections.disconnectInbox")}</Button>
        </div>
        {control.error && control.variables === "remove" && (
          <p role="alert" className="text-sm text-destructive">{control.error.message}</p>
        )}
      </section>
    </div>
  );
}
