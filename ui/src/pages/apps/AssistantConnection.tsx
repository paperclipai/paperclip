import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { assistantSetupDisplayText } from "./assistant-setup-display";
import { useEffect, useState } from "react";
import { assistantClientNames, mcpAuthorizationHandoffInstructions, mcpInvitation, mcpSetupSteps, type AssistantClient } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Globe, Paperclip, Plug, Terminal } from "lucide-react";
import { publicMcpApi } from "@/api/publicMcp";
import { ApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { copyTextToClipboard } from "@/lib/clipboard";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const ASSISTANT_CONNECTION_PATH = "/apps/assistant-connection";
const connectionsKey = ["mcp-connections"];
type Assistant = AssistantClient;
const assistants = { ...assistantClientNames, get browser() { return t("oct6Beta.browserClient"); }, get headless() { return t("oct6Beta.headlessClient"); }, get other() { return t("oct6Beta.otherClient"); } };

function AssistantIcon({ assistant }: { assistant: Assistant }) {
  useTranslation();
  if (assistant === "codex" || assistant === "claude") return <img src={`/brands/${assistant}-color.svg`} alt="" className="size-4 shrink-0" />;
  if (assistant === "opencode") return <span aria-hidden="true" className="inline-flex shrink-0"><OpenCodeLogoIcon className="size-4" /></span>;
  const Icon = assistant === "browser" ? Globe : assistant === "headless" ? Terminal : Plug;
  return <Icon className="size-4" aria-hidden="true" />;
}

export function useAssistantConnections(poll = false) {
  const { selectedCompanyId } = useCompany();
  const query = useQuery({
    queryKey: connectionsKey, queryFn: publicMcpApi.connections, retry: false,
    enabled: Boolean(selectedCompanyId), refetchInterval: poll ? 5000 : false,
  });
  return { ...query, rows: (query.data ?? []).filter(row => row.companyId === selectedCompanyId) };
}

/** Inbound assistant access belongs beside the existing outbound connectors. */
export function AssistantConnectionCard({ onNavigate }: { onNavigate: (href: string) => void }) {
  useTranslation();
  const connections = useAssistantConnections();
  const active = connections.rows.filter(row => !row.revokedAt);
  const action = !connections.isSuccess ? t("pages.apps.connections.open") : active.length ? t("localizationAgents.ui44_Manage") : t("pages.agents.setUp");
  return <div role="listitem" data-app-slug="assistant-connection" data-connected={connections.isSuccess ? String(active.length > 0) : undefined} className="overflow-hidden rounded-xl border border-border">
    <div className="flex flex-wrap items-center gap-3 px-4 py-4">
      <Paperclip className="size-9 shrink-0 p-1 text-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">{t("oct6Beta.copy219")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("oct6Beta.copy220")}</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onNavigate(ASSISTANT_CONNECTION_PATH)} aria-label={t("oct6Beta.assistantConnectionAction", { action })}>{action}</Button>
    </div>
    {connections.isPending && <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("oct6Beta.copy221")}</p>}
    {connections.isError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
      <p className="text-xs text-destructive">{t("oct6Beta.copy222")}</p>
      <Button size="sm" variant="ghost" disabled={connections.isFetching} onClick={() => void connections.refetch()}>{t("oct5Core.s0057")}</Button>
    </div>}
    {connections.isSuccess && active.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-sm">
      <Check className="size-4 text-muted-foreground" aria-hidden="true" />
      <span>{active.map(row => row.clientName).join(", ")}</span>
      <span className="text-xs text-muted-foreground">{t("oct6Beta.copy223")}</span>
    </div>}
  </div>;
}

/** Only copy user-visible, non-secret setup values. Never execute them here. */
function CopyValue({ value, label }: { value: string; label: string }) {
  useTranslation();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setCopied(false); setError(false); }, [value]);
  return <div className="space-y-2">
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{value}</pre>
      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("oct6Beta.dynamic111", { v0: label })} onClick={async () => {
        try { await copyTextToClipboard(value); setCopied(true); setError(false); }
        catch { setError(true); }
      }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
    </div>
    <p role="status" className="text-xs text-muted-foreground">{error ? t("oct6Beta.copy224") : copied ? t("sep28Routines.copied") : null}</p>
  </div>;
}

function setupError(error: Error): string {
  if (error instanceof ApiError && error.status === 401) return t("oct6Beta.copy225");
  if (error instanceof ApiError && error.status === 404) return t("oct6Beta.copy226");
  return t("oct6Beta.copy227");
}

