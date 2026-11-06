import { useTranslation } from "@/i18n";
import { InlineBanner } from "@/components/InlineBanner";
import { webhookUrlWarningReason } from "@/lib/webhook-url-warning";

export function WebhookUrlWarning({ url }: { url: string }) {
  const { t } = useTranslation();
  const reason = webhookUrlWarningReason(url);
  if (!reason) return null;
  const warnings = {
    loopback: {
      title: t("routines.WebhookUrlWarning.loopbackTitle"),
      message: t("routines.WebhookUrlWarning.loopbackMessage"),
    },
    private: {
      title: t("routines.WebhookUrlWarning.privateTitle"),
      message: t("routines.WebhookUrlWarning.privateMessage"),
    },
    tailscale: {
      title: t("routines.WebhookUrlWarning.tailscaleTitle"),
      message: t("routines.WebhookUrlWarning.tailscaleMessage"),
    },
    https: {
      title: t("routines.WebhookUrlWarning.httpsTitle"),
      message: t("routines.WebhookUrlWarning.httpsMessage"),
    },
    invalid: {
      title: t("routines.WebhookUrlWarning.invalidTitle"),
      message: t("routines.WebhookUrlWarning.invalidMessage"),
    },
  };
  const warning = warnings[reason];
  return <InlineBanner tone="warning" title={warning.title}>
    <div className="space-y-2">
      <p>{warning.message}</p>
      <p>{t("routines.WebhookUrlWarning.localUseNote")}</p>
      <a className="underline underline-offset-4" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noopener noreferrer">{t("routines.WebhookUrlWarning.learnHttpsLink")}</a>
    </div>
  </InlineBanner>;
}
