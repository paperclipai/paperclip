import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Paperclip } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import type { McpConnection, McpConnectionRequest, McpDotPairingPreview } from "@paperclipai/shared";
import { deriveInitials, Identity } from "@/components/Identity";
import { assistantConnectionDisplayName } from "./apps/connection-owner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { api } from "../api/client";

// Bundle known-origin icons so opening consent never contacts a client-selected site.
// Client-supplied names never select branding.
function ClientOrigin({ origin }: { origin: string }) {
  const [failed, setFailed] = useState(false);
  let favicon: string | undefined;
  try {
    const url = new URL(origin);
    if (url.origin === "https://claude.ai") favicon = "/brands/claude-color.svg";
    else if (["https://chatgpt.com", "https://chat.openai.com", "https://openai.com"].includes(url.origin)) favicon = "/brands/codex-color.svg";
  } catch { /* An unavailable origin keeps the neutral site icon. */ }
  return <div className="flex items-center gap-2 text-sm text-muted-foreground">
    {favicon && !failed ? <img src={favicon} alt="" className="size-4 shrink-0 object-contain" referrerPolicy="no-referrer" crossOrigin="anonymous" onError={() => setFailed(true)} /> : <Globe className="size-4 shrink-0" aria-hidden="true" />}
    <bdi className="min-w-0 break-all">{origin}</bdi>
  </div>;
}

export function McpConnectPage() {
  const { id = "" } = useParams();
  return <McpConnectRequest key={id} id={id} />;
}

export function McpDevicePage({ initialCode }: { initialCode?: string } = {}) {
  const [code, setCode] = useState(initialCode ?? new URLSearchParams(window.location.search).get("user_code") ?? "");
  const [submitted, setSubmitted] = useState(code);
  if (submitted) return <McpConnectRequest key={submitted} id={submitted} device onEditCode={() => setSubmitted("")} />;
  return <div className="mx-auto max-w-xl py-10"><Card className="space-y-4 p-6"><div className="flex items-center gap-3"><Paperclip className="size-8 shrink-0" /><h1 className="min-w-0 text-xl font-semibold">Connect your assistant to Paperclip</h1></div>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); setSubmitted(code.trim()); }}>
      <label htmlFor="device-code" className="text-sm">Enter the code shown by your assistant</label>
      <Input id="device-code" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required maxLength={12} />
      <div className="flex justify-end"><Button type="submit">Continue</Button></div>
    </form></Card></div>;
}

