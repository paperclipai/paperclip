import { useTranslation, t as translate } from "@/i18n";
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
  const { t } = useTranslation("connections");
  const connections = useAssistantConnections();
  const active = connections.rows;
  const action = !connections.loaded ? t("open_cf9b770") : active.length ? t("manage_bf58d17") : t("set_up_a5041fd");
  return <div role="listitem" data-app-slug="assistant-connection" data-connected={connections.loaded ? String(active.length > 0) : undefined} className="overflow-hidden rounded-xl border border-border">
    <div className="flex flex-wrap items-center gap-3 px-4 py-4">
      <Paperclip className="size-9 shrink-0 p-1 text-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">{t("assistant_connection_mcp_a953e3f")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("use_your_paperclip_organization_from_codex_claude_9b60889")}</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onNavigate(ASSISTANT_CONNECTION_PATH)} aria-label={t("assistant_connection_mcp_723edc6", { action: action })}>{action}</Button>
    </div>
    {(connections.isPending || connections.view.kind === "reconnecting") && <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t("checking_your_connection_status_7a2ee83")}</p>}
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
  const { t } = useTranslation("connections");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setCopied(false); setError(false); }, [value]);
  return <div className="space-y-2">
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{value}</pre>
      <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("copy_a83c00e", { label: label })} onClick={async () => {
        try { await copyTextToClipboard(value); setCopied(true); setError(false); }
        catch { setError(true); }
      }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
    </div>
    <p role="status" className="text-xs text-muted-foreground">{error ? t("couldn_t_copy_select_and_copy_the_10479b5") : copied ? t("copied_8e3df45") : null}</p>
  </div>;
}

/** Setup copy that depends on the instance, not on the request: signed out, or no public URL configured. */
function setupUnavailableCopy(errorKind: "auth" | "not_found"): string {
  if (errorKind === "auth") return translate("connections:sign_in_to_connect_an_assistant_this_2cb1e91");
  return translate("connections:assistant_connections_need_an_authenticated_instance_with_a7fef19");
}

