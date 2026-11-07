import { t, useTranslation } from "@/i18n";
import { InlineBanner } from "@/components/InlineBanner";
import { webhookUrlWarningReason } from "@/lib/webhook-url-warning";

const warnings = {
  loopback: {
    get title() { return t("task-components:otherAppsCanTReachThisLocalhost_a9a1746f"); },
    get message() { return t("task-components:thisAddressPointsBackToTheMachine_a9a81db3"); },
  },
  private: {
    get title() { return t("task-components:thisWebhookUrlAppearsToBePrivate_c5cb1534"); },
    get message() { return t("task-components:onlySendersWithAccessToThisNetwork_c29f7cbd"); },
  },
  tailscale: {
    get title() { return t("task-components:thisTailscaleUrlMayNotBePublic_76597a67"); },
    get message() { return t("task-components:tailscaleServeIsPrivateToYourTailnet_de0c0242"); },
  },
  https: {
    get title() { return t("task-components:useHttpsForWebhooksFromOtherApps_9ca07d2c"); },
    get message() { return t("task-components:thisUrlUsesHttpManyAppsRequire_44225a79"); },
  },
  invalid: {
    get title() { return t("task-components:checkTheWebhookUrl_4b75da52"); },
    get message() { return t("task-components:thisIsNotAValidHttpOr_fbf5cdd3"); },
  },
};

export function WebhookUrlWarning({ url }: { url: string }) {
  useTranslation("task-components");
  const reason = webhookUrlWarningReason(url);
  if (!reason) return null;
  const warning = warnings[reason];
  return <InlineBanner tone="warning" title={warning.title}>
    <div className="space-y-2">
      <p>{warning.message}</p>
      <p>{t("task-components:youCanContinueForLocalOrPrivate_588d3cda")}</p>
      <a className="underline underline-offset-4" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noopener noreferrer">{t("task-components:learnHowToSetUpHttpsAnd_f9d4d69f")}</a>
    </div>
  </InlineBanner>;
}
