import { t, useTranslation } from "@/i18n";
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
    get description() { return t("sep28Apps.zapierDescription"); },
    get instructions() { return [t("sep28Apps.zapierStep1"), t("sep28Apps.zapierStep2"), t("sep28Apps.zapierStep3")]; },
    setupUrl: "https://docs.zapier.com/mcp/get-started/connect/other",
    dashboardUrl: "https://mcp.zapier.com",
    defaultUrl: "", get placeholder() { return t("sep28Apps.zapierPlaceholder"); },
    get urlHelp() { return t("sep28Apps.zapierUrl"); },
    get authHelp() { return t("sep28Apps.zapierAuth"); },
  },
  arcade: {
    id: "arcade", name: "Arcade", supportsBrowserAuth: true,
    get description() { return t("sep28Apps.arcadeDescription"); },
    get instructions() { return [t("sep28Apps.arcadeStep1"), t("sep28Apps.arcadeStep2"), t("sep28Apps.arcadeStep3")]; },
    setupUrl: "https://docs.arcade.dev/en/operate/governance/mcp-gateways",
    dashboardUrl: "https://app.arcade.dev",
    defaultUrl: "", placeholder: "https://api.arcade.dev/mcp/your-gateway",
    get urlHelp() { return t("sep28Apps.arcadeUrl"); },
    get authHelp() { return t("sep28Apps.arcadeAuth"); },
  },
  composio: {
    id: "composio", name: "Composio", supportsBrowserAuth: true,
    get description() { return t("sep28Apps.composioDescription"); },
    get instructions() { return [t("sep28Apps.composioStep1"), t("sep28Apps.composioStep2")]; },
    setupUrl: "https://docs.composio.dev/docs/composio-connect",
    dashboardUrl: "https://dashboard.composio.dev",
    defaultUrl: "https://connect.composio.dev/mcp", placeholder: "https://connect.composio.dev/mcp",
    get urlHelp() { return t("oct6Beta.copy165"); },
    get authHelp() { return t("sep28Apps.composioAuth"); },
  },
  executor: {
    id: "executor", name: "Executor", supportsBrowserAuth: true,
    get description() { return t("sep28Apps.executorDescription"); },
    get instructions() { return [t("sep28Apps.executorStep1"), t("sep28Apps.executorStep2"), t("sep28Apps.executorStep3")]; },
    setupUrl: "https://executor.sh/docs/mcp-proxy",
    dashboardUrl: "https://executor.sh",
    defaultUrl: "", get placeholder() { return t("sep28Apps.executorPlaceholder"); },
    get urlHelp() { return t("sep28Apps.executorUrl"); },
    get authHelp() { return t("sep28Apps.executorAuth"); },
  },
};
