import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import type { McpConnection, McpConnectionRequest } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { api } from "../api/client";

export function McpConnectPage() {
  const { id = "" } = useParams();
  return <McpConnectRequest key={id} id={id} />;
}

function McpConnectRequest({ id }: { id: string }) {
  const [companyId, setCompanyId] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(true);
  const request = useQuery({ queryKey: ["mcp-request", id], queryFn: () => api.get<McpConnectionRequest>(`/mcp/requests/${encodeURIComponent(id)}`), retry: false });
  const data = request.data;
  const selectedCompanyId = data?.requestedCompanyId ?? companyId;
  const company = data?.companies.find((item) => item.id === selectedCompanyId);
  const allowWrites = Boolean(data?.requestedWrite && company?.canWrite && writeEnabled);
  const consent = useMutation({
    mutationFn: (decision: "approve" | "deny") => api.post<{ redirectUrl: string }>(`/mcp/requests/${encodeURIComponent(id)}/consent`, { decision, companyId: selectedCompanyId || undefined, allowWrites }),
    onSuccess: ({ redirectUrl }) => { window.location.assign(redirectUrl); },
  });
  return <div className="mx-auto max-w-xl py-10">
    <Card className="block space-y-4 p-6">
      <Paperclip className="size-8 text-foreground" role="img" aria-label="Paperclip" />
      <h1 className="text-xl font-semibold">Connect your assistant to Paperclip</h1>
      {data && <p className="break-words text-sm">Access for <bdi className="font-medium">{data.clientName}</bdi> · <bdi className="text-muted-foreground">{data.redirectOrigin}</bdi></p>}
      {request.isPending && <p className="text-sm text-muted-foreground">Loading connection request…</p>}
      {request.error && <p className="text-sm text-destructive">{request.error.message} Start a new connection from your assistant.</p>}
      {data && <>
        {data.requiresSignIn ? <Button asChild><Link to={`/auth?next=${encodeURIComponent(`/mcp-connect/${id}`)}`}>Sign in / Create account</Link></Button> : <>
          {data.requestedCompanyId ? <div className="flex items-center gap-4 rounded-md border border-border p-4">
            {company && <CompanyPatternIcon companyName={company.name} logoUrl={company.logoUrl} className="size-14 shrink-0 rounded-lg text-xl" />}
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">Organization</p>
              {company ? <p className="break-words text-lg font-semibold">{company.name}</p> : <p className="text-sm text-destructive">The selected organization is no longer available to this account. Cancel and reconnect from your assistant to choose an organization you can access.</p>}
            </div>
          </div> : <fieldset className="space-y-2" disabled={consent.isPending}>
            <legend className="mb-2 text-sm font-medium">Organization</legend>
            {data.companies.map((item) => <label key={item.id} className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
              <input type="radio" name="company" aria-label={item.name} value={item.id} checked={companyId === item.id} onChange={() => setCompanyId(item.id)} />
              <CompanyPatternIcon companyName={item.name} logoUrl={item.logoUrl} className="size-12 shrink-0 rounded-lg" />
              <span className="min-w-0 break-words font-medium">{item.name}</span>
            </label>)}
            {!data.companies.length && <p className="text-sm text-muted-foreground">{data.setupUrl ? "No organization is available for this account yet. Create a hosted organization, configure its agents and spending, then return here. If this request expires, reconnect from your assistant." : "This account has no available organizations. Ask an organization owner to add you, then reconnect from your assistant."}</p>}
          </fieldset>}
          <p className="text-sm">Read all of your Paperclip data</p>
          {data.requestedWrite && <label htmlFor="mcp-allow-writes" className="flex items-start gap-3 text-sm leading-6">
            <span className="flex h-6 shrink-0 items-center">
              <Checkbox id="mcp-allow-writes" checked={allowWrites} disabled={!company?.canWrite || consent.isPending} onCheckedChange={(checked) => setWriteEnabled(checked === true)} />
            </span>
            <span>Allow write access and creating tasks as me</span>
          </label>}
          {company && !company.canWrite && <p className="text-sm text-muted-foreground">Your role in this organization is read-only.</p>}
          {data.setupUrl && !data.requestedCompanyId && <Button variant="outline" asChild><a href={data.setupUrl} target="_blank" rel="noopener noreferrer">Create a hosted organization</a></Button>}
          {consent.error && <p className="text-sm text-destructive">{consent.error.message}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" disabled={consent.isPending} onClick={() => consent.mutate("deny")}>Cancel</Button>
            <Button disabled={!company || consent.isPending} onClick={() => consent.mutate("approve")}>{consent.isPending ? "Connecting…" : "Connect organization"}</Button>
          </div>
        </>}
      </>}
    </Card>
  </div>;
}

export function AssistantConnectionsPage() {
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.get<McpConnection[]>("/mcp/connections"), retry: false });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/mcp/connections/${id}`), onSuccess: () => { void connections.refetch(); } });
  return <div className="mx-auto max-w-xl space-y-4 py-10">
    <h1 className="text-xl font-semibold">Assistant connections</h1>
    <p className="text-sm text-muted-foreground">Revoking a connection stops its future tool calls. Work already delegated continues under your organization’s normal controls.</p>
    {connections.isPending && <p className="text-sm">Loading connections…</p>}
    {(connections.error || revoke.error) && <p className="text-sm text-destructive">{(connections.error ?? revoke.error)?.message}</p>}
    {connections.data?.length === 0 && <p className="text-sm">No assistant connections.</p>}
    {connections.data?.map((connection) => <Card key={connection.id} className="block space-y-2 p-4">
      <h2 className="font-medium">{connection.clientName}</h2>
      <p className="text-sm text-muted-foreground">Organization: {connection.companyName}</p>
      <p className="text-sm">{connection.scopes.includes("paperclip:write") ? "Read, create tasks and comment" : "Read only"}</p>
      {connection.revokedAt ? <p className="text-sm text-muted-foreground">Revoked</p> : <Button variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate(connection.id)}>Revoke connection</Button>}
    </Card>)}
    <Link className="text-sm underline" to="/">Back to Paperclip</Link>
  </div>;
}
