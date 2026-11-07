import { useTranslation } from "@/i18n";
import { useState } from "react";
import { AlertTriangle, CircleHelp, ExternalLink, Loader2 } from "lucide-react";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { CopyText } from "@/components/CopyText";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "@/lib/router";
import { gitHubAppSettingsUrl } from "./GitHubAppIdentity";

export function GitHubConnectionRecoveryNotice({ endpoint }: { endpoint: ChatEndpoint }) {
  const { t } = useTranslation("connections");
  if (!["attention", "revoked"].includes(endpoint.status)) return null;
  return (
    <section aria-label={t("github_connection_needs_repair_a475ce4")} className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{endpoint.status === "revoked" ? t("github_bot_is_disconnected_52177ac") : t("github_connection_needs_repair_a475ce4")}</h2>
          <p className="text-sm">{t("reconnect_this_bot_to_restore_github_reviews_b7e3828")}</p>
        </div>
        <Button asChild><Link to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}>{t("reconnect_github_4b320de")}</Link></Button>
        {(endpoint.lastError || endpoint.healthMessage) && <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("connection_details_ab30a5c")}</summary>
          <p className="mt-2 break-words">{endpoint.lastError ?? endpoint.healthMessage}</p>
        </details>}
      </div>
    </section>
  );
}

export const GITHUB_APP_CREDENTIAL_FIELDS = ["privateKey", "webhookSecret", "clientSecret"] as const;
export type GitHubAppCredentialField = typeof GITHUB_APP_CREDENTIAL_FIELDS[number];
export type GitHubAppCredentials = { appId: string; privateKey: string; webhookSecret: string; clientSecret?: string };

function CredentialLabel({ id, label, help }: { id: string; label: string; help: string }) {
  const { t } = useTranslation("connections");
  return <div className="flex items-center gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Tooltip><TooltipTrigger asChild><button type="button" aria-label={t("help_with_1ac2ae8", { label: label })} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <CircleHelp className="size-3.5" aria-hidden="true" />
    </button></TooltipTrigger><TooltipContent className="max-w-xs">{help}</TooltipContent></Tooltip>
  </div>;
}

