import { useAuthorizationWindow } from "@/hooks/useAuthorizationWindow";
import { useQueryView } from "@/components/QueryView";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import { bindAccount } from "@/lib/account-scope";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { useTranslation } from "@/i18n";
import type { OwnSlackAppSetup } from "./OwnSlackAppSetup";
import { sanitizedSetupErrorMessage } from "../chat-setup-error";

export function ManagedSlackSetup({ endpoint, disabled, saveDetails, onSaved, onBusy, onSaveExit, autoStart = false, reconnect = false }: ComponentProps<typeof OwnSlackAppSetup> & { autoStart?: boolean; reconnect?: boolean }) {
  const client = useQueryClient();
  const { t } = useTranslation();
  const choices = useQuery({ queryKey: ["slack-managed-workspaces", endpoint.companyId], queryFn: () => chatEndpointsApi.slackSetupOptions(endpoint.companyId) });
  const choicesView = useQueryView(choices);
  const [selectedGrant, setSelectedGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizationRequested, setAuthorizationRequested] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const inFlight = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const registration = endpoint.setup?.slackRegistration;
  const started = Boolean(registration);
  const workspaces = choices.data?.workspaces ?? [];
  const grantId = registration?.managerGrantId ?? selectedGrant ?? (workspaces.length === 1 ? workspaces[0]!.grantId : null);
  const needsAuthorization = authorizationRequested || !grantId || endpoint.setup?.slackManagerError === "slack_manager_reauthorize" || registration?.errorCode === "slack_manager_reauthorize" || Boolean(grantId && !workspaces.some(workspace => workspace.grantId === grantId));
  const reconnectWorkspace = needsAuthorization && (started || Boolean(error) || endpoint.setup?.slackManagerError === "slack_manager_reauthorize");
  const uncertain = registration?.status === "uncertain";
  const creating = registration?.status === "creating";
  const authorizationWindow = useAuthorizationWindow();
  useEffect(() => {
    if (!authorizationRequested || busy) return;
    let disposed = false;
    let refreshing = false;
    const account = bindAccount(client);
    const refresh = async (returnedFromProvider = false) => {
      if (refreshing || !account.isCurrentScope()) return;
      refreshing = true;
      try {
        const [options, saved] = await Promise.all([choices.refetch(), chatEndpointsApi.get(endpoint.id)]);
        if (disposed || !account.isCurrentScope()) return;
        if (options.isError) throw options.error;
        onSaved(saved);
        const hasAuthorizedWorkspace = Boolean(options.data?.workspaces.length)
          && !saved.setup?.slackManagerError
          && saved.setup?.slackRegistration?.errorCode !== "slack_manager_reauthorize";
        // A focus event alone does not mean a blocked sign-in was completed.
        if (!returnedFromProvider && !hasAuthorizedWorkspace) return;
        setAuthorizationRequested(false);
        setError(null);
        authorizationWindow.cancel();
      } catch (failure) {
        if (!disposed && account.isCurrentScope()) setError(sanitizedSetupErrorMessage(failure, {}));
      } finally { refreshing = false; }
    };
    const observeReturn = () => {
      const popup = authorizationWindow.windowRef.current;
      if (!popup) return;
      if (popup.closed) { void refresh(); return; }
      try {
        const url = new URL(popup.location.href);
        if (url.origin === window.location.origin && url.pathname.endsWith("/apps/chat/connect")
          && url.searchParams.get("resume") === endpoint.id) void refresh(true);
      } catch { /* The sign-in window is still at the provider. */ }
    };
    // Focus also covers the native fallback link, which has no window handle.
    const onFocus = () => {
      if (authorizationWindow.windowRef.current) observeReturn();
      else void refresh();
    };
    const timer = window.setInterval(observeReturn, 1_500);
    window.addEventListener("focus", onFocus);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [authorizationRequested, busy, client, endpoint.id, choices.refetch, onSaved, authorizationWindow.cancel, authorizationWindow.windowRef]);
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onBusy(true); setError(null);
    try { await action(); }
    catch (failure) { authorizationWindow.cancel(); setError(sanitizedSetupErrorMessage(failure, {})); await Promise.allSettled([choices.refetch(), chatEndpointsApi.get(endpoint.id).then(onSaved)]); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  }
  async function authorize() {
    authorizationWindow.reserve();
    setAuthorizationRequested(true);
    const authorization = await chatEndpointsApi.authorizeSlackManager(endpoint.id);
    await authorizationWindow.open(authorization);
  }
  async function connect() {
    if (needsAuthorization || !grantId) {
      await authorize(); return;
    }
    authorizationWindow.reserve();
    if (!started) await saveDetails();
    if (confirmed || registration?.status === "failed") requestId.current = crypto.randomUUID();
    const input = { requestId: requestId.current, grantId, ...(reconnect ? { reconnect: true } : {}), ...(confirmed ? { confirmedNoAppCreated: true } : {}) };
    setConfirmed(false);
    const result = await chatEndpointsApi.provisionManagedSlack(endpoint.id, input);
    await choices.refetch();
    onSaved(await chatEndpointsApi.get(endpoint.id));
    if (result.authorization) await authorizationWindow.open(result.authorization);
    else authorizationWindow.cancel();
  }
  const autoStarted = useRef(false);
  useEffect(() => {
    // Only fresh setup can start itself. Declines, uncertain creation, and saved
    // registration recovery require an explicit action and never recreate an app.
    if (!autoStart || autoStarted.current || disabled || !choices.data?.managedAvailable
      || choices.isFetching || (choicesView.kind === "error") || started || endpoint.setup?.slackManagerError
      || workspaces.length > 1) return;
    autoStarted.current = true;
    void run(connect);
  });
  const setupError = (code: string) => code === "slack_manifest_update_pending"
    ? t("apps.ManagedSlackSetup.manifestPending")
    : code === "slack_creation_uncertain" ? t("apps.ManagedSlackSetup.creationUncertain")
    : slackRegistrationErrorMessage(code);
  const message = error ?? (endpoint.setup?.slackManagerError ? setupError(endpoint.setup.slackManagerError) : null) ?? ((choicesView.kind === "error") ? t("apps.ManagedSlackSetup.loadWorkspacesError") : registration?.errorCode ? setupError(registration.errorCode) : null);
  return <div className="space-y-5">
    {authorizationWindow.fallback}
    {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
    {busy || choices.isPending || creating ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{busy ? needsAuthorization ? t("apps.ManagedSlackSetup.openingSlack") : t("apps.ManagedSlackSetup.connectingAgent") : creating ? t("apps.ManagedSlackSetup.settingUpApp") : t("apps.ManagedSlackSetup.loadingSlack")}</p>
      : !choices.data?.managedAvailable ? <p className="text-sm">{t("apps.ManagedSlackSetup.unavailable")}</p>
      : reconnectWorkspace ? null : <>
        {workspaces.length === 1 && <p className="text-sm">{t("apps.ManagedSlackSetup.addAgent")} <strong>{endpoint.assignedAgentName}</strong> {t("apps.ManagedSlackSetup.addTo")} <strong>{workspaces[0]!.workspaceName}</strong>.</p>}
        {workspaces.length > 1 && <Select value={grantId ?? ""} onValueChange={setSelectedGrant} disabled={busy || started}>
          <SelectTrigger aria-label={t("apps.ManagedSlackSetup.workspaceAria")}><SelectValue placeholder={t("apps.ManagedSlackSetup.choosePlaceholder")} /></SelectTrigger>
          <SelectContent>{workspaces.map(workspace => <SelectItem key={workspace.grantId} value={workspace.grantId}>{workspace.workspaceName}</SelectItem>)}</SelectContent>
        </Select>}
        {!started && workspaces.length > 0 && <div><Button variant="link" className="h-auto p-0" disabled={busy} onClick={() => void run(authorize)}>{t("apps.ManagedSlackSetup.connectAnother")}</Button></div>}
      </>}
    {uncertain && <div className="space-y-3 text-sm">
      <a className="underline underline-offset-4" href={registration?.managementUrl ?? "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer">{t("apps.ManagedSlackSetup.openSettings")}</a>
      <label className="flex items-center gap-2"><Checkbox checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={busy} />{t("apps.ManagedSlackSetup.checkedNoApp")}</label>
    </div>}
    <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
      {(choicesView.kind === "error") || !choices.isPending && !choices.data?.managedAvailable ? <Button disabled={busy || choices.isFetching} onClick={() => void choices.refetch()}>{t("apps.ManagedSlackSetup.retry")}</Button> : <Button disabled={busy || disabled || creating || choices.isPending || !choices.data?.managedAvailable || (workspaces.length > 1 && !grantId && !reconnectWorkspace) || (uncertain && !confirmed)} onClick={() => void run(connect)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{reconnectWorkspace ? t("apps.ManagedSlackSetup.reconnectWorkspace") : registration?.appId ? t("apps.ManagedSlackSetup.continueInSlack") : t("apps.ManagedSlackSetup.continue")}
      </Button>}
    </SetupWizardFooter>
  </div>;
}