export function AssistantConnection({ initialAssistant = "codex" }: { initialAssistant?: Assistant } = {}) {
  useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const [assistant, setAssistant] = useState<Assistant>(initialAssistant);
  const setup = useQuery({ queryKey: ["mcp-setup"], queryFn: publicMcpApi.setup, retry: false, refetchOnWindowFocus: "always", refetchOnMount: "always" });
  const connections = useAssistantConnections(setup.data?.enabled === true);
  const revoke = useMutation({ mutationFn: publicMcpApi.revoke, onSuccess: () => client.invalidateQueries({ queryKey: connectionsKey }) });
  useEffect(() => {
    setBreadcrumbs([{ label: t("localizationConnections.connectors16"), href: "/apps" }, { label: t("oct6Beta.copy219") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  if (!selectedCompanyId || !selectedCompany) return <p className="text-sm text-muted-foreground">{t("oct6Beta.copy228")}</p>;
  const serverUrl = setup.data?.serverUrl ?? "";
  const invitation = serverUrl ? mcpInvitation(serverUrl, { id: selectedCompanyId, name: selectedCompany.name }) : "";
  return <div className="max-w-3xl space-y-6 pb-8">
    <header className="space-y-4">
      <div className="flex items-center gap-3"><Paperclip className="size-7 shrink-0" /><h1 className="text-xl font-semibold">{t("oct6Beta.copy219")}</h1></div>
      <div className="flex items-center gap-3">
        <CompanyPatternIcon companyName={selectedCompany.name} logoUrl={selectedCompany.logoUrl} className="size-12 shrink-0 rounded-lg" />
        <div className="space-y-1"><p className="font-medium">{selectedCompany.name}</p><p className="text-sm text-muted-foreground">{t("oct6Beta.copy229")}</p></div>
      </div>
    </header>
    {setup.isPending && <p className="text-sm text-muted-foreground">{t("oct6Beta.copy230")}</p>}
    {setup.error && <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{setupError(setup.error)}</p><Button variant="outline" onClick={() => void setup.refetch()}>{t("oct5Core.s0057")}</Button></div>}
    {setup.data && !setup.data.enabled && <section className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <h2 className="text-sm font-semibold">{t("oct6Beta.copy231")}</h2>
      <p className="text-sm text-muted-foreground">{t("oct6Beta.copy232")}</p>
      <Button variant="outline" asChild><Link to="/company/settings/instance/experimental">{t("oct6Beta.copy233")}</Link></Button>
    </section>}
    {setup.data?.enabled && <>
      <section className="space-y-4" aria-label={t("oct6Beta.copy234")}>
        <p className="text-sm text-muted-foreground">{t("oct6Beta.copy235")}</p>
        <div className="flex justify-end">
          <AgentSetupPrompt prompt={invitation} label={t("oct6Beta.copy236")} title={t("oct6Beta.copy234")} description={t("oct6Beta.copy235")} side="bottom" align="end" />
        </div>
      </section>
      <details className="space-y-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t("oct6Beta.copy237")}</summary>
        <Tabs value={assistant} onValueChange={value => setAssistant(value as Assistant)} className="min-w-0"><div className="overflow-x-auto overflow-y-hidden scrollbar-none border-b border-border"><TabsList variant="line" className="min-w-full justify-start" aria-label={t("oct6Beta.copy238")}>{Object.entries(assistants).map(([value, name]) => <TabsTrigger key={value} value={value} className="flex-none"><AssistantIcon assistant={value as Assistant} />{name}</TabsTrigger>)}</TabsList></div></Tabs>
        <section className="space-y-4" aria-label={t("oct6Beta.dynamic112", { v0: assistants[assistant] })}>
          {mcpSetupSteps(serverUrl, assistant).map((step, index) => <div key={`${assistant}-${index}`} className="space-y-2"><p className="text-sm text-muted-foreground">{assistantSetupDisplayText(step.text)}</p>{step.code && <CopyValue value={step.code} label={t("oct6Beta.dynamic113", { v0: assistants[assistant], v1: index + 1 })} />}</div>)}
          {assistant !== "browser" && <p className="text-sm text-muted-foreground">{assistantSetupDisplayText(mcpAuthorizationHandoffInstructions)}</p>}
          <p className="text-sm"><Trans i18nKey="oct6Beta.assistantChooseCompany" values={{ company: selectedCompany.name }} components={{ company: <strong />, authorize: <strong /> }} /></p>
          <p className="text-xs text-muted-foreground">{t("oct6Beta.copy239")}</p>
        </section>
        <CopyValue value={serverUrl} label={t("localizationConnections.mCPServerURL101")} />
      </details>
    </>}
    <section className="space-y-3" aria-labelledby="connected-assistants">
      <h2 id="connected-assistants" className="text-sm font-semibold">{t("oct6Beta.copy240")}</h2>
      {connections.isPending && <p className="text-sm text-muted-foreground">{t("oct6Beta.copy042")}</p>}
      {(connections.error || revoke.error) && <p role="alert" className="text-sm text-destructive">{revoke.error ? t("oct6Beta.copy241") : t("oct6Beta.copy242")} <button type="button" className="underline" onClick={() => void connections.refetch()}>{t("oct5Core.s0317")}</button></p>}
      {connections.isSuccess && connections.rows.length === 0 && <p className="text-sm text-muted-foreground">{t("oct6Beta.noAssistants", { company: selectedCompany.name })}</p>}
      <div className="divide-y divide-border">{connections.rows.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="space-y-1"><p className="text-sm font-medium">{row.clientName}</p><p className="text-xs text-muted-foreground">{row.revokedAt ? t("sep13Connections.status_revoked") : t("oct6Beta.dynamic114", { v0: row.scopes.includes("paperclip:write") ? t("oct5Metadata.readWrite") : t("localizationPlugins.ui_Read_only") })}</p></div>
        {!row.revokedAt && <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(row.id)} aria-label={t("oct6Beta.dynamic115", { v0: row.clientName })}>{t("localizationAccessBootstrap.revoke")}</Button>}
      </div>)}</div>
    </section>
    <footer className="flex items-center justify-between gap-3 border-t border-border pt-4"><Button variant="ghost" asChild><Link to="/apps">{t("oct6Beta.copy243")}</Link></Button><a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline" href={assistant === "opencode" ? "https://opencode.ai/docs/mcp-servers/" : assistant === "claude" ? "https://code.claude.com/docs/en/mcp" : "https://developers.openai.com/codex/mcp"} target="_blank" rel="noreferrer">{t("oct6Beta.copy244")} <ExternalLink className="size-3" /></a></footer>
  </div>;
}
