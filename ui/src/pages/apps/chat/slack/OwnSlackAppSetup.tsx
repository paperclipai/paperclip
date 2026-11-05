import { useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { slackRegistrationErrorMessage } from "@paperclipai/shared";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { sanitizedSetupErrorMessage } from "../chat-setup-error";
import { SlackSetupAdvanced } from "../SlackAppDetails";

/** Uses ordinary request-local state: configuration tokens never enter a query/mutation cache. */
export function OwnSlackAppSetup({ endpoint, stage, disabled, saveDetails, onSaved, onBusy,
  onManual, onManaged, onContinue, onSaveExit }: {
  endpoint: ChatEndpoint;
  stage: "app" | "credentials";
  disabled: boolean;
  saveDetails: () => Promise<void>;
  onSaved: (endpoint: ChatEndpoint) => void;
  onBusy: (busy: boolean) => void;
  onManual: (existing: boolean) => Promise<void>;
  onManaged?: () => Promise<void>;
  onContinue: () => void;
  onSaveExit: () => void;
}) {
  const { t } = useTranslation("connections");
  const [configurationToken, setConfigurationToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedNoApp, setCheckedNoApp] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const pendingWindow = useRef<Window | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingWindow.current?.close();
      pendingWindow.current = null;
    };
  }, []);
  const registration = endpoint.setup?.slackRegistration;
  const uncertain = registration?.status === "uncertain";
  const creating = registration?.status === "creating";
  const created = Boolean(registration?.appId);
  const configurationPending = registration?.errorCode === "slack_manifest_update_pending";

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(sanitizedSetupErrorMessage(failure, { configurationToken })); }
    finally {
      setConfigurationToken("");
      setBusy(false);
      onBusy(false);
      inFlight.current = false;
    }
  }

  async function create() {
    // Reserve the window during the click so async app creation cannot trigger a popup blocker.
    const installWindow = window.open("about:blank", "_blank");
    if (installWindow) {
      installWindow.opener = null;
      installWindow.document.title = t("preparing_slack_installation_c2472ce");
      installWindow.document.body.textContent = t("preparing_your_slack_installation_ed8521b");
      pendingWindow.current = installWindow;
    }
    let token = configurationToken.trim();
    setConfigurationToken("");
    try {
      let next: ChatEndpoint;
      try {
        if (!created) await saveDetails();
        if (registration?.status === "failed" || checkedNoApp) requestId.current = crypto.randomUUID();
        setCheckedNoApp(false);
        next = await chatEndpointsApi.createSlackApp(endpoint.id, {
          requestId: requestId.current,
          credentials: { configurationToken: token },
          ...(checkedNoApp ? { confirmedNoAppCreated: true } : {}),
        });
      } catch (failure) {
        // A response can be lost after Slack creates the app. Only saved state can advance.
        const current = await chatEndpointsApi.get(endpoint.id).catch(() => null);
        if (current && mounted.current) onSaved(current);
        if (!current?.setup?.slackRegistration?.appId) {
          throw new Error(sanitizedSetupErrorMessage(failure, { configurationToken: token }));
        }
        next = current;
      }
      token = "";
      if (!mounted.current) return;
      onSaved(next);
      const saved = next.setup?.slackRegistration;
      if (!saved?.appId) return;
      onContinue();
      // Pending/uncertain configuration and existing installations must not start OAuth.
      if (saved.status !== "install" || saved.errorCode) return;
      if (!installWindow || installWindow.closed) {
        setError(t("select_install_in_slack_to_open_the_6c08517"));
        return;
      }
      const result = await chatEndpointsApi.installSlackApp(endpoint.id);
      if (!mounted.current) return;
      if (installWindow.closed) {
        setError(t("select_install_in_slack_to_reopen_the_fa36eb9"));
        return;
      }
      installWindow.location.replace(result.authorizationUrl);
      pendingWindow.current = null;
    } finally {
      token = "";
      pendingWindow.current?.close();
      pendingWindow.current = null;
    }
  }

  async function authorize() {
    const result = await chatEndpointsApi.installSlackApp(endpoint.id);
    // Current-tab navigation avoids popup blockers. The callback resumes this saved draft.
    window.location.assign(result.authorizationUrl);
  }

  return <div className="space-y-5">
    {error || registration?.errorCode ? <p role="alert" className="text-sm text-destructive">
      {error ?? slackRegistrationErrorMessage(registration!.errorCode!)}
    </p> : null}
    {(stage === "app" && !created && !creating || configurationPending) && <>
      {uncertain && <div className="space-y-3 text-sm">
        <a href={registration?.managementUrl ?? "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{t("open_slack_app_settings_6f81d2a")}<ExternalLink className="inline size-3" /></a>
        <label className="flex items-center gap-2">
          <Checkbox checked={checkedNoApp} disabled={busy} onCheckedChange={value => setCheckedNoApp(value === true)} />{t("i_checked_slack_and_no_app_was_bfe1cab")}</label>
      </div>}
      {(!uncertain || checkedNoApp) && <div className="space-y-2">
        <Button asChild size="lg" className="mb-4 h-auto w-full whitespace-normal py-4">
          <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">{t("get_your_app_configuration_access_token_87ba28f")}<ExternalLink className="size-4" /></a>
        </Button>
        <div id="slack-configuration-token-help" className="space-y-3 pb-3 text-sm">
          <ol className="list-decimal space-y-2 pl-5">
            <li>{t("in_slack_app_settings_find_d113895")}<strong>{t("your_app_configuration_tokens_262ffff")}</strong>{t("and_choose_0cf27fd")}<strong>{t("generate_token_f9488c3")}</strong>.</li>
            <li>{t("select_the_workspace_where_you_want_to_c4435cb")}</li>
            <li>{t("copy_the_f11b372")}<strong>{t("access_token_0d23c1e")}</strong>{t("and_paste_it_below_e7f557e")}</li>
          </ol>
          <p className="text-muted-foreground">{t("paperclip_uses_this_token_to_create_your_e8707f0")}</p>
        </div>
        <label htmlFor="slack-configuration-token" className="text-sm font-medium">{t("app_configuration_access_token_4c31df4")}</label>
        <Input id="slack-configuration-token" type="password" autoComplete="off" spellCheck={false}
          value={configurationToken} disabled={busy} onChange={event => setConfigurationToken(event.target.value)}
          aria-describedby="slack-configuration-token-help" />
      </div>}
    </>}
    {creating && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("creating_your_slack_app_you_can_return_be03466")}</p>}
    {created && <p className="text-sm">
      <strong>{endpoint.setup?.slackApp?.appName ?? t("your_slack_app_313847d")}</strong>{t("is_created_cdf8135")}{stage === "credentials" && t("approve_installation_with_your_slack_account_paperclip_e4e0b23")}
    </p>}
    {stage === "credentials" && registration?.status === "credentials_saved" && <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("your_installation_credentials_are_saved_retry_connecting_7b1dfd6")}</p>
      <Button variant="link" className="h-auto p-0" disabled={busy || disabled} onClick={() => void run(authorize)}>{t("authorize_in_slack_again_30bb580")}</Button>
    </div>}
    {stage === "app" && <SlackSetupAdvanced><div className="flex flex-wrap gap-4 text-sm">
      {onManaged && !registration && <Button variant="link" className="h-auto p-0" disabled={busy} onClick={() => void run(onManaged)}>{t("use_managed_setup_3c8a25d")}</Button>}
      <Button variant="link" className="h-auto p-0" disabled={busy || creating} onClick={() => void run(() => onManual(false))}>{t("create_manually_bb94827")}</Button>
      <Button variant="link" className="h-auto p-0" disabled={busy || creating} onClick={() => void run(() => onManual(true))}>{t("use_an_existing_app_ea8c73f")}</Button>
    </div></SlackSetupAdvanced>}
    <SetupWizardFooter onSaveExit={onSaveExit} disabled={busy}>
      {configurationPending ? <Button disabled={busy || disabled || !configurationToken.trim()} onClick={() => void run(create)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{t("retry_app_configuration_63ec2a4")}</Button> : stage === "app" ? <Button disabled={busy || disabled || creating || (!created && (!configurationToken.trim() || uncertain && !checkedNoApp))}
        onClick={() => created ? onContinue() : void run(create)}>
        {busy && <Loader2 className="size-4 animate-spin" />}{created ? t("continue_to_installation_18fba8e") : t("create_slack_app_ecbbce8")}
      </Button> : registration?.status === "credentials_saved" ? <Button disabled={busy} onClick={() => void run(async () => onSaved(await chatEndpointsApi.resumeSlackInstallation(endpoint.id)))}>
        {busy && <Loader2 className="size-4 animate-spin" />}{t("retry_connecting_bdc640f")}</Button> : <Button disabled={busy || !created || disabled} onClick={() => void run(authorize)}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}{t("install_in_slack_4853dca")}</Button>}
    </SetupWizardFooter>
  </div>;
}
