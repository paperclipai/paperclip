import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useState, type ReactNode } from "react";
import { AlertTriangle, CircleHelp, ExternalLink, Loader2 } from "lucide-react";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "@/lib/router";
import { gitHubAppSettingsUrl } from "./GitHubAppIdentity";

export function GitHubConnectionRecoveryNotice({ endpoint }: { endpoint: ChatEndpoint }) {
  useTranslation();
  if (!["attention", "revoked"].includes(endpoint.status)) return null;
  return (
    <section aria-label={t("oct26Audit.github.repairTitle")} className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{endpoint.status === "revoked" ? t("oct26Audit.github.disconnected") : t("oct26Audit.github.repairTitle")}</h2>
          <p className="text-sm">{t("oct26Audit.github.reconnectDescription")}</p>
        </div>
        <Button asChild><Link to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}>{t("oct26Audit.github.reconnect")}</Link></Button>
        {(endpoint.lastError || endpoint.healthMessage) && <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("oct26Audit.github.connectionDetails")}</summary>
          <p className="mt-2 break-words">{endpoint.lastError ?? endpoint.healthMessage}</p>
        </details>}
      </div>
    </section>
  );
}

export type GitHubAppCredentials = { appId: string; privateKey: string; webhookSecret: string };

function CredentialLabel({ id, label, help, helpLabel }: { id: string; label: string; help: string; helpLabel: string }) {
  useTranslation();
  return <div className="flex items-center gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Tooltip><TooltipTrigger asChild><button type="button" aria-label={helpLabel} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <CircleHelp className="size-3.5" aria-hidden="true" />
    </button></TooltipTrigger><TooltipContent className="max-w-xs">{help}</TooltipContent></Tooltip>
  </div>;
}

