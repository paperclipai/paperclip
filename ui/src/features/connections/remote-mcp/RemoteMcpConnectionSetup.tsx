import { useTranslation } from "@/i18n";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, HelpCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { InlineBanner } from "@/components/InlineBanner";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RemoteMcpManagement } from "./RemoteMcpManagement";
import {
  AccessStepContent,
  ConnectionAccessDefaults,
  connectionDefaultSummarySentence,
  StepHeader,
} from "../ConnectionSetupFlow";
import type { RemoteMcpProvider } from "./providers";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "./types";

/**
 * PAP-659 C0: the connect path is one screen. `access` is still a real screen,
 * but only as management after the connection exists — the way in states the
 * resolved default and puts its controls in the Advanced disclosure, the same
 * as every catalog connector.
 */
const steps = ["connect"] as const;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><button type="button" aria-label={t("help_with_1ac2ae8", { label: label })} onClick={() => setOpen(!open)} className="rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><HelpCircle className="size-4" /></button></TooltipTrigger>
    <TooltipContent className="max-w-xs">{children}</TooltipContent>
  </Tooltip>;
}

/** Controlled presentation shared by provider setup, configuration imports and review stories.
 * Authentication, persistence and calls belong to the controller, never these views. */
export function RemoteMcpConnectionSetup({ provider, state: s, actions: a, agents, companyId, connectionId, fixedGrantKind, lockedAgentId, host = "page", authorizationUrl, upstreamServiceName, onCancel, additionalSettings, settingsValid = true }: {
  additionalSettings?: ReactNode;
  settingsValid?: boolean;
  companyId: string;
  onCancel?: () => void;
  upstreamServiceName?: string;
  host?: "page" | "dialog";
  lockedAgentId?: string;
  authorizationUrl?: string;
  provider: RemoteMcpProvider;
  connectionId: string;
  fixedGrantKind?: RemoteMcpSetupState["grantKind"];
  state: RemoteMcpSetupState;
  actions: RemoteMcpSetupActions;
  agents: { id: string; name: string }[];
}) {
  const { t } = useTranslation("connections");
  const uid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(s.step);
  const [sessionOpen, setSessionOpen] = useState(() => Boolean(provider.defaultUrl && s.url !== provider.defaultUrl));
  useEffect(() => {
    if (previousStep.current !== s.step) heading.current?.focus();
    previousStep.current = s.step;
  }, [s.step]);
  const currentStep = steps.indexOf(s.step as typeof steps[number]);
  const busy = s.connectStatus === "connecting";
  const change = (patch: Partial<RemoteMcpSetupState>) => a.edit(patch);
  const external = (purpose: Parameters<typeof a.openProvider>[0], text: string) => <Button type="button" variant="link" className="h-auto p-0 text-sm text-current underline" onClick={() => a.openProvider(purpose)}>{text}<ExternalLink className="size-3.5" aria-hidden="true" /></Button>;
  const boundary = <InlineBanner compact>{t("paperclip_controls_access_to_the_tools_listed_aa2b6bc", { value: external("manage", provider.name) })}</InlineBanner>;
  const footer = (children: ReactNode) => <SetupWizardFooter onSaveExit={a.saveExit} disabled={busy}>{children}</SetupWizardFooter>;

  /**
   * The stated default and the one Advanced disclosure (PAP-659 C0).
   *
   * Step 1 of this work learned the lesson the hard way on Gmail: adding an
   * access disclosure beside a connector's existing "Advanced authentication"
   * panel leaves two of them on one screen, which is worse than the step it
   * replaced. So the provider's authentication settings are passed in here as
   * `extra` and share a single panel with the access controls.
   */
  // Deliberately not derived from `s.auth`. A gateway URL can carry a personal
  // token even when the method declares `auth: "none"`, so the shared-vs-mine
  // credential choice has to stay offered; deriving "none" here would silently
  // remove it and pin every Zapier connection to the organization.
  const authKind = "oauth";
  const defaults = (extra: ReactNode) => <ConnectionAccessDefaults
    companyId={companyId}
    {...(companyId ? {} : { agents })}
    sentence={connectionDefaultSummarySentence({
      grantKind: s.grantKind,
      authKind,
      installChoice: s.allAgents ? "all" : "specific",
      installCount: s.agentIds.length,
      lockedAgentId,
      preserveAgentAccess: s.setupComplete,
    })}
    extra={extra}
    // Something inside is load-bearing: the operator has already chosen a
    // non-default sign-in method, or the provider just rejected a credential.
    forceOpen={s.auth !== (provider.supportsBrowserAuth ? "auto" : "none") || s.connectStatus === "rejected"}
    disabled={busy}
    authKind={authKind}
    grantKinds={fixedGrantKind ? [fixedGrantKind] : undefined}
    grantKind={s.grantKind}
    setGrantKind={(grantKind) => { if (grantKind !== "agent") change({ grantKind }); }}
    installChoice={s.allAgents ? "all" : "specific"}
    setInstallChoice={(choice) => change({ allAgents: choice === "all" })}
    installAgentIds={new Set(s.agentIds)}
    setInstallAgentIds={(ids) => change({ agentIds: [...ids] })}
    lockedAgentId={lockedAgentId}
    preserveAgentAccess={s.setupComplete}
  />;

  const error = s.connectStatus === "invalid_url" ? { title: t("enter_a_valid_mcp_url_13b0859"), body: t("paste_the_complete_server_url_including_https_9cccb51") }
    : s.connectStatus === "oauth_failed" ? { title: t("couldn_t_connect_f8dad49", { name: provider.name }), body: t("authorization_did_not_complete_your_saved_connection_8090174") }
    : s.connectStatus === "rejected" ? { title: t("credentials_were_rejected_af19ebf"), body: t("check_or_replace_the_credentials_from_then_243cb0c", { name: provider.name }) }
    : s.connectStatus === "unreachable" ? { title: t("paperclip_could_not_reach_this_server_507bb24"), body: t("check_that_the_endpoint_is_running_and_83a2f0f") }
    : null;
  const urlField = <div className="space-y-2">
    <div className="flex items-center gap-2"><Label htmlFor={`${uid}-url`}>{t("mcp_server_url_8ca3229")}</Label><FieldHelp label={t("mcp_server_url_8ca3229")}>{provider.urlHelp}</FieldHelp></div>
    <Input id={`${uid}-url`} type="password" autoComplete="off" spellCheck={false} placeholder={provider.placeholder} value={s.url} aria-invalid={s.connectStatus === "invalid_url"} aria-describedby={`${uid}-url-help`} onChange={(event) => change({ url: event.target.value })} />
    <p id={`${uid}-url-help`} className="text-xs text-muted-foreground">{provider.urlHelp}</p>
    {provider.id === "executor" ? <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${uid}-management`}>{t("console_url_optional_954518b")}</Label>
      <FieldHelp label={t("executor_console_url_bc5030a")}>{t("the_url_of_your_executor_organization_s_b74bf55")}</FieldHelp></div>
      <Input id={`${uid}-management`} type="url" value={s.managementUrl ?? ""} placeholder="https://executor.sh/your-organization/integrations" onChange={event => change({ managementUrl: event.target.value })} />
    </div> : null}
  </div>;

  return <div className={host === "dialog" ? "min-w-0 text-foreground" : "mx-auto max-w-6xl p-4 text-foreground sm:p-8"} data-remote-mcp-provider={provider.id}>
    <StepHeader headingRef={heading} appIdentity={{ name: provider.name, logoUrl: null }}
      title={upstreamServiceName ? t("connect_through_cf11dbc", { upstreamServiceName: upstreamServiceName, name: provider.name }) : s.step === "draft" ? t("continue_your_setup_3e04902") : s.setupComplete ? s.step === "access" ? t("who_can_use_this_connection_400f803") : s.step === "connect" ? t("reconnect_6cad2e2", { name: provider.name }) : provider.name : undefined}
      subtitle={currentStep >= 0 && !s.setupComplete ? t("paperclip_will_use_on_your_behalf_dd3bbda", { name: provider.name }) : s.step === "draft" ? t("your_setup_is_ready_to_resume_6d8a4e1", { name: provider.name }) : s.step === "permissions" ? s.identity ? t("reviewBConnectedAs", { identity: s.identity, count: s.tools.length }) : t("connected_actions_available_75c6500", { count: s.tools.length }) : t("manage_this_connection_be22392", { name: provider.name })}
      step={currentStep >= 0 && !s.setupComplete ? "key" : "gallery"} activeIndex={currentStep} labels={steps.map(() => "Connect")} onCancel={busy || s.step === "management" || s.step === "permissions" || s.step === "draft" ? undefined : onCancel ?? a.saveExit} />
    <main className="space-y-6">
        {upstreamServiceName && <InlineBanner compact>{t("handles_the_connection_and_requests_to_a11f0e7", { name: provider.name, upstreamServiceName: upstreamServiceName, instructions: provider.id === "composio" ? t("reviewBComposioSignIn") : t("reviewBProviderSignIn") })}</InlineBanner>}
        {s.notice && <p role="status" className="text-sm text-muted-foreground">{s.notice}</p>}

        {s.step === "access" && <AccessStepContent agents={agents} lockedAgentId={lockedAgentId} authKind="oauth" grantKinds={fixedGrantKind ? [fixedGrantKind] : undefined} grantKind={s.grantKind} setGrantKind={(grantKind) => { if (grantKind !== "agent") change({ grantKind }); }}
          installChoice={s.allAgents ? "all" : "specific"} setInstallChoice={(choice) => change({ allAgents: choice === "all" })}
          installAgentIds={new Set(s.agentIds)} setInstallAgentIds={(ids) => change({ agentIds: [...ids] })}
          submitLabel={s.setupComplete ? t("final-configuration:done") : t("final-configuration:continue")} onBack={s.setupComplete ? a.finish : a.saveExit} onContinue={s.setupComplete ? a.finish : () => a.navigate("connect")} />}
        {s.step === "permissions" && <>
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t("permissions_d06d555")}</h2><Button variant="outline" onClick={a.finish}>{t("connection_settings_618aac5")}</Button></div>
          {s.tools.some((entry) => entry.broad) && boundary}
          <ActionsSection connectionId={connectionId} appName={provider.name}
            readOnly={s.tools.filter((entry) => entry.isReadOnly)} canChange={s.tools.filter((entry) => !entry.isReadOnly)} quarantined={[]}
            enabledIds={new Set(s.tools.filter((entry) => s.permissions[entry.id] !== "off").map((entry) => entry.id))}
            askFirstIds={new Set(s.tools.filter((entry) => s.permissions[entry.id] === "ask_first").map((entry) => entry.id))}
            disabled={!s.connected} refreshPending={s.refreshing} canConfigure
            onSetPermission={(ids, next) => change({ permissions: { ...s.permissions, ...Object.fromEntries(ids.map((id) => [id, next === "ask" ? "ask_first" : next])) } })}
            onReviewQuarantined={() => {}} onRefreshActions={a.refresh} />
        </>}
        <div className="mx-auto max-w-2xl space-y-6">
        {s.step === "connect" && <>
          <div className="space-y-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm">{provider.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
            {external("setup", t("open_setup_guide_f2a4c75", { name: provider.name }))}
          </div>
          {s.connectStatus === "sign_in" && provider.supportsBrowserAuth ? <>
            <div role="status"><InlineBanner title={t("finish_signing_in_to_fe0b301", { name: provider.name })}>{t("complete_sign_in_in_the_provider_window_fd48519")}</InlineBanner></div>
            <p className="text-sm text-muted-foreground">{t("if_a_window_did_not_open_381bbfd")}{authorizationUrl ? <a className="text-current underline" href={authorizationUrl} onClick={() => a.openProvider("sign_in")} target="_blank" rel="noopener noreferrer">{t("open_sign_in_again_0d103f1")}</a> : external("sign_in", t("open_sign_in_again_0d103f1"))}.</p>
            {footer(<><Button variant="outline" onClick={a.cancelConnect}>{t("cancel_sign_in_e5bd753")}</Button><Button disabled>{t("waiting_for_sign_in_8e02d8c")}</Button></>)}
          </> : <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); a.connect(); }}>
            {error && <div role="alert"><InlineBanner tone="danger" title={error.title}>{error.body}</InlineBanner></div>}
            {s.connectStatus === "cancelled" && <p role="status" className="text-sm text-muted-foreground">{t("connection_cancelled_your_setup_details_are_preserved_f488efe")}</p>}
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              {provider.defaultUrl ? <Collapsible open={sessionOpen || s.connectStatus === "invalid_url"} onOpenChange={setSessionOpen}>
                <CollapsibleTrigger asChild><Button type="button" variant="link" className="h-auto p-0 text-sm text-muted-foreground underline underline-offset-2">{t("reuse_an_existing_session_2e4386a")}</Button></CollapsibleTrigger>
                <CollapsibleContent className="mt-3">{urlField}</CollapsibleContent>
              </Collapsible> : urlField}
              {defaults(<div className="space-y-4">
                  <p className="text-sm font-medium text-foreground">{t("authentication_ee1acfa")}</p>
                  <p className="text-sm text-muted-foreground">{provider.authHelp}</p>
                  <div className="space-y-2"><Label htmlFor={`${uid}-auth`}>{t("sign_in_method_764b4b3")}</Label><select id={`${uid}-auth`} className={selectClass} value={s.auth} onChange={(event) => change({ auth: event.target.value as RemoteMcpSetupState["auth"] })}>
                    {provider.supportsBrowserAuth && <option value="auto">{t("automatic_sign_in_if_required_d9f049b")}</option>}<option value="bearer">{t("bearer_token_ffa64bc")}</option><option value="headers">{t("custom_headers_85321ee")}</option><option value="none">{t("no_additional_authentication_e7f39d8")}</option>
                  </select></div>
                  {s.auth === "bearer" && <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${uid}-token`}>{t("bearer_token_ffa64bc")}</Label><FieldHelp label={t("bearer_token_2f208e0")}>{t("paste_the_token_only_without_the_word_4939c1c")}</FieldHelp></div><Input id={`${uid}-token`} type="password" autoComplete="off" value={s.token} onChange={(event) => change({ token: event.target.value })} /></div>}
                  {(s.auth === "bearer" || s.auth === "headers") && <div className="space-y-3">
                    <p className="text-sm font-medium">{s.auth === "bearer" ? t("additional_headers_1eadab7") : t("headers_520de74")}</p>
                    {s.headers.map((header, index) => <div key={header.id} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-name`}>{t("header_name_440064f", { value: index + 1 })}</Label><Input id={`${uid}-${header.id}-name`} value={header.name} placeholder={provider.id === "arcade" ? t("arcade_user_id_c9f6d43") : t("header_name_b46f85a")} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, name: event.target.value } : h) })} /></div>
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-value`}>{t("header_value_02f05af", { value: index + 1 })}</Label><Input id={`${uid}-${header.id}-value`} type="password" autoComplete="off" value={header.value} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, value: event.target.value } : h) })} /></div>
                      <Button type="button" variant="ghost" size="icon" aria-label={t("remove_header_e448bc7", { value: index + 1 })} onClick={() => change({ headers: s.headers.filter((h) => h.id !== header.id) })}><Trash2 className="size-4" /></Button>
                    </div>)}
                    <Button type="button" variant="outline" size="sm" onClick={() => change({ headers: [...s.headers, { id: crypto.randomUUID(), name: "", value: "" }] })}><Plus className="size-4" />{t("add_header_d5a110d")}</Button>
                  </div>}
                </div>)}
            </fieldset>
            {additionalSettings}
            {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{t("connecting_and_discovering_tools_50e3d5c")}</p>}
            {footer(<>{s.setupComplete ? <Button type="button" variant="outline" disabled={busy} onClick={a.finish}>{t("back_b52b36b")}</Button> : <span />}<Button type="submit" disabled={busy || !s.url.trim() || !settingsValid}>{busy ? t("connecting_fd3e796") : error || s.connectStatus === "cancelled" ? t("try_again_042c862") : t("connect_f7689e7", { name: provider.name })}</Button></>)}
          </form>}
        </>}

        {s.step === "management" && <>
          {!s.connected ? <InlineBanner tone="warning" title={t("disconnected_771e05f")}>{t("agents_cannot_use_this_connection_reconnect_to_c5b286b")}</InlineBanner> : <div className="space-y-2"><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4" />{t("connected_c2f9b7b")}{s.identity ? t("as_e63c26f", { identity: s.identity }) : ""}</p><p className="text-sm text-muted-foreground">{t("tools_1633118", { humanAccess: s.grantKind === "user" ? t("reviewBJustMe") : t("reviewBAnyHuman"), toolCount: s.tools.length, agentAccess: s.allAgents ? t("reviewBAnyAgent") : t("reviewBAgents", { count: s.agentIds.length }) })}</p></div>}
          <div className="flex flex-wrap gap-2"><Button onClick={() => a.navigate("access")}>{t("who_can_use_this_connection_400f803")}</Button><Button variant="outline" disabled={!s.connected} onClick={() => a.navigate("permissions")}>{t("permissions_d06d555")}</Button></div>
          <p className="text-sm text-muted-foreground">{t("refresh_the_catalog_after_changing_tools_in_197e32f", { name: provider.name })}</p>
          <Button variant="outline" disabled={!s.connected || s.refreshing} onClick={a.refresh}>{s.refreshing ? t("refreshing_9614117") : t("refresh_tools_311c385")}</Button>
          <RemoteMcpManagement providerName={provider.name} connected={s.connected} onReconnect={a.reconnect} onManage={() => a.openProvider("manage")} onDisconnect={a.disconnect} />
        </>}
        {s.step === "draft" && <><p className="text-sm">{t("your_access_choices_and_setup_progress_are_2a2fa86")}</p><div className="flex justify-end"><Button onClick={a.resumeDraft}>{t("resume_setup_e799297")}</Button></div></>}
        </div>
    </main>
  </div>;
}
