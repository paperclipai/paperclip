import { t, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { Input } from "@/components/ui/input";

export interface SpekoProviderSetupProps {
  agentName: string;
  onSaveExit?(): void;
  credentials: Record<string, string>;
  onChange(values: Record<string, string>): void;
  onConnect(values: Record<string, string>): void;
  callbackUrl?: string | null;
  pending?: boolean;
  repairing?: boolean;
  /** Presence only; existing callback secrets never reach the browser. */
  signingSecretConfigured?: boolean;
}
export function SpekoProviderSetup({ agentName, onSaveExit, credentials, onChange, onConnect, callbackUrl, pending = false, repairing = false, signingSecretConfigured }: SpekoProviderSetupProps) {
  useTranslation();
  const hasSavedSecret = signingSecretConfigured ?? repairing;
  const ready = repairing && hasSavedSecret || Boolean(credentials.apiKey?.trim() && credentials.agentId?.trim());
  const reachable = callbackUrl?.startsWith("https://") === true;
  function connect() {
    if (!ready || !reachable || pending) return;
    const values = Object.fromEntries(Object.entries(credentials).filter(([, value]) => value.trim()));
    if (!hasSavedSecret && !values.signingSecret) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      values.signingSecret = `whsec_${btoa(String.fromCharCode(...bytes))}`;
      onChange(values);
    }
    onConnect(values);
  }
  return <div className="space-y-5">
    <div>
      <h1 className="text-xl font-bold">{t("oct19Voice.connectSpeko", { name: agentName })}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("oct19Voice.spekoPersona", { name: agentName })}</p>
    </div>
    <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li>{t("oct19Voice.createADedicatedAgentInSpeko_d4cju9")}</li>
      <li>{t("oct19Voice.copyItsAgentIdAndA_10boyqa")}</li>
      <li>{t("oct19Voice.reviewRecordingAndRetentionSettingsIn_k5ubqi")}</li>
    </ol>
    <Button asChild variant="outline"><a href="https://platform.speko.ai/agents" target="_blank" rel="noreferrer">{t("oct19Voice.openSpekoAgents_2ryqax")}</a></Button>
    <label className="grid gap-2 text-sm font-medium">{t("oct19Voice.spekoAgentId_1rn25lv")}<Input autoComplete="off" value={credentials.agentId ?? ""} placeholder={repairing ? t("oct19Voice.leaveBlankToKeepTheCurrent_qokine") : "agent_…"} onChange={(event) => onChange({ ...credentials, agentId: event.target.value })} /></label>
    <label className="grid gap-2 text-sm font-medium">{t("oct19Voice.spekoApiKey_gvr09k")}<Input type="password" autoComplete="new-password" value={credentials.apiKey ?? ""} placeholder={repairing ? t("oct19Voice.leaveBlankToKeepTheSaved_1yvacqf") : t("oct19Voice.pasteYourSpekoApiKey_1p23l9o")} onChange={(event) => onChange({ ...credentials, apiKey: event.target.value })} /></label>
    {!reachable && <p role="alert" className="text-sm text-destructive">{t("oct19Voice.configureAPublicHttpsCallbackOrigin_178d5ei")}</p>}
    {reachable && <p className="break-all text-xs text-muted-foreground">{t("oct19Voice.callback_qjs178")} {callbackUrl}</p>}
    <p className="text-sm text-muted-foreground">{t("oct19Voice.credentialsAndAGeneratedCallbackSigning_1pyztp6")}</p>
    {onSaveExit ? <SetupWizardFooter onSaveExit={onSaveExit} disabled={pending}><Button disabled={!ready || !reachable || pending} onClick={connect}>{pending ? t("oct19Voice.verifyingSpeko_fohzx6") : repairing ? t("oct19Voice.reconnectSpeko_qudt3a") : t("oct19Voice.connectSpeko_1c9cbg1")}</Button></SetupWizardFooter> : <div className="flex justify-end"><Button disabled={!ready || !reachable || pending} onClick={connect}>{pending ? t("oct19Voice.verifyingSpeko_fohzx6") : repairing ? t("oct19Voice.reconnectSpeko_qudt3a") : t("oct19Voice.connectSpeko_1c9cbg1")}</Button></div>}
  </div>;
}
