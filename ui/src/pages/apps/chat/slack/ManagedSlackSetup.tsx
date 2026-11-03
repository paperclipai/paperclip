import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { slackRegistrationDisplayError } from "../slack-registration-copy";
import { chatUiErrorMessage } from "../chat-copy";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SetupWizardFooter } from "@/components/SetupWizard";
import type { OwnSlackAppSetup } from "./OwnSlackAppSetup";
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { sanitizedSetupErrorMessage } from "../chat-setup-error";

export function ManagedSlackSetup({ endpoint, disabled, saveDetails, onSaved, onBusy, onSaveExit, autoStart = false, reconnect = false }: ComponentProps<typeof OwnSlackAppSetup> & { autoStart?: boolean; reconnect?: boolean }) {
  const { t } = useTranslation();
  const choices = useQuery({ queryKey: ["slack-managed-workspaces", endpoint.companyId], queryFn: () => chatEndpointsApi.slackSetupOptions(endpoint.companyId), retry: false });
  const [selectedGrant, setSelectedGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const inFlight = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const registration = endpoint.setup?.slackRegistration;
  const started = Boolean(registration);
  const workspaces = choices.data?.workspaces ?? [];
  const grantId = registration?.managerGrantId ?? selectedGrant ?? (workspaces.length === 1 ? workspaces[0]!.grantId : null);
  const needsAuthorization = !grantId || registration?.errorCode === "slack_manager_reauthorize" || Boolean(grantId && !workspaces.some(workspace => workspace.grantId === grantId));
  const uncertain = registration?.status === "uncertain";
  const creating = registration?.status === "creating";
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onBusy(true); setError(null);
    try { await action(); }
    catch (failure) { setError(sanitizedSetupErrorMessage(failure, {})); await Promise.allSettled([choices.refetch(), chatEndpointsApi.get(endpoint.id).then(onSaved)]); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  }
  async function authorize() {
    const authorization = await chatEndpointsApi.authorizeSlackManager(endpoint.id);
    const target = await prepareOAuthNavigation(authorization);
    if (target.kind === "reauthentication" && authorization.handoff) savePendingCloudHandoff(authorization.handoff.session);
    window.location.assign(target.url);
  }
  async function connect() {
    if (needsAuthorization || !grantId) {
      await authorize(); return;
    }
    if (!started) await saveDetails();
    if (confirmed || registration?.status === "failed") requestId.current = crypto.randomUUID();
    const input = { requestId: requestId.current, grantId, ...(reconnect ? { reconnect: true } : {}), ...(confirmed ? { confirmedNoAppCreated: true } : {}) };
    setConfirmed(false);
    const result = await chatEndpointsApi.provisionManagedSlack(endpoint.id, input);
    await choices.refetch();
    onSaved(await chatEndpointsApi.get(endpoint.id));
    if (result.authorization) window.location.assign(result.authorization.authorizationUrl);
  }
  const autoStarted = useRef(false);
  useEffect(() => {
    // Only fresh setup can start itself. Declines, uncertain creation, and saved
    // registration recovery require an explicit action and never recreate an app.
    if (!autoStart || autoStarted.current || disabled || !choices.data?.managedAvailable
      || choices.isFetching || choices.isError || started || endpoint.setup?.slackManagerError
      || workspaces.length > 1) return;
    autoStarted.current = true;
    void run(connect);
  });
  const setupError = (code: string) => code === "slack_manifest_update_pending"
    ? t("oct19Apps.slackAppCreatedConfigure")
    : code === "slack_creation_uncertain" ? t("oct19Apps.slackMayHaveCreated")
    : slackRegistrationDisplayError(code);
  const message = chatUiErrorMessage(error) ?? (endpoint.setup?.slackManagerError ? setupError(endpoint.setup.slackManagerError) : null) ?? (choices.isError ? t("oct19Apps.loadSlackWorkspacesFailed") : registration?.errorCode ? setupError(registration.errorCode) : null);
  return <div className="space-y-5">
    {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
    {busy || choices.isPending || creating ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{busy ? needsAuthorization ? t("oct19Apps.openingSlack") : t("oct19Apps.connectingAgent") : creating ? t("oct19Apps.settingUpSlack") : t("oct19Apps.loadingSlack")}</p>
      : !choices.data?.managedAvailable ? <p className="text-sm">{t("oct19Apps.managedSlackUnavailable")}</p>
      : <>
        {workspaces.length === 1 && <p className="text-sm"><Trans i18nKey="oct19Apps.addAgentToSlack" values={{ agent: endpoint.assignedAgentName, workspace: workspaces[0]!.workspaceName }} components={{ agent: <strong />, workspace: <strong /> }} /></p>}
        {workspaces.length > 1 && <Select value={grantId ?? ""} onValueChange={setSelectedGrant} disabled={busy || started}>
          <SelectTrigger aria-label={t("oct19Apps.slackWorkspace")}><SelectValue placeholder={t("oct19Apps.chooseSlackWorkspace")} /></SelectTrigger>
          <SelectContent>{workspaces.map(workspace => <SelectItem key={workspace.grantId} value={workspace.grantId}>{workspace.workspaceName}</SelectItem>)}</SelectContent>
        </Select>}
        {(!started || registration?.errorCode === "slack_manager_reauthorize") && workspaces.length > 0 && <div><Button variant="link" className="h-auto p-0" disabled={busy} onClick={() => void run(authorize)}>{started ? t("oct19Apps.reconnectSlackWorkspace") : t("oct19Apps.connectAnotherSlackWorkspace")}</Button></div>}
      </>}
    {uncertain && <div className="space-y-3 text-sm">
      <a className="underline underline-offset-4" href={registration?.managementUrl ?? "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer">{t("oct19Apps.openSlackAppSettings")}</a>
      <label className="flex items-center gap-2"><Checkbox checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={busy} />{t("oct19Apps.checkedNoSlackApp")}</label>
    </div>}
    <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
      {choices.isError || !choices.isPending && !choices.data?.managedAvailable ? <Button disabled={busy || choices.isFetching} onClick={() => void choices.refetch()}>{t("stable916Shell.retry")}</Button> : <Button disabled={busy || disabled || creating || choices.isPending || !choices.data?.managedAvailable || (workspaces.length > 1 && !grantId) || (uncertain && !confirmed)} onClick={() => void run(connect)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{needsAuthorization && started ? t("oct19Apps.reconnectSlack") : registration?.appId ? t("oct19Apps.continueInSlack") : t("pages.inviteLanding.actions.continue")}
      </Button>}
    </SetupWizardFooter>
  </div>;
}
