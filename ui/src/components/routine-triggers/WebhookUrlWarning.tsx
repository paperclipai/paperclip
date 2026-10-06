import { t, useTranslation } from "@/i18n";
import { InlineBanner } from "@/components/InlineBanner";
import { webhookUrlWarningReason } from "@/lib/webhook-url-warning";

function localizedWarnings() {
  return {
  loopback: {
    title: t("sep28Routines.loopbackTitle"),
    message: t("sep28Routines.loopbackMessage"),
  },
  private: {
    title: t("sep28Routines.privateTitle"),
    message: t("sep28Routines.privateMessage"),
  },
  tailscale: {
    title: t("sep28Routines.tailscaleTitle"),
    message: t("sep28Routines.tailscaleMessage"),
  },
  https: {
    title: t("sep28Routines.httpsTitle"),
    message: t("sep28Routines.httpsMessage"),
  },
  invalid: {
    title: t("sep28Routines.invalidTitle"),
    message: t("sep28Routines.invalidMessage"),
  },
  };
}

export function WebhookUrlWarning({ url }: { url: string }) {
  useTranslation();
  const reason = webhookUrlWarningReason(url);
  if (!reason) return null;
  const warning = localizedWarnings()[reason];
  return <InlineBanner tone="warning" title={warning.title}>
    <div className="space-y-2">
      <p>{warning.message}</p>
      <p>{t("sep28Routines.warningContinue")}</p>
      <a className="underline underline-offset-4" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noopener noreferrer">{t("sep28Routines.publicAccessHelp")}</a>
    </div>
  </InlineBanner>;
}
