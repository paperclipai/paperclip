import { useEffect, useState } from "react";
import { assistantClientNames, mcpAuthorizationHandoffInstructions, mcpInvitation, mcpSetupSteps, type AssistantClient, type McpConnection } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Globe, Paperclip, Plug, Terminal } from "lucide-react";
import { publicMcpApi } from "@/api/publicMcp";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";
import { deriveInitials, Identity } from "@/components/Identity";
import { assistantConnectionDisplayName } from "./connection-owner";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const ASSISTANT_CONNECTION_PATH = "/apps/assistant-connection";
const connectionsKey = ["mcp-connections"];
type Assistant = AssistantClient;
const assistants = assistantClientNames;

function AssistantIcon({ assistant }: { assistant: Assistant }) {
  if (assistant === "codex" || assistant === "claude") return <img src={`/brands/${assistant}-color.svg`} alt="" className="size-4 shrink-0" />;
  if (assistant === "opencode") return <span aria-hidden="true" className="inline-flex shrink-0"><OpenCodeLogoIcon className="size-4" /></span>;
  const Icon = assistant === "browser" ? Globe : assistant === "headless" ? Terminal : Plug;
  return <Icon className="size-4" aria-hidden="true" />;
}

export function useAssistantConnections(poll = false) {
  const { selectedCompanyId } = useCompany();
  const query = useQuery({
    queryKey: connectionsKey, queryFn: publicMcpApi.connections,
    enabled: Boolean(selectedCompanyId), refetchInterval: poll ? 5000 : false,
  });
  const view = useQueryView(query);
  return {
    ...query,
    view,
    /** Loaded rows are shown through a transient refetch failure (`stale`) as well as `ready`. */
    loaded: view.kind === "ready" || view.kind === "stale",
    rows: (query.data ?? []).filter(row => row.companyId === selectedCompanyId && !row.revokedAt && !row.scopes.includes("paperclip:agent")),
  };
}

/** Inbound assistant access belongs beside the existing outbound connectors. */
export function AssistantConnectionCard({ onNavigate }: { onNavigate: (href: string) => void }) {
  const connections = useAssistantConnections();
  const active = connections.rows;
  const action = !connections.loaded ? "Open" : active.length ? "Manage" : "Set up";
  return <div role="listitem" data-app-slug="assistant-connection" data-connected={connections.loaded ? String(active.length > 0) : undefined} className="overflow-hidden rounded-xl border border-border">
    <div className="flex flex-wrap items-center gap-3 px-4 py-4">
      <Paperclip className="size-9 shrink-0 p-1 text-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">Assistant Connection (MCP)</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Use your Paperclip organization from Codex, Claude, OpenCode, or another assistant.</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onNavigate(ASSISTANT_CONNECTION_PATH)} aria-label={`${action} Assistant Connection (MCP)`}>{action}</Button>
    </div>
    {(connections.isPending || connections.view.kind === "reconnecting") && <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">Checking your connection status…</p>}
    {connections.view.kind === "error" && <div className="border-t border-border px-4 py-3">
      <QueryErrorState error={connections.error} action="load your connection status" onRetry={connections.view.retry} retrying={connections.view.isFetching} />
    </div>}
    {connections.loaded && active.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-sm">
      {active.map(row => <Identity key={row.id} name={assistantConnectionDisplayName(row)} avatarUrl={row.user?.image} initials={deriveInitials(row.user?.name ?? "You")} size="sm" />)}
    </div>}
  </div>;
}

/** Only copy user-visible, non-secret setup values. Never execute them here. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setCopied(false); setError(false); }, [value]);
  return <div className="space-y-2">
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{value}</pre>
      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Copy ${label}`} onClick={async () => {
        try { await copyTextToClipboard(value); setCopied(true); setError(false); }
        catch { setError(true); }
      }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
    </div>
    <p role="status" className="text-xs text-muted-foreground">{error ? "Couldn’t copy. Select and copy the text above." : copied ? "Copied" : null}</p>
  </div>;
}

/** Setup copy that depends on the instance, not on the request: signed out, or no public URL configured. */
function setupUnavailableCopy(errorKind: "auth" | "not_found"): string {
  if (errorKind === "auth") return "Sign in to connect an assistant. This requires a Paperclip instance with authenticated user accounts.";
  return "Assistant connections need an authenticated instance with a public HTTPS URL. Ask your instance administrator to configure the public URL, then try again.";
}