export function GitHubAppRecovery({ endpoint, reconnect, onConnect, onExit }: {
  endpoint: ChatEndpoint;
  reconnect: boolean;
  onConnect: (credentials?: GitHubAppCredentials) => Promise<void>;
  onExit: () => void;
}) {
  useTranslation();
  const [replace, setReplace] = useState(!reconnect);
  const [credentials, setCredentials] = useState<GitHubAppCredentials>({ appId: endpoint.botExternalId ?? "", privateKey: "", webhookSecret: "" });
  const [privateKeyDraft, setPrivateKeyDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [fileError, setFileError] = useState(false);
  const needsWebhookSecret = !reconnect && !["active", "paused", "revoked"].includes(endpoint.status);
  const appName = endpoint.botLabel ?? endpoint.setup?.github?.appName ?? null;
  const appIdInvalid = !!credentials.appId.trim() && !/^\d+$/.test(credentials.appId.trim());
  const keyInvalid = !!credentials.privateKey.trim() && !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(credentials.privateKey);
  const keyLoaded = !!credentials.privateKey.trim() && !keyInvalid && !privateKeyDraft;
  const incomplete = replace && (!credentials.appId.trim() || !credentials.privateKey.trim() || appIdInvalid || keyInvalid || (needsWebhookSecret && !credentials.webhookSecret.trim()));
  const actionLabel = pending ? t("oct26Audit.github.checkingGithub") : replace ? (reconnect ? t("oct26Audit.github.verifyReconnect") : t("oct26Audit.github.connectExisting")) : t("oct26Audit.github.reconnectSaved");
  async function connect() {
    setPending(true);
    setError(null);
    try { await onConnect(replace ? credentials : undefined); }
    catch (cause) { setError(cause instanceof Error ? cause : new GitHubRecoveryError()); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    {reconnect && <div className="space-y-3">
      <p className="text-sm"><Trans i18nKey={appName !== null ? "oct26Audit.github.restoreNamed" : "oct26Audit.github.restoreUnnamed"} values={{ name: appName ?? "" }} components={{ strong: <strong /> }} /></p>
      <p className="text-sm text-muted-foreground">{t("oct26Audit.github.keepConfiguration")}</p>
    </div>}
    {error && <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">{replace ? t("oct26Audit.github.reconnectAppError") : t("oct26Audit.github.reconnectSavedError")}</p>
      <p className="break-words">{error instanceof GitHubRecoveryError ? t("oct26Audit.github.reconnectError") : error.message}</p>
      <p>{t("oct26Audit.github.retryHint")}</p>
    </div>}
    {reconnect && <Button variant="link" className="h-auto p-0" disabled={pending} onClick={() => { setReplace(!replace); setError(null); }}>
      {replace ? t("oct26Audit.github.useSaved") : t("oct26Audit.github.replaceCredentials")}
    </Button>}
    {replace && <div className="space-y-6">
      <div className="space-y-2 text-sm">
        <h2 className="text-base font-semibold">{reconnect ? t("oct26Audit.github.replaceTitle") : t("oct26Audit.github.connectTitle")}</h2>
        <p><Trans i18nKey={appName !== null ? "oct26Audit.github.chooseNamed" : "oct26Audit.github.chooseUnnamed"} values={{ name: appName ?? "" }} components={{ settings: <GitHubSettingsLink href={gitHubAppSettingsUrl(endpoint)} />, strong: <strong /> }} /></p>
        <p className="text-muted-foreground">{t("oct26Audit.github.organizationHint")}</p>
      </div>
      <div className="space-y-2">
        <CredentialLabel helpLabel={t("oct26Audit.github.helpAppId")} id="github-app-id" label={t("oct26Audit.github.appId")} help={t("oct26Audit.github.appIdHelp")} />
        <p id="github-app-id-help" className="text-sm text-muted-foreground"><Trans i18nKey="oct26Audit.github.copyAppId" components={{ strong: <strong /> }} /> {reconnect && t("oct26Audit.github.savedIdHint")}</p>
        <Input id="github-app-id" aria-describedby="github-app-id-help" inputMode="numeric" value={credentials.appId} disabled={pending} aria-invalid={appIdInvalid} onChange={event => setCredentials({ ...credentials, appId: event.target.value })} />
        {appIdInvalid && <p role="alert" className="text-sm text-destructive">{t("oct26Audit.github.numericIdError")}</p>}
      </div>
      <div className="space-y-2">
        <CredentialLabel helpLabel={t("oct26Audit.github.helpPrivateKey")} id="github-private-key" label={t("oct26Audit.github.privateKey")} help={t("oct26Audit.github.privateKeyHelp")} />
        <ol id="github-private-key-help" className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li><Trans i18nKey="oct26Audit.github.keyLocation" components={{ current: <strong />, legacy: <strong /> }} /></li>
          <li><Trans i18nKey="oct26Audit.github.uploadInstructions" components={{ strong: <strong /> }} /></li>
        </ol>
        <p className="text-sm text-muted-foreground">{t("oct26Audit.github.reuseKey")}</p>
        <Input type="file" accept=".pem" aria-label={t("oct26Audit.github.uploadPem")} disabled={pending} onChange={async event => {
          const file = event.target.files?.[0];
          if (!file) return;
          setFileError(false);
          try {
            const privateKey = await file.text();
            setCredentials(current => ({ ...current, privateKey }));
            setPrivateKeyDraft("");
          } catch { setFileError(true); }
        }} />
        <Input id="github-private-key" type="password" autoComplete="off" placeholder={keyLoaded ? t("oct26Audit.github.replacePem") : t("oct26Audit.github.pastePem")} aria-describedby="github-private-key-help" disabled={pending} value={privateKeyDraft} aria-invalid={keyInvalid}
          onPaste={event => { event.preventDefault(); setCredentials({ ...credentials, privateKey: event.clipboardData.getData("text") }); setPrivateKeyDraft(""); setFileError(false); }}
          onChange={event => { setPrivateKeyDraft(event.target.value); setCredentials({ ...credentials, privateKey: event.target.value }); }} />
        {keyLoaded && <p role="status" className="text-sm">{t("oct26Audit.github.keyLoaded")}</p>}
        {keyInvalid && <p role="alert" className="text-sm text-destructive">{t("oct26Audit.github.invalidKey")}</p>}
        {fileError && <p role="alert" className="text-sm text-destructive">{t("oct26Audit.github.readFileError")}</p>}
        <a className="inline-flex items-center gap-1 text-sm underline" href="https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps" target="_blank" rel="noreferrer">{t("oct26Audit.github.keyInstructions")}<ExternalLink className="size-3.5" /></a>
      </div>
      {needsWebhookSecret && <div className="space-y-2">
        <CredentialLabel helpLabel={t("oct26Audit.github.helpWebhookSecret")} id="github-webhook-secret" label={t("oct26Audit.github.webhookSecret")} help={t("oct26Audit.github.webhookHelp")} />
        <p className="text-sm text-muted-foreground">{t("oct26Audit.github.webhookInstructions")}</p>
        <Input id="github-webhook-secret" type="password" autoComplete="off" disabled={pending} value={credentials.webhookSecret} onChange={event => setCredentials({ ...credentials, webhookSecret: event.target.value })} />
      </div>}
    </div>}
    <SetupWizardFooter onSaveExit={onExit} disabled={pending}>
      <Button aria-label={actionLabel} disabled={pending || incomplete} onClick={() => void connect()}>
        {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        <span className="sm:hidden" aria-hidden="true">{pending ? t("oct26Audit.github.checking") : reconnect ? t("oct26Audit.github.reconnectShort") : t("oct26Audit.github.connectShort")}</span>
        <span className="hidden sm:inline" aria-hidden="true">{actionLabel}</span>
      </Button>
    </SetupWizardFooter>
  </div>;
}

class GitHubRecoveryError extends Error {}

function GitHubSettingsLink({ href, children }: { href: string; children?: ReactNode }) {
  useTranslation();
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{children}<ExternalLink className="size-3.5" /></a>;
}
