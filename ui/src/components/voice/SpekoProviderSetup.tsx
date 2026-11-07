import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("connections");
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
      <h1 className="text-xl font-bold">{t("connect_to_speko_7e0e29b", { agentName: agentName })}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t("choose_a_dedicated_speko_voice_persona_paperclip_5f2a1b7", { agentName: agentName })}</p>
    </div>
    <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li>{t("create_a_dedicated_agent_in_speko_and_e970079")}</li>
      <li>{t("copy_its_agent_id_and_a_speko_b4ab329")}</li>
      <li>{t("review_recording_and_retention_settings_in_your_e7bc624")}</li>
    </ol>
    <Button asChild variant="outline"><a href="https://platform.speko.ai/agents" target="_blank" rel="noreferrer">{t("open_speko_agents_6790431")}</a></Button>
    <label className="grid gap-2 text-sm font-medium">{t("speko_agent_id_3cb7890")}<Input autoComplete="off" value={credentials.agentId ?? ""} placeholder={repairing ? t("leave_blank_to_keep_the_current_persona_8342877") : t("agent_bfb1036")} onChange={(event) => onChange({ ...credentials, agentId: event.target.value })} /></label>
    <label className="grid gap-2 text-sm font-medium">{t("speko_api_key_43c3193")}<Input type="password" autoComplete="new-password" value={credentials.apiKey ?? ""} placeholder={repairing ? t("leave_blank_to_keep_the_saved_key_a130483") : t("paste_your_speko_api_key_f379261")} onChange={(event) => onChange({ ...credentials, apiKey: event.target.value })} /></label>
    {!reachable && <p role="alert" className="text-sm text-destructive">{t("configure_a_public_https_callback_origin_for_5e995b1")}</p>}
    {reachable && <p className="break-all text-xs text-muted-foreground">{t("callback_0563aed")}{callbackUrl}</p>}
    <p className="text-sm text-muted-foreground">{t("credentials_and_a_generated_callback_signing_secret_3923fe1")}</p>
    {onSaveExit ? <SetupWizardFooter onSaveExit={onSaveExit} disabled={pending}><Button disabled={!ready || !reachable || pending} onClick={connect}>{pending ? t("verifying_speko_c814c62") : repairing ? t("reconnect_speko_635d6f3") : t("connect_speko_c42bcce")}</Button></SetupWizardFooter> : <div className="flex justify-end"><Button disabled={!ready || !reachable || pending} onClick={connect}>{pending ? t("verifying_speko_c814c62") : repairing ? t("reconnect_speko_635d6f3") : t("connect_speko_c42bcce")}</Button></div>}
  </div>;
}