function McpConnectRequest({ id, device = false, onEditCode }: { id: string; device?: boolean; onEditCode?: () => void }) {
  const [companyId, setCompanyId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingPreview, setPairingPreview] = useState<McpDotPairingPreview | null>(null);
  const [pairingPreviewError, setPairingPreviewError] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(true);
  const [deviceResult, setDeviceResult] = useState<"approved" | "denied" | null>(null);
  const request = useQuery({ queryKey: [device ? "mcp-device" : "mcp-request", id], queryFn: () => api.get<McpConnectionRequest>(device ? `/mcp/device?user_code=${encodeURIComponent(id)}` : `/mcp/requests/${encodeURIComponent(id)}`), retry: false });
  const data = request.data;
  useEffect(() => {
    setPairingPreview(null); setPairingPreviewError("");
    if (!data?.agentConnection || device || !/^[A-Za-z0-9_-]{32}$/.test(pairingCode.trim())) return;
    let current = true;
    void api.post<McpDotPairingPreview>(`/mcp/requests/${encodeURIComponent(id)}/dot-pairing/preview`, { pairingCode: pairingCode.trim() })
      .then(preview => { if (current) setPairingPreview(preview); })
      .catch(error => { if (current) setPairingPreviewError(error instanceof Error ? error.message : "Unable to verify this pairing code."); });
    return () => { current = false; };
  }, [id, device, data?.agentConnection, pairingCode]);
  const selectedCompanyId = data?.requestedCompanyId ?? (companyId || data?.companies[0]?.id || "");
  // Pin the default once loaded so a refetch cannot silently switch organizations.
  useEffect(() => {
    if (!companyId && !data?.requestedCompanyId && data?.companies[0]) setCompanyId(data.companies[0].id);
  }, [companyId, data]);
  const clientName = data?.clientName.trim();
  const assistantName = clientName && !/^(assistant|mcp client)$/i.test(clientName) ? clientName : "your assistant";
  const clientOrigin = data?.clientOrigin || data?.redirectOrigin;
  const company = data?.companies.find((item) => item.id === selectedCompanyId);
  const canApproveWrites = Boolean(!data?.agentConnection && company?.canWrite && writeEnabled);
  const allowWrites = Boolean(data?.requestedWrite && canApproveWrites);
  const allowConfiguration = Boolean(data?.requestedConfigure && canApproveWrites);
  const consent = useMutation({
    mutationFn: (decision: "approve" | "deny") => api.post<{ redirectUrl?: string; status?: "approved" | "denied" }>(device ? "/mcp/device/consent" : `/mcp/requests/${encodeURIComponent(id)}/consent`, { decision, companyId: selectedCompanyId || undefined, allowWrites: decision === "approve" && allowWrites, allowConfiguration: decision === "approve" && allowConfiguration, ...(device ? { userCode: id } : {}) }),
    onSuccess: ({ redirectUrl, status }) => { if (device && status) setDeviceResult(status); else if (redirectUrl) window.location.assign(redirectUrl); },
  });
  const pairDot = useMutation({
    mutationFn: () => api.post<{ redirectUrl: string }>(`/mcp/requests/${encodeURIComponent(id)}/dot-pairing`, { pairingCode: pairingCode.trim() }),
    onSuccess: ({ redirectUrl }) => { setPairingCode(""); window.location.assign(redirectUrl); },
  });
  if (deviceResult) return <div className="mx-auto max-w-xl py-10"><Card className="block space-y-4 p-6"><Paperclip className="size-8" /><h1 className="text-xl font-semibold">{deviceResult === "approved" ? "Access approved" : "Connection declined"}</h1><p className="text-sm">{deviceResult === "approved" ? "Return to your assistant. It will finish connecting automatically." : "No access was granted. You can start a new connection from your assistant."}</p><Button variant="outline" asChild><Link to="/">Back to Paperclip</Link></Button></Card></div>;
  const returnPath = device ? `/mcp-device?user_code=${encodeURIComponent(id)}` : `/mcp-connect/${id}`;
  return <div className="mx-auto max-w-xl py-10">
    <Card className="block space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Paperclip className="size-8 shrink-0 text-foreground" role="img" aria-label="Paperclip" />
        <h1 className="min-w-0 break-words text-xl font-semibold">Connect <bdi>{assistantName}</bdi> to Paperclip</h1>
      </div>
      {clientOrigin && <ClientOrigin key={clientOrigin} origin={clientOrigin} />}
      {!device && data?.redirectOrigin && data.redirectOrigin !== clientOrigin && <ClientOrigin key={data.redirectOrigin} origin={data.redirectOrigin} />}
      {device && <p className="text-sm">Confirm this matches the code shown by your assistant: <strong className="font-mono">{id.toUpperCase()}</strong></p>}
      {request.isPending && <p className="text-sm text-muted-foreground">Loading connection request…</p>}
      {request.error && <p className="text-sm text-destructive">{request.error.message} Start a new connection from your assistant.</p>}
      {device && request.error && <Button variant="outline" onClick={onEditCode}>Enter a different code</Button>}
      {data?.agentConnection && !device && <form className="space-y-3" onSubmit={event => { event.preventDefault(); pairDot.mutate(); }}>
        <p className="text-sm">Enter the one-use code from your Dot setup prompt to review this agent’s access. Access is granted when you click “Connect Dot with pairing code”.</p>
        <label htmlFor="dot-pairing-code" className="text-sm">Pairing code</label>
        <Input id="dot-pairing-code" type="password" autoComplete="off" value={pairingCode} onChange={event => { setPairingPreview(null); setPairingPreviewError(""); setPairingCode(event.target.value); }} required maxLength={32} />
        {pairingPreview && <dl className="space-y-2 rounded-md border border-border p-3 text-sm">
          <div><dt className="text-muted-foreground">Company</dt><dd>{pairingPreview.company.name} <span className="text-xs text-muted-foreground">({pairingPreview.company.id})</span></dd></div>
          <div><dt className="text-muted-foreground">Agent</dt><dd>{pairingPreview.agent.name} <span className="text-xs text-muted-foreground">({pairingPreview.agent.id})</span></dd></div>
          <div><dt className="text-muted-foreground">Permissions</dt><dd>{pairingPreview.permissions}</dd></div>
          <div><dt className="text-muted-foreground">Access duration</dt><dd>{pairingPreview.accessDuration}</dd></div>
        </dl>}
        {pairingPreviewError && <p role="alert" className="text-sm text-destructive">{pairingPreviewError}</p>}
        {pairDot.error && <p role="alert" className="text-sm text-destructive">{pairDot.error.message}</p>}
        <div className="flex justify-end"><Button type="submit" disabled={!pairingPreview || !/^[A-Za-z0-9_-]{32}$/.test(pairingCode.trim()) || pairDot.isPending}>{pairDot.isPending ? "Connecting…" : "Connect Dot with pairing code"}</Button></div>
      </form>}
      {data && <>
        {data.requiresSignIn ? <Button asChild><Link to={`/auth?next=${encodeURIComponent(returnPath)}`}>Sign in / Create account</Link></Button> : <>
          {data.requestedCompanyId ? <div className="flex items-center gap-4 rounded-md border border-border p-4">
            {company && <CompanyPatternIcon companyName={company.name} logoUrl={company.logoUrl} className="size-14 shrink-0 rounded-lg text-xl" />}
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Organization</p>
              {company ? <p className="break-words text-lg font-semibold">{company.name}</p> : <p className="text-sm text-destructive">The selected organization is no longer available to this account. Cancel and reconnect from your assistant to choose an organization you can access.</p>}
            </div>
          </div> : <fieldset className="space-y-2" disabled={consent.isPending}>
            <legend className="mb-2 text-sm font-medium">Organization</legend>
            {data.companies.map((item) => <label key={item.id} className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
              <input type="radio" name="company" aria-label={item.name} value={item.id} checked={selectedCompanyId === item.id} onChange={() => setCompanyId(item.id)} />
              <CompanyPatternIcon companyName={item.name} logoUrl={item.logoUrl} className="size-12 shrink-0 rounded-lg" />
              <span className="min-w-0 break-words font-medium">{item.name}</span>
            </label>)}
            {!data.companies.length && <p className="text-sm text-muted-foreground">This account has no available organizations. Ask an organization owner to add you, then reconnect from your assistant.</p>}
          </fieldset>}
          <p className="text-sm">{data.agentConnection ? "Connect Dot as a Paperclip agent. Pair it with an agent after connecting; assigned work uses that agent’s permissions." : "Read all of your Paperclip data"}</p>
          {(data.requestedWrite || data.requestedConfigure) && !data.agentConnection && <label htmlFor="mcp-allow-writes" className="flex items-start gap-3 text-sm leading-6">
            <span className="flex h-6 shrink-0 items-center">
              <Checkbox id="mcp-allow-writes" checked={canApproveWrites} disabled={!company?.canWrite || consent.isPending} onCheckedChange={(checked) => setWriteEnabled(checked === true)} />
            </span>
            <span>Write all of your Paperclip data</span>
          </label>}
          {company && !company.canWrite && <p className="text-sm text-muted-foreground">Your role in this organization is read-only.</p>}
          {consent.error && <p className="text-sm text-destructive">{consent.error.message}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" disabled={consent.isPending} onClick={() => consent.mutate("deny")}>Cancel</Button>
            <Button className="h-auto min-h-10 min-w-0 shrink whitespace-normal" disabled={!company || (data.agentConnection && !company.canWrite) || consent.isPending} onClick={() => consent.mutate("approve")}>{consent.isPending ? "Connecting…" : data.agentConnection ? "Connect Dot agent" : "Connect organization"}</Button>
          </div>
        </>}
      </>}
    </Card>
  </div>;
}

export function AssistantConnectionsPage() {
  const client = useQueryClient();
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.get<McpConnection[]>("/mcp/connections"), retry: false });
  const active = connections.data?.filter(connection => !connection.revokedAt);
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/mcp/connections/${id}`), onSuccess: (_, id) => {
    client.setQueryData<McpConnection[]>(["mcp-connections"], rows => rows?.filter(row => row.id !== id));
    return client.invalidateQueries({ queryKey: ["mcp-connections"] });
  } });
  return <div className="mx-auto max-w-xl space-y-4 py-10">
    <h1 className="text-xl font-semibold">Assistant connections</h1>
    <p className="text-sm text-muted-foreground">Revoking a connection stops its future tool calls. Work already delegated continues under your organization’s normal controls.</p>
    {connections.isPending && <p className="text-sm">Loading connections…</p>}
    {(connections.error || revoke.error) && <p className="text-sm text-destructive">{(connections.error ?? revoke.error)?.message}</p>}
    {active?.length === 0 && <p className="text-sm">No assistant connections.</p>}
    {active?.map((connection) => <Card key={connection.id} className="block space-y-2 p-4">
      <h2 className="font-medium"><Identity name={assistantConnectionDisplayName(connection)} avatarUrl={connection.user?.image} initials={deriveInitials(connection.user?.name ?? "You")} /></h2>
      <p className="text-sm text-muted-foreground">Organization: {connection.companyName}</p>
      <p className="text-sm">{connection.scopes.includes("paperclip:agent") ? "Dot agent connection" : connection.scopes.includes("paperclip:write") ? "Read and edit work" : "Read only"}</p>
      {connection.scopes.includes("paperclip:configure") && <p className="text-sm">Configure agents, projects and skills</p>}
      <Button variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate(connection.id)}>Revoke connection</Button>
    </Card>)}
    <Link className="text-sm underline" to="/">Back to Paperclip</Link>
  </div>;
}
