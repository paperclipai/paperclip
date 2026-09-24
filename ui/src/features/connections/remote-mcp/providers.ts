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
    description: "Use the apps and actions on your Zapier MCP server.",
    instructions: ["Create an MCP server in Zapier and choose Other as the client.", "Connect your apps and select the actions to expose.", "Open Connect, generate a token, and copy the full server URL."],
    setupUrl: "https://docs.zapier.com/mcp/get-started/connect/other",
    dashboardUrl: "https://mcp.zapier.com",
    defaultUrl: "", placeholder: "Paste the full URL from Zapier",
    urlHelp: "The full server URL can contain a secret token. Paste it exactly as Zapier provides it.",
    authHelp: "For a separate token, use https://mcp.zapier.com/api/v1/connect and choose Bearer token.",
  },
  arcade: {
    id: "arcade", name: "Arcade", supportsBrowserAuth: true,
    description: "Use the tools exposed by your Arcade gateway.",
    instructions: ["Create a gateway in Arcade and select its tools.", "Choose its User Source and copy the gateway URL.", "Paste the URL here, then sign in when prompted."],
    setupUrl: "https://docs.arcade.dev/en/operate/governance/mcp-gateways",
    dashboardUrl: "https://app.arcade.dev",
    defaultUrl: "", placeholder: "https://api.arcade.dev/mcp/your-gateway",
    urlHelp: "Copy the MCP gateway URL from Arcade. App authorization may be required the first time you use a tool.",
    authHelp: "For Arcade Headers, use an API key as the bearer token and add the Arcade-User-ID header for the acting user.",
  },
  composio: {
    id: "composio", name: "Composio", supportsBrowserAuth: true,
    description: "Discover and use your apps through Composio Connect.",
    instructions: ["Connect to Composio and sign in with your account.", "Connect underlying apps in Composio when prompted."],
    setupUrl: "https://docs.composio.dev/docs/composio-connect",
    dashboardUrl: "https://dashboard.composio.dev",
    defaultUrl: "https://connect.composio.dev/mcp", placeholder: "https://connect.composio.dev/mcp",
    urlHelp: "Composio Connect is prefilled. For an externally configured session, replace this with its MCP URL and add its supplied headers under Advanced authentication.",
    authHelp: "Session URLs and headers come from your external Composio setup. Direct-tools sessions expose individual actions.",
  },
  executor: {
    id: "executor", name: "Executor", supportsBrowserAuth: true,
    description: "Run tools through your Executor workspace.",
    instructions: ["Connect your apps and configure action policies in Executor.", "Open Integrations and copy the URL under “Connect an agent”.", "Paste it here and sign in when prompted."],
    setupUrl: "https://executor.sh/docs/mcp-proxy",
    dashboardUrl: "https://executor.sh",
    defaultUrl: "", placeholder: "Paste your Executor workspace MCP URL",
    urlHelp: "Use the hosted workspace URL or a self-hosted HTTP endpoint reachable from Paperclip. The server’s endpoint policy also applies.",
    authHelp: "Keep any options in the copied URL. If using an API key, use a user key; workspace and organization keys cannot open an MCP session.",
  },
};
