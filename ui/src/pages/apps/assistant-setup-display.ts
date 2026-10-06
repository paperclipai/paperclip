import { t } from "@/i18n";

// Display-only projection. Shared setup prompts and copied commands stay canonical.
const setupCopy: Record<string, string> = {
  "Check for an existing Paperclip server first. Reuse it only if its URL matches this instance. Add the remote server with the Codex CLI.": "oct6Beta.mcpStepCodex1",
  "Start browser authorization and give the user the approval link.": "oct6Beta.mcpStepCodex2",
  "If the current conversation does not reload its MCP tools, start a new conversation or restart the client. Verify the connection with paperclip_connection before claiming success.": "oct6Beta.mcpStepCodex3",
  "Check existing servers and reuse a matching instance. Add the remote server using Claude Code.": "oct6Beta.mcpStepClaude1",
  "In Claude Code, run /mcp, select paperclip, and choose Authenticate. Versions that offer `claude mcp login --help` can also start authorization with `claude mcp login paperclip`. Give the user the approval link.": "oct6Beta.mcpStepClaude2",
  "Reconnect through /mcp, or start a new session if needed. Verify the account and organization with paperclip_connection.": "oct6Beta.mcpStepClaude3",
  "Check `opencode --version` and existing configuration. For OpenCode 1.x, merge this entry into opencode.json without replacing other settings. OpenCode 2.x uses mcp.servers; use that version's documented format instead.": "oct6Beta.mcpStepOpenCode1",
  "Run from the same project directory. OpenCode opens Paperclip's sign-in and consent page; give the user the approval link.": "oct6Beta.mcpStepOpenCode2",
  "If OpenCode was already running, restart it to load the connection. For the browser app, use this command. Verify the tools with paperclip_connection.": "oct6Beta.mcpStepOpenCode3",
  "Open your assistant's Apps / Connectors settings and add a custom remote MCP connection using this URL. Availability depends on the account and workspace policy. Reading this page in chat does not install a connector.": "oct6Beta.mcpStepBrowser1",
  "Choose OAuth / browser sign-in. Approve the connection in Paperclip, then select the connector in your conversation. If custom connectors are unavailable, use a supported local client. Verify the connected account and organization before doing work.": "oct6Beta.mcpStepBrowser2",
  "Use a Paperclip CLI version with `mcp login --device` support. This needs no callback listener; it prints a verification URL and user code, then waits for human approval.": "oct6Beta.mcpStepHeadless1",
  "After approval, configure a local stdio MCP server running the command below. Credentials stay in the CLI's private credential store. Do not copy tokens or device codes into chat or project configuration.": "oct6Beta.mcpStepHeadless2",
  "The user code is for the human to verify the request. The private device code remains inside the CLI. After connecting, call paperclip_connection to verify the account and organization.": "oct6Beta.mcpStepHeadless3",
  "Add a remote HTTP MCP server at this URL, then choose OAuth / browser sign-in.": "oct6Beta.mcpStepOther1",
  "If the client cannot install MCP servers from chat, use its connection settings. If it cannot receive a browser callback, use the Headless instructions. After approval, verify the account and organization with paperclip_connection.": "oct6Beta.mcpStepOther2",
  "Authorization commands wait for human approval. When using an assistant shell tool, keep the command running in a persistent terminal or background process, capture its output privately, and share the approval URL immediately while it is still running. Client callback deadlines still apply. If the command timed out or stopped, start a fresh authorization request before sharing a link. If the host cannot keep the command alive across turns, ask the user to run it in their own terminal.": "oct6Beta.mcpHandoff"
};

export function assistantSetupDisplayText(source: string): string {
  const key = Object.hasOwn(setupCopy, source) ? setupCopy[source] : undefined;
  return key ? t(key) : source;
}
