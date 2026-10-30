import { assistantClientNames, mcpAuthorizationHandoffInstructions, mcpSetupMarkdown, mcpSetupSteps, type AssistantClient } from "@paperclipai/shared";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** No organization lookup: a public hint must not disclose private company data. */
export function renderMcpSetup(serverUrl: string, companyId?: string) {
  const markdownUrl = new URL("/mcp/setup.md", serverUrl);
  if (companyId) markdownUrl.searchParams.set("company", companyId);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your assistant to Paperclip</title></head><body><main>
<h1>Connect your assistant to Paperclip</h1>
<p>Follow the setup instructions for your assistant, then approve its access in Paperclip.</p>
<p>This link gives instructions, not access. Your assistant connects as you, not as a Paperclip agent.</p>
<p><a href="${escapeHtml(markdownUrl.toString())}">Instructions for assistants (Markdown)</a></p>
<p>${escapeHtml(mcpAuthorizationHandoffInstructions)}</p>
<p>MCP server: <code>${escapeHtml(serverUrl)}</code></p>
${companyId ? `<p>Requested organization ID: <code>${escapeHtml(companyId)}</code>. Verify this organization after approval.</p>` : ""}
${Object.entries(assistantClientNames).map(([id, name]) => `<section><h2>${escapeHtml(name)}</h2><ol>${mcpSetupSteps(serverUrl, id as AssistantClient).map(step => `<li><p>${escapeHtml(step.text)}</p>${step.code ? `<pre><code>${escapeHtml(step.code)}</code></pre>` : ""}</li>`).join("")}</ol></section>`).join("")}
<p>Keep existing client configuration. If a Paperclip entry points to a different instance, use a distinct server name. Verify the connected person and organization before doing work.</p>
</main></body></html>`;
}
export { mcpSetupMarkdown };
