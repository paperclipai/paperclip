import { t as translate } from "@/i18n";
/** Presentation metadata only. Each provider will have its own catalog entry and connection. */
export type RemoteMcpProviderId = "zapier" | "arcade" | "composio" | "executor";

export interface RemoteMcpProvider {
  id: RemoteMcpProviderId;
  name: string;
  description: string;
  instructions: string[];
  setupUrl: string;
  dashboardUrl: string;
  defaultUrl: string;
  placeholder: string;
  urlHelp: string;
  authHelp: string;
  supportsBrowserAuth: boolean;
}

export const remoteMcpProviders: Record<RemoteMcpProviderId, RemoteMcpProvider> = {
  zapier: {
    id: "zapier", name: "Zapier", supportsBrowserAuth: false,
    get description() { return translate("connections:use_the_apps_and_actions_on_your_08ab9ee"); },
    get instructions() { return [translate("connections:create_an_mcp_server_in_zapier_and_e216727"), translate("connections:connect_your_apps_and_select_the_actions_291985a"), translate("connections:open_connect_generate_a_token_and_copy_910f4b3")]; },
    setupUrl: "https://docs.zapier.com/mcp/get-started/connect/other",
    dashboardUrl: "https://mcp.zapier.com",
    defaultUrl: "", get placeholder() { return translate("connections:paste_the_full_url_from_zapier_31af291"); },
    get urlHelp() { return translate("connections:the_full_server_url_can_contain_a_f848673"); },
    get authHelp() { return translate("connections:for_a_separate_token_use_https_mcp_c9db30d"); },
  },
  arcade: {
    id: "arcade", name: "Arcade", supportsBrowserAuth: true,
    get description() { return translate("connections:use_the_tools_exposed_by_your_arcade_c1928a0"); },
    get instructions() { return [translate("connections:create_a_gateway_in_arcade_and_select_709415d"), translate("connections:choose_its_user_source_and_copy_the_d6699c6"), translate("connections:paste_the_url_here_then_sign_in_d3e4fc0")]; },
    setupUrl: "https://docs.arcade.dev/en/operate/governance/mcp-gateways",
    dashboardUrl: "https://app.arcade.dev",
    defaultUrl: "", placeholder: "https://api.arcade.dev/mcp/your-gateway",
    get urlHelp() { return translate("connections:copy_the_mcp_gateway_url_from_arcade_b33644c"); },
    get authHelp() { return translate("connections:for_arcade_headers_use_an_api_key_4f8555d"); },
  },
  composio: {
    id: "composio", name: "Composio", supportsBrowserAuth: true,
    get description() { return translate("connections:discover_and_use_your_apps_through_composio_2c06d3d"); },
    get instructions() { return [translate("connections:connect_to_composio_and_sign_in_with_481e66c"), translate("connections:connect_underlying_apps_in_composio_when_prompted_9957cf2")]; },
    setupUrl: "https://docs.composio.dev/docs/composio-connect",
    dashboardUrl: "https://dashboard.composio.dev",
    defaultUrl: "https://connect.composio.dev/mcp", placeholder: "https://connect.composio.dev/mcp",
    get urlHelp() { return translate("connections:paste_the_mcp_url_from_your_existing_ccf2c79"); },
    get authHelp() { return translate("connections:session_urls_and_headers_come_from_your_ad11216"); },
  },
  executor: {
    id: "executor", name: "Executor", supportsBrowserAuth: true,
    get description() { return translate("connections:run_tools_through_your_executor_workspace_37fea6e"); },
    get instructions() { return [translate("connections:connect_your_apps_and_configure_action_policies_4b7cc50"), translate("connections:open_integrations_and_copy_the_url_under_f83b5c5"), translate("connections:paste_it_here_and_sign_in_when_b80d1be")]; },
    setupUrl: "https://executor.sh/docs/mcp-proxy",
    dashboardUrl: "https://executor.sh",
    defaultUrl: "", get placeholder() { return translate("connections:paste_your_executor_workspace_mcp_url_d049ede"); },
    get urlHelp() { return translate("connections:use_the_hosted_workspace_url_or_a_27bfd57"); },
    get authHelp() { return translate("connections:keep_any_options_in_the_copied_url_fab4c87"); },
  },
};