export function GitHubAppRecovery({ endpoint, reconnect, credentialFields, requireAllCredentialFields = false, rotateWebhookSecret = false, rotationAlreadyCommitted = false, onConnect, onExit }: {
  endpoint: ChatEndpoint;
  reconnect: boolean;
  credentialFields?: readonly GitHubAppCredentialField[];
  requireAllCredentialFields?: boolean;
  rotateWebhookSecret?: boolean;
  rotationAlreadyCommitted?: boolean;
  onConnect: (credentials?: GitHubAppCredentials) => Promise<void>;
  onExit: () => void;
}) {
  const { t } = useTranslation("connections");
  const [replace, setReplace] = useState(!!credentialFields || !reconnect);
  const [credentials, setCredentials] = useState<GitHubAppCredentials>({ appId: endpoint.botExternalId ?? "", privateKey: "", webhookSecret: "" });
  const [privateKeyDraft, setPrivateKeyDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [rotationSecret, setRotationSecret] = useState("");
  const [rotationGeneration, setRotationGeneration] = useState<string | null>(null);
  const [rotationUncertain, setRotationUncertain] = useState(false);
  const needsPrivateKey = !credentialFields || credentialFields.includes("privateKey");
  const needsWebhookSecret = credentialFields ? credentialFields.includes("webhookSecret") : !reconnect && !["active", "paused", "revoked"].includes(endpoint.status);
  const appName = endpoint.botLabel ?? endpoint.setup?.github?.appName ?? t("your_existing_app_126d10d");
  const appIdInvalid = !!credentials.appId.trim() && !/^\d+$/.test(credentials.appId.trim());
  const keyInvalid = !!credentials.privateKey.trim() && !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(credentials.privateKey);
  const keyLoaded = !!credentials.privateKey.trim() && !keyInvalid && !privateKeyDraft;
  const incomplete = credentialFields
    ? !credentialFields.length || appIdInvalid || keyInvalid || (requireAllCredentialFields
      ? credentialFields.some(field => !credentials[field]?.trim())
      : credentialFields.every(field => !credentials[field]?.trim()))
    : replace && (!credentials.appId.trim() || !credentials.privateKey.trim() || appIdInvalid || keyInvalid || (needsWebhookSecret && !credentials.webhookSecret.trim()));
  const actionLabel = pending ? t("checking_github_2ca4420") : replace ? (reconnect ? t("verify_and_reconnect_077b8f4") : t("connect_existing_app_58f0285")) : t("reconnect_saved_app_4795129");
  async function connect() {
    setPending(true);
    setError("");
    try { await onConnect(replace ? credentials : undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("could_not_reconnect_github_try_again_fb2241f")); }
    finally { setPending(false); }
  }
  async function checkSavedRotation(expected: string | null | undefined) {
    try {
      const saved = await chatEndpointsApi.get(endpoint.id);
      if (expected !== undefined && (saved.setup?.credentialRotationId ?? null) === expected) {
        setRotationUncertain(false);
        return true;
      }
      setRotationSecret("");
      setRotationGeneration(null);
      setError(t("the_webhook_secret_changed_but_this_page_74d50bc"));
    } catch {
      // A failed status read cannot establish that the earlier secret is current.
    }
    setRotationUncertain(true);
    return false;
  }
  async function generateSecret() {
    const previousGeneration = rotationGeneration ?? (rotationSecret ? undefined : endpoint.setup?.credentialRotationId ?? null);
    setPending(true);
    setError("");
    try {
      const result = await chatEndpointsApi.generateSetupSecret(endpoint.id);
      setRotationSecret(result.webhookSecret);
      setRotationGeneration(result.credentialRotationId ?? null);
      setRotationUncertain(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("could_not_generate_the_webhook_secret_try_a68dd6c"));
      setRotationUncertain(true);
      await checkSavedRotation(previousGeneration);
    }
    finally { setPending(false); }
  }
  return <div className="space-y-6">
    {reconnect && <div className="space-y-3">
      <p className="text-sm">{t("restore_94036be")}<strong>{appName}</strong>{t("using_its_saved_credentials_paperclip_will_check_bf1e790")}</p>
      <p className="text-sm text-muted-foreground">{t("your_agent_repository_choices_review_settings_and_99dfb47")}</p>
    </div>}
    {rotateWebhookSecret && <section aria-label={t("rotate_webhook_secret_c271b8d")} className="space-y-3">
      <h2 className="text-base font-semibold">{t("rotate_the_webhook_secret_45a653e")}</h2>
      <p className="text-sm">{rotationAlreadyCommitted ? t("the_rotated_secret_is_saved_reconnect_using_544c830") : <>{t("generate_a_new_secret_then_replace_the_8060808")}<a href={gitHubAppSettingsUrl(endpoint)} target="_blank" rel="noreferrer" className="underline">{t("github_app_settings_08c2e6f")}</a>{t("github_must_verify_the_new_secret_before_c9f9e5c")}</>}</p>
      <p className="text-sm text-muted-foreground">{t("generating_immediately_invalidates_the_previous_secret_this_6a98445")}</p>
      <Button type="button" variant="outline" disabled={pending} onClick={() => void generateSecret()}>{rotationSecret || rotationAlreadyCommitted ? t("generate_another_secret_4f4a84b") : t("generate_webhook_secret_3bd1796")}</Button>
      {rotationUncertain && <p role="status" className="text-sm">{t("the_active_secret_is_not_confirmed_check_e19b3ed")}</p>}
      {rotationUncertain && rotationSecret && <Button type="button" variant="outline" disabled={pending} onClick={async () => {
        setPending(true);
        try { if (await checkSavedRotation(rotationGeneration ?? undefined)) setError(""); }
        finally { setPending(false); }
      }}>{t("check_saved_secret_status_a3d9257")}</Button>}
      {rotationSecret && !rotationUncertain && <div className="space-y-2">
        <Label htmlFor="github-rotation-secret">{t("new_webhook_secret_9a9a6b0")}</Label>
        <Input id="github-rotation-secret" type="password" autoComplete="off" disabled={pending} readOnly value={rotationSecret} />
        {!pending && <CopyText text={rotationSecret} ariaLabel={t("copy_webhook_secret_b011afb")} className="text-sm underline">{t("copy_webhook_secret_b011afb")}</CopyText>}
      </div>}
    </section>}
    {error && <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <p className="font-medium">{rotateWebhookSecret ? t("could_not_finish_secret_rotation_dd62e11") : replace ? t("could_not_reconnect_this_app_03559b2") : t("could_not_reconnect_the_saved_app_bc977d6")}</p>
      <p className="break-words">{error}</p>
      <p>{rotateWebhookSecret ? t("use_the_newest_secret_in_github_app_8aa5bdf") : t("try_again_if_the_service_is_temporarily_bbf07e8")}</p>
    </div>}
    {reconnect && !rotateWebhookSecret && !credentialFields && <Button variant="link" className="h-auto p-0" disabled={pending} onClick={() => { setReplace(!replace); setError(""); }}>
      {replace ? t("use_saved_credentials_instead_38276b3") : t("replace_app_credentials_6cf07a8")}
    </Button>}
    {replace && <div className="space-y-6">
      <div className="space-y-2 text-sm">
        <h2 className="text-base font-semibold">{reconnect ? t("replace_credentials_for_the_same_app_f1c8b5a") : t("connect_your_existing_github_app_8f89b22")}</h2>
        <p><a href={gitHubAppSettingsUrl(endpoint)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">{t("open_github_app_settings_fe0cef0")}<ExternalLink className="size-3.5" /></a>{t("and_choose_0cf27fd")}<strong>{appName}</strong>.</p>
        <p className="text-muted-foreground">{t("if_it_s_owned_by_an_organization_303ab4b")}</p>
        {credentialFields && <p className="text-muted-foreground">{t("enter_the_requested_credentials_below_other_saved_31937dc")}</p>}
      </div>
      {needsPrivateKey && <div className="space-y-2">
        <CredentialLabel id="github-app-id" label={t("app_id_c881342")} help={t("the_numeric_app_id_on_the_github_558da01")} />
        <p id="github-app-id-help" className="text-sm text-muted-foreground">{t("copy_7c39cf0")}<strong>{t("app_id_c881342")}</strong>{t("from_the_app_s_settings_page_1ae021e")}{reconnect && t("the_saved_id_is_filled_in_when_d64b388")}</p>
        <Input id="github-app-id" aria-describedby="github-app-id-help" inputMode="numeric" value={credentials.appId} disabled={pending} aria-invalid={appIdInvalid} onChange={event => setCredentials({ ...credentials, appId: event.target.value })} />
        {appIdInvalid && <p role="alert" className="text-sm text-destructive">{t("use_the_numeric_app_id_not_the_0156844")}</p>}
      </div>}
      {needsPrivateKey && <div className="space-y-2">
        <CredentialLabel id="github-private-key" label={t("private_key_7b1acb5")} help={t("upload_the_pem_file_downloaded_from_this_21bfe05")} />
        <ol id="github-private-key-help" className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>{t("in_the_same_app_s_settings_open_c371fb8")}<strong>{t("credentials_key_pairs_new_key_bd1804c")}</strong>{t("on_the_older_settings_page_use_a03fb55")}<strong>{t("private_keys_generate_a_private_key_4848fab")}</strong>.</li>
          <li>{t("upload_the_downloaded_0aedcbd")}<strong>.pem</strong>{t("file_below_or_paste_its_entire_contents_ebb4f21")}</li>
        </ol>
        <p className="text-sm text-muted-foreground">{t("you_can_reuse_a_pem_file_you_1adec05")}</p>
        <Input type="file" accept=".pem" aria-label={t("upload_private_key_pem_file_17554e1")} disabled={pending} onChange={async event => {
          const file = event.target.files?.[0];
          if (!file) return;
          setFileError("");
          try {
            const privateKey = await file.text();
            setCredentials(current => ({ ...current, privateKey }));
            setPrivateKeyDraft("");
          } catch { setFileError("Could not read this file. Try again or paste the key below."); }
        }} />
        <Input id="github-private-key" type="password" autoComplete="off" placeholder={keyLoaded ? t("paste_a_replacement_pem_key_d7d0327") : t("or_paste_the_complete_pem_key_e741fe2")} aria-describedby="github-private-key-help" disabled={pending} value={privateKeyDraft} aria-invalid={keyInvalid}
          onPaste={event => { event.preventDefault(); setCredentials({ ...credentials, privateKey: event.clipboardData.getData("text") }); setPrivateKeyDraft(""); setFileError(""); }}
          onChange={event => { setPrivateKeyDraft(event.target.value); setCredentials({ ...credentials, privateKey: event.target.value }); }} />
        {keyLoaded && <p role="status" className="text-sm">{t("private_key_loaded_paste_or_upload_another_aeaf42e")}</p>}
        {keyInvalid && <p role="alert" className="text-sm text-destructive">{t("use_a_pem_private_key_including_its_5d5be57")}</p>}
        {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
        <a className="inline-flex items-center gap-1 text-sm underline" href="https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps" target="_blank" rel="noreferrer">{t("github_s_private_key_instructions_71ff2cb")}<ExternalLink className="size-3.5" /></a>
      </div>}
      {needsWebhookSecret && <div className="space-y-2">
        <CredentialLabel id="github-webhook-secret" label={t("webhook_secret_ba261e9")} help={t("the_secret_configured_for_this_app_s_dcce357")} />
        <p className="text-sm text-muted-foreground">{t("use_the_secret_saved_when_you_configured_e8fc7bf")}</p>
        <Input id="github-webhook-secret" type="password" autoComplete="off" disabled={pending} value={credentials.webhookSecret} onChange={event => setCredentials({ ...credentials, webhookSecret: event.target.value })} />
      </div>}
      {credentialFields?.includes("clientSecret") && <div className="space-y-2">
        <CredentialLabel id="github-client-secret" label={t("client_secret_4b468ec")} help={t("the_client_secret_for_this_github_app_9278e18")} />
        <Input id="github-client-secret" type="password" autoComplete="off" disabled={pending} value={credentials.clientSecret ?? ""} onChange={event => setCredentials({ ...credentials, clientSecret: event.target.value })} />
      </div>}
    </div>}
    <SetupWizardFooter onSaveExit={onExit} disabled={pending}>
      <Button aria-label={actionLabel} disabled={pending || incomplete || rotationUncertain || (rotateWebhookSecret && !rotationSecret && !rotationAlreadyCommitted)} onClick={() => void connect()}>
        {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        <span className="sm:hidden" aria-hidden="true">{pending ? t("checking_820d600") : reconnect ? t("reconnect_6988b16") : t("connect_b65463c")}</span>
        <span className="hidden sm:inline" aria-hidden="true">{actionLabel}</span>
      </Button>
    </SetupWizardFooter>
  </div>;
}
