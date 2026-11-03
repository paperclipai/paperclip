import type { ChatEndpoint } from "@/api/chatEndpoints";
import { t } from "@/i18n";
import { isProvisionedSlackSetup } from "@paperclipai/shared";
export { isProvisionedSlackSetup };
export function slackSetupNavigation(method: string | undefined, availableStage = 1) {
  const managed = method === "managed";
  return {
    get labels() { return managed ? [t("chatUi.chatEndpointSetup.chooseAgent"), t("sep13Connections.connect")] : isProvisionedSlackSetup(method)
      ? [t("chatUi.chatEndpointSetup.chooseAgent"), t("oct19Apps.appConfigurationToken"), t("oct19Apps.installSlackApp"), t("stableOct26Apps.sendMessage")]
      : [t("chatUi.chatEndpointSetup.chooseAgent"), t("sep28Apps.copy235"), t("sep28Apps.copy236"), t("sep28Apps.copy237"), t("sep28Apps.copy198"), t("chatUi.chatEndpointSetup.tryIt")]; },
    toVisible: (step: number) => managed ? Math.min(step, 1) : step,
    toStage: (step: number) => managed && step === 1 ? availableStage : step,
  };
}

/** Logical stages stay compatible with existing draft URLs; navigation is derived here. */
export function slackSetupState(input: { endpoint: ChatEndpoint | null; repairing: boolean; credentialsReady: boolean; identityReady: boolean; defaultMethod?: string }) {
  const { endpoint, repairing, credentialsReady, identityReady } = input;
  const method = endpoint ? endpoint.setup?.slackSetupMethod : input.defaultMethod ?? "managed";
  const provisioned = isProvisionedSlackSetup(method);
  const complete = provisioned && (endpoint?.setup?.step === "test" || endpoint?.setup?.step === "complete");
  const finalStage = provisioned ? 3 : 5;
  const availableStage = !endpoint ? 0
    : provisioned && endpoint.setup?.slackRegistration?.status === "configured" && endpoint.setup.slackAccount?.status !== "linked" && endpoint.setup.step !== "complete" ? 2
    : !repairing && (endpoint.setup?.step === "test" || endpoint.setup?.step === "complete")
      ? endpoint.setup.step !== "complete" && !provisioned && !identityReady ? 4 : finalStage
    : provisioned && endpoint.setup?.slackRegistration?.status === "credentials_saved" ? 2
    : endpoint.providerAccountId && !repairing ? 3
    : credentialsReady || repairing || method === "existing" || provisioned && endpoint.setup?.slackRegistration?.appId ? 2 : 1;
  return { ...slackSetupNavigation(method, availableStage), provisioned, complete, finalStage, availableStage };
}