export function AssistantConnection({ initialAssistant = "codex" }: { initialAssistant?: Assistant } = {}) {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const [assistant, setAssistant] = useState<Assistant>(initialAssistant);
  const setup = useQuery({ queryKey: ["mcp-setup"], queryFn: publicMcpApi.setup, refetchOnWindowFocus: "always", refetchOnMount: "always" });
  const setupView = useQueryView(setup);
  const connections = useAssistantConnections(setup.data?.enabled === true);
  const revoke = useMutation({ mutationFn: publicMcpApi.revoke, onSuccess: (_, id) => {
    client.setQueryData<McpConnection[]>(connectionsKey, rows => rows?.filter(row => row.id !== id));
    return client.invalidateQueries({ queryKey: connectionsKey });
  } });
  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors", href: "/apps" }, { label: "Assistant Connection (MCP)" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  if (!selectedCompanyId || !selectedCompany) return <p className="text-sm text-muted-foreground">Select an organization to connect an assistant.</p>;
  const serverUrl = setup.data?.serverUrl ?? "";
  const invitation = serverUrl ? mcpInvitation(serverUrl, { id: selectedCompanyId, name: selectedCompany.name }) : "";
  return <div className="max-w-3xl space-y-6 pb-8">
    <header className="space-y-4">
      <div className="flex items-center gap-3"><Paperclip className="size-7 shrink-0" /><h1 className="text-xl font-semibold">Assistant Connection (MCP)</h1></div>
      <div className="flex items-center gap-3">
        <CompanyPatternIcon companyName={selectedCompany.name} logoUrl={selectedCompany.logoUrl} className="size-12 shrink-0 rounded-lg" />
        <div className="space-y-1"><p className="font-medium">{selectedCompany.name}</p><p className="text-sm text-muted-foreground">Connect your assistant to Paperclip. Review work, create tasks, and follow up using your account’s access to this organization.</p></div>
      </div>
    </header>
    {(setup.isPending || setupView.kind === "reconnecting") && <p className="text-sm text-muted-foreground">Loading assistant setup…</p>}
    {setupView.kind === "error" && (setupView.errorKind === "auth" || setupView.errorKind === "not_found"
      ? <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{setupUnavailableCopy(setupView.errorKind)}</p><Button variant="outline" disabled={setupView.isFetching} onClick={setupView.retry}>Try again</Button></div>
      : <QueryErrorState error={setup.error} action="load assistant setup" onRetry={setupView.retry} retrying={setupView.isFetching} />)}
    {setup.data && !setup.data.enabled && <section className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <h2 className="text-sm font-semibold">Enable assistant connections</h2>
      <p className="text-sm text-muted-foreground">An instance administrator must turn on Assistant connections (MCP) in Experimental settings. Then return here to connect your assistant.</p>
      <Button variant="outline" asChild><Link to="/company/settings/instance/experimental">Open Experimental settings</Link></Button>
    </section>}
    {setup.data?.enabled && <>
      <section className="space-y-4" aria-label="Invite your assistant">
        <p className="text-sm text-muted-foreground">Paste this invitation into your assistant. It will help set up the connection and ask you to approve access in Paperclip.</p>
        <div className="flex justify-end">
          <AgentSetupPrompt prompt={invitation} label="Copy invitation" title="Invite your assistant" description="Paste this invitation into your assistant. It will help set up the connection and ask you to approve access in Paperclip." side="bottom" align="end" />
        </div>
      </section>
      <details className="space-y-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Set up manually</summary>
        <Tabs value={assistant} onValueChange={value => setAssistant(value as Assistant)} className="min-w-0"><div className="overflow-x-auto overflow-y-hidden scrollbar-none border-b border-border"><TabsList variant="line" className="min-w-full justify-start" aria-label="Assistant setup instructions">{Object.entries(assistants).map(([value, name]) => <TabsTrigger key={value} value={value} className="flex-none"><AssistantIcon assistant={value as Assistant} />{name}</TabsTrigger>)}</TabsList></div></Tabs>
        <section className="space-y-4" aria-label={`Set up ${assistants[assistant]}`}>
          {mcpSetupSteps(serverUrl, assistant).map((step, index) => <div key={`${assistant}-${index}`} className="space-y-2"><p className="text-sm text-muted-foreground">{step.text}</p>{step.code && <CopyValue value={step.code} label={`${assistants[assistant]} setup step ${index + 1}`} />}</div>)}
          {assistant !== "browser" && <p className="text-sm text-muted-foreground">{mcpAuthorizationHandoffInstructions}</p>}
          <p className="text-sm">Choose <strong>{selectedCompany.name}</strong>, review access, then click <strong>Connect organization</strong>.</p>
          <p className="text-xs text-muted-foreground">Creating tasks and adding comments may start agent work using the organization’s configured execution budget.</p>
        </section>
        <CopyValue value={serverUrl} label="MCP server URL" />
      </details>
    </>}
    <section className="space-y-3" aria-labelledby="connected-assistants">
      <h2 id="connected-assistants" className="text-sm font-semibold">Your connected assistants</h2>
      {(connections.isPending || connections.view.kind === "reconnecting") && <p className="text-sm text-muted-foreground">Loading connections…</p>}
      {revoke.error && <p role="alert" className="text-sm text-destructive">Couldn’t revoke this connection. Try again. <button type="button" className="underline" onClick={() => void connections.refetch()}>Refresh</button></p>}
      {connections.view.kind === "error" && <QueryErrorState error={connections.error} action="load your connections" onRetry={connections.view.retry} retrying={connections.view.isFetching} />}
      {connections.loaded && connections.rows.length === 0 && <p className="text-sm text-muted-foreground">No assistants connected to {selectedCompany.name} yet.</p>}
      <div className="divide-y divide-border">{connections.rows.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 space-y-1"><Identity name={assistantConnectionDisplayName(row)} avatarUrl={row.user?.image} initials={deriveInitials(row.user?.name ?? "You")} className="font-medium" /><p className="text-xs text-muted-foreground">{`Connected as you · ${row.scopes.includes("paperclip:write") ? "Read and write" : "Read only"}${row.scopes.includes("paperclip:configure") ? " · Configure agents, projects and skills" : ""}`}</p></div>
        <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(row.id)} aria-label={`Revoke ${assistantConnectionDisplayName(row)}`}>Revoke</Button>
      </div>)}</div>
    </section>
    <footer className="flex items-center justify-between gap-3 border-t border-border pt-4"><Button variant="ghost" asChild><Link to="/apps">Back to Connections</Link></Button><a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline" href={assistant === "opencode" ? "https://opencode.ai/docs/mcp-servers/" : assistant === "claude" ? "https://code.claude.com/docs/en/mcp" : "https://developers.openai.com/codex/mcp"} target="_blank" rel="noreferrer">Setup documentation <ExternalLink className="size-3" /></a></footer>
  </div>;
}
