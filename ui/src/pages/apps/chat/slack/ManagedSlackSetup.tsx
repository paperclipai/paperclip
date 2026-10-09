import { useRef, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SetupWizardFooter } from "@/components/SetupWizard";
import type { OwnSlackAppSetup } from "./OwnSlackAppSetup";
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { sanitizedSetupErrorMessage } from "../chat-setup-error";

export function ManagedSlackSetup({ endpoint, disabled, saveDetails, onSaved, onBusy, onSaveExit, onOwnApp }: ComponentProps<typeof OwnSlackAppSetup> & { onOwnApp: () => Promise<void> }) {
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
    const input = { requestId: requestId.current, grantId, ...(confirmed ? { confirmedNoAppCreated: true } : {}) };
    setConfirmed(false);
    const result = await chatEndpointsApi.provisionManagedSlack(endpoint.id, input);
    await choices.refetch();
    onSaved(await chatEndpointsApi.get(endpoint.id));
    if (result.authorization) window.location.assign(result.authorization.authorizationUrl);
  }
  const setupError = (code: string) => code === "slack_manifest_update_pending"
    ? "Your app was created. Retry to finish its configuration."
    : code === "slack_creation_uncertain" ? "Slack may have created your app. Check Slack app settings before trying again."
    : slackRegistrationErrorMessage(code);
  const message = error ?? (endpoint.setup?.slackManagerError ? setupError(endpoint.setup.slackManagerError) : null) ?? (choices.isError ? "Couldn't load your Slack workspaces. Try again." : registration?.errorCode ? setupError(registration.errorCode) : null);
  return <div className="space-y-5">
    {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
    {choices.isPending || creating ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{creating ? "Setting up your Slack app…" : "Loading Slack…"}</p>
      : !choices.data?.managedAvailable ? <p className="text-sm">Managed Slack setup is unavailable. Try again later.</p>
      : <>
        {workspaces.length === 1 && <p className="text-sm">Add <strong>{endpoint.assignedAgentName}</strong> to <strong>{workspaces[0]!.workspaceName}</strong>.</p>}
        {workspaces.length > 1 && <Select value={grantId ?? ""} onValueChange={setSelectedGrant} disabled={busy || started}>
          <SelectTrigger aria-label="Slack workspace"><SelectValue placeholder="Choose a Slack workspace" /></SelectTrigger>
          <SelectContent>{workspaces.map(workspace => <SelectItem key={workspace.grantId} value={workspace.grantId}>{workspace.workspaceName}</SelectItem>)}</SelectContent>
        </Select>}
        {(!started || registration?.errorCode === "slack_manager_reauthorize") && workspaces.length > 0 && <div><Button variant="link" className="h-auto p-0" disabled={busy} onClick={() => void run(authorize)}>{started ? "Reconnect Slack workspace" : "Connect another Slack workspace"}</Button></div>}
      </>}
    {uncertain && <div className="space-y-3 text-sm">
      <a className="underline underline-offset-4" href={registration?.managementUrl ?? "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer">Open Slack app settings</a>
      <label className="flex items-center gap-2"><Checkbox checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={busy} />I checked Slack and no app was created. Create a new app.</label>
    </div>}
    {!started && <div><Button variant="link" className="h-auto p-0 text-muted-foreground" disabled={busy} onClick={() => void run(onOwnApp)}>Use your own app</Button></div>}
    <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
      {choices.isError || !choices.isPending && !choices.data?.managedAvailable ? <Button disabled={busy || choices.isFetching} onClick={() => void choices.refetch()}>Retry</Button> : <Button disabled={busy || disabled || creating || choices.isPending || !choices.data?.managedAvailable || (workspaces.length > 1 && !grantId) || (uncertain && !confirmed)} onClick={() => void run(connect)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{needsAuthorization && started ? "Reconnect Slack" : registration?.appId ? "Continue in Slack" : "Add to Slack"}
      </Button>}
    </SetupWizardFooter>
  </div>;
}