export function AssistantConnection({ initialAssistant = "codex" }: { initialAssistant?: Assistant } = {}) {
  const { t } = useTranslation("connections");
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
    setBreadcrumbs([{ label: t("connectors_4b1e950"), href: "/apps" }, { label: t("assistant_connection_mcp_a953e3f") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);
  if (!selectedCompanyId || !selectedCompany) return <p className="text-sm text-muted-foreground">{t("select_an_organization_to_connect_an_assistant_5c9d598")}</p>;
  const serverUrl = setup.data?.serverUrl ?? "";
  const invitation = serverUrl ? mcpInvitation(serverUrl, { id: selectedCompanyId, name: selectedCompany.name }) : "";
  return <div className="max-w-3xl space-y-6 pb-8">
    <header className="space-y-4">
      <div className="flex items-center gap-3"><Paperclip className="size-7 shrink-0" /><h1 className="text-xl font-semibold">{t("assistant_connection_mcp_a953e3f")}</h1></div>
      <div className="flex items-center gap-3">
        <CompanyPatternIcon companyName={selectedCompany.name} logoUrl={selectedCompany.logoUrl} className="size-12 shrink-0 rounded-lg" />
        <div className="space-y-1"><p className="font-medium">{selectedCompany.name}</p><p className="text-sm text-muted-foreground">{t("connect_your_assistant_to_paperclip_review_work_1db2591")}</p></div>
      </div>
    </header>
    {(setup.isPending || setupView.kind === "reconnecting") && <p className="text-sm text-muted-foreground">{t("loading_assistant_setup_9ca2414")}</p>}
    {setupView.kind === "error" && (setupView.errorKind === "auth" || setupView.errorKind === "not_found"
      ? <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{setupUnavailableCopy(setupView.errorKind)}</p><Button variant="outline" disabled={setupView.isFetching} onClick={setupView.retry}>{t("try_again_042c862")}</Button></div>
      : <QueryErrorState error={setup.error} action="load assistant setup" onRetry={setupView.retry} retrying={setupView.isFetching} />)}
    {setup.data && !setup.data.enabled && <section className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <h2 className="text-sm font-semibold">{t("enable_assistant_connections_8f438c8")}</h2>
      <p className="text-sm text-muted-foreground">{t("an_instance_administrator_must_turn_on_assistant_5dd70a2")}</p>
      <Button variant="outline" asChild><Link to="/company/settings/instance/experimental">{t("open_experimental_settings_9b297de")}</Link></Button>
    </section>}
    {setup.data?.enabled && <>
      <section className="space-y-4" aria-label={t("invite_your_assistant_c50d8fe")}>
        <p className="text-sm text-muted-foreground">{t("paste_this_invitation_into_your_assistant_it_f5ca8c7")}</p>
        <div className="flex justify-end">
          <AgentSetupPrompt prompt={invitation} label={t("copy_invitation_18960e3")} title={t("invite_your_assistant_c50d8fe")} description={t("paste_this_invitation_into_your_assistant_it_f5ca8c7")} side="bottom" align="end" />
        </div>
      </section>
      <details className="space-y-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t("set_up_manually_f81b604")}</summary>
        <Tabs value={assistant} onValueChange={value => setAssistant(value as Assistant)} className="min-w-0"><div className="overflow-x-auto overflow-y-hidden scrollbar-none border-b border-border"><TabsList variant="line" className="min-w-full justify-start" aria-label={t("assistant_setup_instructions_d6f7d7a")}>{Object.entries(assistants).map(([value, name]) => <TabsTrigger key={value} value={value} className="flex-none"><AssistantIcon assistant={value as Assistant} />{name}</TabsTrigger>)}</TabsList></div></Tabs>
        <section className="space-y-4" aria-label={t("set_up_baa0f12", { value: assistants[assistant] })}>
          {mcpSetupSteps(serverUrl, assistant).map((step, index) => <div key={`${assistant}-${index}`} className="space-y-2"><p className="text-sm text-muted-foreground">{step.text}</p>{step.code && <CopyValue value={step.code} label={t("setup_step_95979ca", { value: assistants[assistant], value2: index + 1 })} />}</div>)}
          {assistant !== "browser" && <p className="text-sm text-muted-foreground">{mcpAuthorizationHandoffInstructions}</p>}
          <p className="text-sm">{t("choose_bcf399c")}<strong>{selectedCompany.name}</strong>{t("review_access_then_click_edcf9f6")}<strong>{t("connect_organization_7e46a8e")}</strong>.</p>
          <p className="text-xs text-muted-foreground">{t("creating_tasks_and_adding_comments_may_start_f937cdd")}</p>
        </section>
        <CopyValue value={serverUrl} label={t("mcp_server_url_8ca3229")} />
      </details>
    </>}
    <section className="space-y-3" aria-labelledby="connected-assistants">
      <h2 id="connected-assistants" className="text-sm font-semibold">{t("your_connected_assistants_5619ec6")}</h2>
      {(connections.isPending || connections.view.kind === "reconnecting") && <p className="text-sm text-muted-foreground">{t("loading_connections_e2e03ef")}</p>}
      {revoke.error && <p role="alert" className="text-sm text-destructive">{t("couldn_t_revoke_this_connection_try_again_e886c65")}<button type="button" className="underline" onClick={() => void connections.refetch()}>{t("refresh_56e3bad")}</button></p>}
      {connections.view.kind === "error" && <QueryErrorState error={connections.error} action="load your connections" onRetry={connections.view.retry} retrying={connections.view.isFetching} />}
      {connections.loaded && connections.rows.length === 0 && <p className="text-sm text-muted-foreground">{t("no_assistants_connected_to_yet_62a2861", { name: selectedCompany.name })}</p>}
      <div className="divide-y divide-border">{connections.rows.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 space-y-1"><Identity name={assistantConnectionDisplayName(row)} avatarUrl={row.user?.image} initials={deriveInitials(row.user?.name ?? "You")} className="font-medium" /><p className="text-xs text-muted-foreground">{t("connected_as_you_9302568", { value: row.scopes.includes("paperclip:write") ? t("read_and_write_6106d0f") : t("read_only_601dcc1"), value2: row.scopes.includes("paperclip:configure") ? t("configure_agents_projects_and_skills_ac44f0e") : "" })}</p></div>
        <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(row.id)} aria-label={t("revoke_fb4b3ef", { value: assistantConnectionDisplayName(row) })}>{t("revoke_0be7207")}</Button>
      </div>)}</div>
    </section>
    <footer className="flex items-center justify-between gap-3 border-t border-border pt-4"><Button variant="ghost" asChild><Link to="/apps">{t("back_to_connections_ab9368a")}</Link></Button><a className="inline-flex items-center gap-1 text-xs text-muted-foreground underline" href={assistant === "opencode" ? "https://opencode.ai/docs/mcp-servers/" : assistant === "claude" ? "https://code.claude.com/docs/en/mcp" : "https://developers.openai.com/codex/mcp"} target="_blank" rel="noreferrer">{t("setup_documentation_8c1201a")}<ExternalLink className="size-3" /></a></footer>
  </div>;
}
