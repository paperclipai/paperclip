import { useState } from "react";
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
  if (!["attention", "revoked"].includes(endpoint.status)) return null;
  return (
    <section aria-label="GitHub connection needs repair" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{endpoint.status === "revoked" ? "GitHub bot is disconnected" : "GitHub connection needs repair"}</h2>
          <p className="text-sm">Reconnect this bot to restore GitHub reviews and @mentions. Start with the App already saved in Paperclip.</p>
        </div>
        <Button asChild><Link to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}>Reconnect GitHub</Link></Button>
        {(endpoint.lastError || endpoint.healthMessage) && <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Connection details</summary>
          <p className="mt-2 break-words">{endpoint.lastError ?? endpoint.healthMessage}</p>
        </details>}
      </div>
    </section>
  );
}

export type GitHubAppCredentials = { appId: string; privateKey: string; webhookSecret: string };

function CredentialLabel({ id, label, help }: { id: string; label: string; help: string }) {
  return <div className="flex items-center gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Tooltip><TooltipTrigger asChild><button type="button" aria-label={`Help with ${label}`} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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
  const [replace, setReplace] = useState(!reconnect);
  const [credentials, setCredentials] = useState<GitHubAppCredentials>({ appId: endpoint.botExternalId ?? "", privateKey: "", webhookSecret: "" });
  const [privateKeyDraft, setPrivateKeyDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const needsWebhookSecret = !reconnect && !["active", "paused", "revoked"].includes(endpoint.status);
  const appName = endpoint.botLabel ?? endpoint.setup?.github?.appName ?? "your existing App";
  const appIdInvalid = !!credentials.appId.trim() && !/^\d+$/.test(credentials.appId.trim());
  const keyInvalid = !!credentials.privateKey.trim() && !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(credentials.privateKey);
  const keyLoaded = !!credentials.privateKey.trim() && !keyInvalid && !privateKeyDraft;
  const incomplete = replace && (!credentials.appId.trim() || !credentials.privateKey.trim() || appIdInvalid || keyInvalid || (needsWebhookSecret && !credentials.webhookSecret.trim()));
  const actionLabel = pending ? "Checking GitHub…" : replace ? (reconnect ? "Verify and reconnect" : "Connect existing App") : "Reconnect saved App";
  async function connect() {
    setPending(true);
    setError("");
    try { await onConnect(replace ? credentials : undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reconnect GitHub. Try again."); }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    {reconnect && <div className="space-y-3">
      <p className="text-sm">Restore <strong>{appName}</strong> using its saved credentials. Paperclip will check the App and its installation, then repair event delivery.</p>
      <p className="text-sm text-muted-foreground">Your agent, repository choices, review settings, and task history stay attached to this connection. You don’t need to create another GitHub App.</p>
    </div>}
    {error && <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">{replace ? "Could not reconnect this App" : "Could not reconnect the saved App"}</p>
      <p className="break-words">{error}</p>
      <p>Try again if the service is temporarily unavailable. If GitHub rejected the saved key, replace the credentials for this same App below.</p>
    </div>}
    {reconnect && <Button variant="link" className="h-auto p-0" disabled={pending} onClick={() => { setReplace(!replace); setError(""); }}>
      {replace ? "Use saved credentials instead" : "Replace App credentials…"}
    </Button>}
    {replace && <div className="space-y-6">
      <div className="space-y-2 text-sm">
        <h2 className="text-base font-semibold">{reconnect ? "Replace credentials for the same App" : "Connect your existing GitHub App"}</h2>
        <p><a href={gitHubAppSettingsUrl(endpoint)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Open GitHub App settings<ExternalLink className="size-3.5" /></a> and choose <strong>{appName}</strong>.</p>
        <p className="text-muted-foreground">If it’s owned by an organization, open that organization’s Settings → Developer settings → GitHub Apps → Edit. You’ll need permission to manage the App.</p>
      </div>
      <div className="space-y-2">
        <CredentialLabel id="github-app-id" label="App ID" help="The numeric App ID on the GitHub App’s settings page. This is different from its Client ID or installation ID." />
        <p id="github-app-id-help" className="text-sm text-muted-foreground">Copy <strong>App ID</strong> from the App’s settings page. {reconnect && "The saved ID is filled in when available."}</p>
        <Input id="github-app-id" aria-describedby="github-app-id-help" inputMode="numeric" value={credentials.appId} disabled={pending} aria-invalid={appIdInvalid} onChange={event => setCredentials({ ...credentials, appId: event.target.value })} />
        {appIdInvalid && <p role="alert" className="text-sm text-destructive">Use the numeric App ID, not the Client ID.</p>}
      </div>
      <div className="space-y-2">
        <CredentialLabel id="github-private-key" label="Private key" help="Upload the .pem file downloaded from this GitHub App, or paste its entire contents, including the BEGIN and END lines." />
        <ol id="github-private-key-help" className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>In the same App’s settings, open <strong>Credentials → Key pairs → New key</strong>. On the older settings page, use <strong>Private keys → Generate a private key</strong>.</li>
          <li>Upload the downloaded <strong>.pem</strong> file below, or paste its entire contents.</li>
        </ol>
        <p className="text-sm text-muted-foreground">You can reuse a .pem file you already saved. GitHub cannot show an old private key again. Creating a new key for the same App keeps its installation.</p>
        <Input type="file" accept=".pem" aria-label="Upload private key PEM file" disabled={pending} onChange={async event => {
          const file = event.target.files?.[0];
          if (!file) return;
          setFileError("");
          try {
            const privateKey = await file.text();
            setCredentials(current => ({ ...current, privateKey }));
            setPrivateKeyDraft("");
          } catch { setFileError("Could not read this file. Try again or paste the key below."); }
        }} />
        <Input id="github-private-key" type="password" autoComplete="off" placeholder={keyLoaded ? "Paste a replacement PEM key" : "Or paste the complete PEM key"} aria-describedby="github-private-key-help" disabled={pending} value={privateKeyDraft} aria-invalid={keyInvalid}
          onPaste={event => { event.preventDefault(); setCredentials({ ...credentials, privateKey: event.clipboardData.getData("text") }); setPrivateKeyDraft(""); setFileError(""); }}
          onChange={event => { setPrivateKeyDraft(event.target.value); setCredentials({ ...credentials, privateKey: event.target.value }); }} />
        {keyLoaded && <p role="status" className="text-sm">Private key loaded. Paste or upload another key to replace it.</p>}
        {keyInvalid && <p role="alert" className="text-sm text-destructive">Use a PEM private key, including its BEGIN and END lines. A token or client secret won’t work here.</p>}
        {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
        <a className="inline-flex items-center gap-1 text-sm underline" href="https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps" target="_blank" rel="noreferrer">GitHub’s private key instructions<ExternalLink className="size-3.5" /></a>
      </div>
      {needsWebhookSecret && <div className="space-y-2">
        <CredentialLabel id="github-webhook-secret" label="Webhook secret" help="The secret configured for this App’s webhook. It must match GitHub exactly." />
        <p className="text-sm text-muted-foreground">Use the secret saved when you configured this App’s webhook. If you no longer have it, change the webhook secret in GitHub App settings and enter the same value here.</p>
        <Input id="github-webhook-secret" type="password" autoComplete="off" disabled={pending} value={credentials.webhookSecret} onChange={event => setCredentials({ ...credentials, webhookSecret: event.target.value })} />
      </div>}
    </div>}
    <SetupWizardFooter onSaveExit={onExit} disabled={pending}>
      <Button aria-label={actionLabel} disabled={pending || incomplete} onClick={() => void connect()}>
        {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        <span className="sm:hidden" aria-hidden="true">{pending ? "Checking…" : reconnect ? "Reconnect" : "Connect"}</span>
        <span className="hidden sm:inline" aria-hidden="true">{actionLabel}</span>
      </Button>
    </SetupWizardFooter>
  </div>;
}
