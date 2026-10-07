import { PUBLIC_MCP_SCOPES } from "./public-mcp.js";

export type AssistantClient = "codex" | "claude" | "opencode" | "browser" | "headless" | "other";
export const assistantClientNames: Record<AssistantClient, string> = {
  codex: "Codex", claude: "Claude Code", opencode: "OpenCode", browser: "ChatGPT / Claude web", headless: "Headless", other: "Other",
};
export function mcpSetupUrl(serverUrl: string, companyId?: string) {
  const url = new URL("/mcp/setup", serverUrl);
  if (companyId) url.searchParams.set("company", companyId);
  return url.toString();
}
export function mcpInvitation(serverUrl: string, company?: { id: string; name: string }) {
  return `Connect to my ${company ? `${company.name} ` : ""}Paperclip organization using the instructions at ${mcpSetupUrl(serverUrl, company?.id)}. Start authorization, give me the approval link, and verify the connection after I approve. This connects as me, not as a Paperclip agent.`;
}
export function mcpSetupSteps(serverUrl: string, assistant: AssistantClient) {
  const quoted = `'${serverUrl.replaceAll("'", "'\"'\"'")}'`;
  const scopes = PUBLIC_MCP_SCOPES.join(" ");
  switch (assistant) {
    case "codex": return [
      { text: "Check for an existing Paperclip server first. Reuse it only if its URL matches this instance. Add the remote server with the Codex CLI.", code: `codex mcp add paperclip --url ${quoted}` },
      { text: "Start browser authorization and give the user the approval link.", code: "codex mcp login paperclip --scopes paperclip:read,paperclip:write,paperclip:configure,offline_access" },
      { text: "If the current conversation does not reload its MCP tools, start a new conversation or restart the client. Verify the connection with paperclip_connection before claiming success." },
    ];
    case "claude": return [
      { text: "Check existing servers and reuse a matching instance. Add the remote server using Claude Code.", code: `claude mcp add --transport http paperclip ${quoted}` },
      { text: "In Claude Code, run /mcp, select paperclip, and choose Authenticate. Versions that offer `claude mcp login --help` can also start authorization with `claude mcp login paperclip`. Give the user the approval link." },
      { text: "Reconnect through /mcp, or start a new session if needed. Verify the account and organization with paperclip_connection." },
    ];
    case "opencode": return [
      { text: "Check `opencode --version` and existing configuration. For OpenCode 1.x, merge this entry into opencode.json without replacing other settings. OpenCode 2.x uses mcp.servers; use that version's documented format instead.", code: JSON.stringify({ mcp: { paperclip: { type: "remote", url: serverUrl, enabled: true, oauth: { scope: scopes } } } }, null, 2) },
      { text: "Run from the same project directory. OpenCode opens Paperclip's sign-in and consent page; give the user the approval link.", code: "opencode mcp auth paperclip" },
      { text: "If OpenCode was already running, restart it to load the connection. For the browser app, use this command. Verify the tools with paperclip_connection.", code: "opencode web" },
    ];
    case "browser": return [
      { text: "Open your assistant's Apps / Connectors settings and add a custom remote MCP connection using this URL. Availability depends on the account and workspace policy. Reading this page in chat does not install a connector.", code: serverUrl },
      { text: "Choose OAuth / browser sign-in. Approve the connection in Paperclip, then select the connector in your conversation. If custom connectors are unavailable, use a supported local client. Verify the connected account and organization before doing work." },
    ];
    case "headless": return [
      { text: "Use a Paperclip CLI version with `mcp login --device` support. This needs no callback listener; it prints a verification URL and user code, then waits for human approval.", code: `paperclipai mcp login --device --url ${quoted}` },
      { text: "After approval, configure a local stdio MCP server running the command below. Credentials stay in the CLI's private credential store. Do not copy tokens or device codes into chat or project configuration.", code: `paperclipai mcp proxy --url ${quoted}` },
      { text: "The user code is for the human to verify the request. The private device code remains inside the CLI. After connecting, call paperclip_connection to verify the account and organization." },
    ];
    default: return [
      { text: "Add a remote HTTP MCP server at this URL, then choose OAuth / browser sign-in.", code: serverUrl },
      { text: "If the client cannot install MCP servers from chat, use its connection settings. If it cannot receive a browser callback, use the Headless instructions. After approval, verify the account and organization with paperclip_connection." },
    ];
  }
}

export const mcpAuthorizationHandoffInstructions = "Authorization commands wait for human approval. When using an assistant shell tool, keep the command running in a persistent terminal or background process, capture its output privately, and share the approval URL immediately while it is still running. Client callback deadlines still apply. If the command timed out or stopped, start a fresh authorization request before sharing a link. If the host cannot keep the command alive across turns, ask the user to run it in their own terminal.";

export function mcpSetupMarkdown(serverUrl: string, companyId?: string) {
  return ["# Connect your assistant to Paperclip", "",
    "These are setup instructions, not an access credential. Ask the human to approve the identified client in Paperclip. Never approve on their behalf or reuse browser cookies as MCP credentials.", "",
    `MCP server: ${serverUrl}`, ...(companyId ? [`Requested organization ID: ${companyId} (a hint, not authority).`] : []), "",
    "Keep existing client settings. If the name paperclip already points elsewhere, use a distinct server name and the same name in the login command. Stop and explain if the host cannot configure MCP. A restart or new conversation may be required; do not claim tools are available until a real call succeeds.", "",
    mcpAuthorizationHandoffInstructions, "",
    ...Object.entries(assistantClientNames).flatMap(([client, name]) => [`## ${name}`, "", ...mcpSetupSteps(serverUrl, client as AssistantClient).flatMap((step) => [step.text, ...(step.code ? ["", "```", step.code, "```"] : []), ""])]),
    "## After approval", "",
    "Call paperclip_connection, verify the human and organization, then summarize agents and open tasks. If the approved organization differs from the requested one, stop and reconnect. Do not create tasks or comments merely to test a connection. Creating tasks or comments can start paid agent work; do that only when requested. Access is governed by the consenting human's permissions, not a selected agent's identity.", "",
  ].join("\n");
}
