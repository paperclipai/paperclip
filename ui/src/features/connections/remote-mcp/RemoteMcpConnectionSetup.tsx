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
import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><button type="button" aria-label={t("tools.FieldHelp.helpWith", { label })} onClick={() => setOpen(!open)} className="rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><HelpCircle className="size-4" /></button></TooltipTrigger>
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
  const { t } = useTranslation();
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
  const boundary = <InlineBanner compact>
    {t("tools.RemoteMcpConnectionSetup.boundaryBefore")} {external("manage", provider.name)}{t("tools.RemoteMcpConnectionSetup.boundaryAfter")}
  </InlineBanner>;
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

  const error = s.connectStatus === "invalid_url" ? { title: t("tools.RemoteMcpConnectionSetup.invalidUrlTitle"), body: t("tools.RemoteMcpConnectionSetup.invalidUrlBody") }
    : s.connectStatus === "oauth_failed" ? { title: t("tools.RemoteMcpConnectionSetup.oauthTitle", { provider: provider.name }), body: t("tools.RemoteMcpConnectionSetup.oauthBody") }
    : s.connectStatus === "rejected" ? { title: t("tools.RemoteMcpConnectionSetup.rejectedTitle"), body: t("tools.RemoteMcpConnectionSetup.rejectedBody", { provider: provider.name }) }
    : s.connectStatus === "unreachable" ? { title: t("tools.RemoteMcpConnectionSetup.unreachableTitle"), body: t("tools.RemoteMcpConnectionSetup.unreachableBody") }
    : null;
  const urlField = <div className="space-y-2">
    <div className="flex items-center gap-2"><Label htmlFor={`${uid}-url`}>{t("tools.RemoteMcpConnectionSetup.urlLabel")}</Label><FieldHelp label={t("tools.RemoteMcpConnectionSetup.urlLabel")}>{provider.urlHelp}</FieldHelp></div>
    <Input id={`${uid}-url`} type="password" autoComplete="off" spellCheck={false} placeholder={provider.placeholder} value={s.url} aria-invalid={s.connectStatus === "invalid_url"} aria-describedby={`${uid}-url-help`} onChange={(event) => change({ url: event.target.value })} />
    <p id={`${uid}-url-help`} className="text-xs text-muted-foreground">{provider.urlHelp}</p>
    {provider.id === "executor" ? <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${uid}-management`}>{t("tools.RemoteMcpConnectionSetup.consoleUrl")}</Label>
      <FieldHelp label={t("tools.RemoteMcpConnectionSetup.executorHelpLabel")}>{t("tools.RemoteMcpConnectionSetup.executorHelp")}</FieldHelp></div>
      <Input id={`${uid}-management`} type="url" value={s.managementUrl ?? ""} placeholder="https://executor.sh/your-organization/integrations" onChange={event => change({ managementUrl: event.target.value })} />
    </div> : null}
  </div>;

  return <div className={host === "dialog" ? "min-w-0 text-foreground" : "mx-auto max-w-6xl p-4 text-foreground sm:p-8"} data-remote-mcp-provider={provider.id}>
    <StepHeader headingRef={heading} appIdentity={{ name: provider.name, logoUrl: null }}
      title={upstreamServiceName ? t("tools.RemoteMcpConnectionSetup.connectThrough", { service: upstreamServiceName, provider: provider.name }) : s.step === "draft" ? t("tools.RemoteMcpConnectionSetup.continueSetup") : s.setupComplete ? s.step === "access" ? t("tools.RemoteMcpConnectionSetup.whoCanUse") : s.step === "connect" ? t("tools.RemoteMcpConnectionSetup.reconnect", { provider: provider.name }) : provider.name : undefined}
      subtitle={currentStep >= 0 && !s.setupComplete ? t("tools.RemoteMcpConnectionSetup.useOnBehalf", { provider: provider.name }) : s.step === "draft" ? t("tools.RemoteMcpConnectionSetup.draftReady", { provider: provider.name }) : s.step === "permissions" ? `${t("tools.RemoteMcpConnectionSetup.connected")}${s.identity ? t("tools.RemoteMcpConnectionSetup.asIdentity", { identity: s.identity }) : ""} · ${t("tools.RemoteMcpConnectionSetup.actionsAvailable", { count: s.tools.length })}` : t("tools.RemoteMcpConnectionSetup.manageConnection", { provider: provider.name })}
      step={currentStep >= 0 && !s.setupComplete ? "key" : "gallery"} activeIndex={currentStep} labels={steps.map(() => t("tools.RemoteMcpConnectionSetup.stepConnect"))} onCancel={busy || s.step === "management" || s.step === "permissions" || s.step === "draft" ? undefined : onCancel ?? a.saveExit} />
    <main className="space-y-6">
        {upstreamServiceName && <InlineBanner compact>{t("tools.RemoteMcpConnectionSetup.upstreamNotice", { provider: provider.name, service: upstreamServiceName })} {provider.id === "composio" ? t("tools.RemoteMcpConnectionSetup.composioSignIn") : t("tools.RemoteMcpConnectionSetup.manageSignIn")}</InlineBanner>}
        {s.notice && <p role="status" className="text-sm text-muted-foreground">{s.notice}</p>}

        {s.step === "access" && <AccessStepContent agents={agents} lockedAgentId={lockedAgentId} authKind="oauth" grantKinds={fixedGrantKind ? [fixedGrantKind] : undefined} grantKind={s.grantKind} setGrantKind={(grantKind) => { if (grantKind !== "agent") change({ grantKind }); }}
          installChoice={s.allAgents ? "all" : "specific"} setInstallChoice={(choice) => change({ allAgents: choice === "all" })}
          installAgentIds={new Set(s.agentIds)} setInstallAgentIds={(ids) => change({ agentIds: [...ids] })}
          submitLabel={s.setupComplete ? t("tools.RemoteMcpConnectionSetup.done") : t("tools.RemoteMcpConnectionSetup.continue")} onBack={s.setupComplete ? a.finish : a.saveExit} onContinue={s.setupComplete ? a.finish : () => a.navigate("connect")} />}
        {s.step === "permissions" && <>
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t("tools.RemoteMcpConnectionSetup.permissions")}</h2><Button variant="outline" onClick={a.finish}>{t("tools.RemoteMcpConnectionSetup.connectionSettings")}</Button></div>
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
            {external("setup", t("tools.RemoteMcpConnectionSetup.openSetupGuide", { provider: provider.name }))}
          </div>
          {s.connectStatus === "sign_in" && provider.supportsBrowserAuth ? <>
            <div role="status"><InlineBanner title={t("tools.RemoteMcpConnectionSetup.finishSignIn", { provider: provider.name })}>
              {t("tools.RemoteMcpConnectionSetup.signInWaiting")}
            </InlineBanner></div>
            <p className="text-sm text-muted-foreground">{t("tools.RemoteMcpConnectionSetup.windowNotOpened")} {authorizationUrl ? <a className="text-current underline" href={authorizationUrl} onClick={() => a.openProvider("sign_in")} target="_blank" rel="noopener noreferrer">{t("tools.RemoteMcpConnectionSetup.openSignInAgain")}</a> : external("sign_in", t("tools.RemoteMcpConnectionSetup.openSignInAgain"))}.</p>
            {footer(<><Button variant="outline" onClick={a.cancelConnect}>{t("tools.RemoteMcpConnectionSetup.cancelSignIn")}</Button><Button disabled>{t("tools.RemoteMcpConnectionSetup.waitingSignIn")}</Button></>)}
          </> : <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); a.connect(); }}>
            {error && <div role="alert"><InlineBanner tone="danger" title={error.title}>{error.body}</InlineBanner></div>}
            {s.connectStatus === "cancelled" && <p role="status" className="text-sm text-muted-foreground">{t("tools.RemoteMcpConnectionSetup.cancelledNotice")}</p>}
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              {provider.defaultUrl ? <Collapsible open={sessionOpen || s.connectStatus === "invalid_url"} onOpenChange={setSessionOpen}>
                <CollapsibleTrigger asChild><Button type="button" variant="link" className="h-auto p-0 text-sm text-muted-foreground underline underline-offset-2">{t("tools.RemoteMcpConnectionSetup.reuseSession")}</Button></CollapsibleTrigger>
                <CollapsibleContent className="mt-3">{urlField}</CollapsibleContent>
              </Collapsible> : urlField}
              {defaults(<div className="space-y-4">
                  <p className="text-sm font-medium text-foreground">{t("tools.RemoteMcpConnectionSetup.authentication")}</p>
                  <p className="text-sm text-muted-foreground">{provider.authHelp}</p>
                  <div className="space-y-2"><Label htmlFor={`${uid}-auth`}>{t("tools.RemoteMcpConnectionSetup.signInMethod")}</Label><select id={`${uid}-auth`} className={selectClass} value={s.auth} onChange={(event) => change({ auth: event.target.value as RemoteMcpSetupState["auth"] })}>
                    {provider.supportsBrowserAuth && <option value="auto">{t("tools.RemoteMcpConnectionSetup.optAuto")}</option>}<option value="bearer">{t("tools.RemoteMcpConnectionSetup.bearerToken")}</option><option value="headers">{t("tools.RemoteMcpConnectionSetup.optHeaders")}</option><option value="none">{t("tools.RemoteMcpConnectionSetup.optNone")}</option>
                  </select></div>
                  {s.auth === "bearer" && <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${uid}-token`}>{t("tools.RemoteMcpConnectionSetup.bearerToken")}</Label><FieldHelp label={t("tools.RemoteMcpConnectionSetup.bearerHelpLabel")}>{t("tools.RemoteMcpConnectionSetup.bearerHelp")}</FieldHelp></div><Input id={`${uid}-token`} type="password" autoComplete="off" value={s.token} onChange={(event) => change({ token: event.target.value })} /></div>}
                  {(s.auth === "bearer" || s.auth === "headers") && <div className="space-y-3">
                    <p className="text-sm font-medium">{s.auth === "bearer" ? t("tools.RemoteMcpConnectionSetup.additionalHeaders") : t("tools.RemoteMcpConnectionSetup.headers")}</p>
                    {s.headers.map((header, index) => <div key={header.id} className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-name`}>{t("tools.RemoteMcpConnectionSetup.headerName", { n: index + 1 })}</Label><Input id={`${uid}-${header.id}-name`} value={header.name} placeholder={provider.id === "arcade" ? "Arcade-User-ID" : t("tools.RemoteMcpConnectionSetup.headerNamePlaceholder")} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, name: event.target.value } : h) })} /></div>
                      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor={`${uid}-${header.id}-value`}>{t("tools.RemoteMcpConnectionSetup.headerValue", { n: index + 1 })}</Label><Input id={`${uid}-${header.id}-value`} type="password" autoComplete="off" value={header.value} onChange={(event) => change({ headers: s.headers.map((h) => h.id === header.id ? { ...h, value: event.target.value } : h) })} /></div>
                      <Button type="button" variant="ghost" size="icon" aria-label={t("tools.RemoteMcpConnectionSetup.removeHeader", { n: index + 1 })} onClick={() => change({ headers: s.headers.filter((h) => h.id !== header.id) })}><Trash2 className="size-4" /></Button>
                    </div>)}
                    <Button type="button" variant="outline" size="sm" onClick={() => change({ headers: [...s.headers, { id: crypto.randomUUID(), name: "", value: "" }] })}><Plus className="size-4" />{t("tools.RemoteMcpConnectionSetup.addHeader")}</Button>
                  </div>}
                </div>)}
            </fieldset>
            {additionalSettings}
            {busy && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{t("tools.RemoteMcpConnectionSetup.connectingTools")}</p>}
            {footer(<>{s.setupComplete ? <Button type="button" variant="outline" disabled={busy} onClick={a.finish}>{t("tools.RemoteMcpConnectionSetup.back")}</Button> : <span />}<Button type="submit" disabled={busy || !s.url.trim() || !settingsValid}>{busy ? t("tools.RemoteMcpConnectionSetup.connecting") : error || s.connectStatus === "cancelled" ? t("tools.RemoteMcpConnectionSetup.tryAgain") : t("tools.RemoteMcpConnectionSetup.connectProvider", { provider: provider.name })}</Button></>)}
          </form>}
        </>}

        {s.step === "management" && <>
          {!s.connected ? <InlineBanner tone="warning" title={t("tools.RemoteMcpConnectionSetup.disconnectedTitle")}>{t("tools.RemoteMcpConnectionSetup.disconnectedNotice")}</InlineBanner> : <div className="space-y-2"><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4" />{t("tools.RemoteMcpConnectionSetup.connected")}{s.identity ? t("tools.RemoteMcpConnectionSetup.asIdentity", { identity: s.identity }) : ""}</p><p className="text-sm text-muted-foreground">{s.grantKind === "user" ? t("tools.RemoteMcpConnectionSetup.justMe") : t("tools.RemoteMcpConnectionSetup.anyHuman")} · {t("tools.RemoteMcpConnectionSetup.toolsCount", { count: s.tools.length })} · {s.allAgents ? t("tools.RemoteMcpConnectionSetup.anyAgent") : t("tools.RemoteMcpConnectionSetup.agentsWithAccess", { count: s.agentIds.length })}</p></div>}
          <div className="flex flex-wrap gap-2"><Button onClick={() => a.navigate("access")}>{t("tools.RemoteMcpConnectionSetup.whoCanUse")}</Button><Button variant="outline" disabled={!s.connected} onClick={() => a.navigate("permissions")}>{t("tools.RemoteMcpConnectionSetup.permissions")}</Button></div>
          <p className="text-sm text-muted-foreground">{t("tools.RemoteMcpConnectionSetup.refreshNotice", { provider: provider.name })}</p>
          <Button variant="outline" disabled={!s.connected || s.refreshing} onClick={a.refresh}>{s.refreshing ? t("tools.RemoteMcpConnectionSetup.refreshing") : t("tools.RemoteMcpConnectionSetup.refreshTools")}</Button>
          <RemoteMcpManagement providerName={provider.name} connected={s.connected} onReconnect={a.reconnect} onManage={() => a.openProvider("manage")} onDisconnect={a.disconnect} />
        </>}
        {s.step === "draft" && <><p className="text-sm">{t("tools.RemoteMcpConnectionSetup.draftKept")}</p><div className="flex justify-end"><Button onClick={a.resumeDraft}>{t("tools.RemoteMcpConnectionSetup.resumeSetup")}</Button></div></>}
        </div>
    </main>
  </div>;
}
