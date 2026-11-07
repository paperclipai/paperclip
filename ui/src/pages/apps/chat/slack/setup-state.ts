import { t as translate } from "@/i18n";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { isProvisionedSlackSetup } from "@paperclipai/shared";
export { isProvisionedSlackSetup };
export function slackSetupNavigation(method: string | undefined, availableStage = 1) {
  const managed = method === "managed";
  return {
    labels: managed ? [translate("connections:choose_agent_08bb320"), translate("connections:connect_b65463c")] : isProvisionedSlackSetup(method)
      ? [translate("connections:choose_agent_08bb320"), translate("connections:app_configuration_access_token_4c31df4"), translate("connections:install_slack_app_84ec17b"), translate("connections:send_a_message_dc2661e")]
      : [translate("connections:choose_agent_08bb320"), translate("connections:create_slack_app_ecbbce8"), translate("connections:add_credentials_9e15128"), translate("connections:verify_slack_connection_cfb7021"), translate("connections:connect_your_slack_account_6406348"), translate("connections:try_it_7ddd66b")],
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
