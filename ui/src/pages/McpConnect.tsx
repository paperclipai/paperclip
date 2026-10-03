import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import type { McpConnection, McpConnectionRequest } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "../api/client";

export function McpConnectPage() {
  const { id = "" } = useParams();
  return <McpConnectRequest key={id} id={id} />;
}

function McpConnectRequest({ id }: { id: string }) {
  const [companyId, setCompanyId] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const request = useQuery({ queryKey: ["mcp-request", id], queryFn: () => api.get<McpConnectionRequest>(`/mcp/requests/${encodeURIComponent(id)}`), retry: false });
  const consent = useMutation({
    mutationFn: (decision: "approve" | "deny") => api.post<{ redirectUrl: string }>(`/mcp/requests/${encodeURIComponent(id)}/consent`, { decision, companyId: companyId || undefined, allowWrites }),
    onSuccess: ({ redirectUrl }) => { window.location.assign(redirectUrl); },
  });
  const data = request.data;
  const company = data?.companies.find((item) => item.id === companyId);
  return <div className="mx-auto max-w-xl py-10">
    <Card className="block space-y-4 p-6">
      <h1 className="text-xl font-semibold">Connect your assistant to Paperclip</h1>
      {request.isPending && <p className="text-sm text-muted-foreground">Loading connection request…</p>}
      {request.error && <p className="text-sm text-destructive">{request.error.message} Start a new connection from your assistant.</p>}
      {data && <>
        <p className="text-sm"><strong>{data.clientName}</strong> is requesting access. The connection returns to <span className="font-mono">{data.redirectOrigin}</span>.</p>
        {data.requiresSignIn ? <Button asChild><Link to={`/auth?next=${encodeURIComponent(`/mcp-connect/${id}`)}`}>Sign in / Create account</Link></Button> : <>
          <p className="text-sm text-muted-foreground">Choose the team this assistant may use as you. Your permissions and attribution apply to every action.</p>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Team</legend>
            {data.companies.map((item) => <label key={item.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name="company" value={item.id} checked={companyId === item.id} onChange={() => { setCompanyId(item.id); setAllowWrites(false); }} />{item.name}
            </label>)}
            {!data.companies.length && <p className="text-sm text-muted-foreground">{data.setupUrl ? "No team is available for this account yet. Create a hosted team, configure its agents and spending, then return here. If this request expires, reconnect from your assistant." : "This account has no available teams. Ask a team owner to add you, then reconnect from your assistant."}</p>}
          </fieldset>
          <p className="text-sm">Read agents, projects, tasks, comments, documents, deliverables and pending approvals.</p>
          {data.requestedWrite && <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={allowWrites} disabled={!company?.canWrite} onChange={(event) => setAllowWrites(event.target.checked)} />
            <span>Also allow creating tasks and adding comments as me. These actions can start or wake agents and use my team's configured execution budget.</span>
          </label>}
          {company && !company.canWrite && <p className="text-sm text-muted-foreground">Your role in this team is read-only.</p>}
          {data.offlineAccess && <p className="text-sm text-muted-foreground">This connection can stay signed in between conversations. You can revoke it at any time.</p>}
          <p className="text-sm text-muted-foreground">Approval decisions stay in Paperclip. Installing a plugin does not create a team, configure model credentials, or start paid work.</p>
          {data.setupUrl && <Button variant="outline" asChild><a href={data.setupUrl} target="_blank" rel="noopener noreferrer">Create a hosted team</a></Button>}
          {consent.error && <p className="text-sm text-destructive">{consent.error.message}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" disabled={consent.isPending} onClick={() => consent.mutate("deny")}>Cancel</Button>
            <Button disabled={!company || consent.isPending} onClick={() => consent.mutate("approve")}>{consent.isPending ? "Connecting…" : "Connect team"}</Button>
          </div>
        </>}
        <Link className="text-sm underline" to="/assistant-connections">Manage assistant connections</Link>
      </>}
    </Card>
  </div>;
}

export function AssistantConnectionsPage() {
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.get<McpConnection[]>("/mcp/connections"), retry: false });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/mcp/connections/${id}`), onSuccess: () => { void connections.refetch(); } });
  return <div className="mx-auto max-w-xl space-y-4 py-10">
    <h1 className="text-xl font-semibold">Assistant connections</h1>
    <p className="text-sm text-muted-foreground">Revoking a connection stops its future tool calls. Work already delegated continues under your team's normal controls.</p>
    {connections.isPending && <p className="text-sm">Loading connections…</p>}
    {(connections.error || revoke.error) && <p className="text-sm text-destructive">{(connections.error ?? revoke.error)?.message}</p>}
    {connections.data?.length === 0 && <p className="text-sm">No assistant connections.</p>}
    {connections.data?.map((connection) => <Card key={connection.id} className="block space-y-2 p-4">
      <h2 className="font-medium">{connection.clientName}</h2>
      <p className="text-sm text-muted-foreground">Team: {connection.companyName}</p>
      <p className="text-sm">{connection.scopes.includes("paperclip:write") ? "Read, create tasks and comment" : "Read only"}</p>
      {connection.revokedAt ? <p className="text-sm text-muted-foreground">Revoked</p> : <Button variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate(connection.id)}>Revoke connection</Button>}
    </Card>)}
    <Link className="text-sm underline" to="/">Back to Paperclip</Link>
  </div>;
}
