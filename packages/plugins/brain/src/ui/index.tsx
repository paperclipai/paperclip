import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

/**
 * Minimal settings page for the Obsidian Brain plugin.
 *
 * MVP scope: explain what the plugin does, point operators to the env vars,
 * and link to the audit log. A richer UI (live status, re-index button,
 * recent calls list) is Phase 2 — once the host exposes plugin-scoped HTTP
 * routes for status/logs.
 */
export function BrainSettingsPage(_props: PluginWidgetProps) {
  return (
    <section aria-label="Obsidian Brain — Settings">
      <h2>Obsidian Brain</h2>
      <p>
        Exposes Walter's Obsidian vault as a semantically searchable knowledge
        base via three agent tools: <code>vault.search</code>,{" "}
        <code>vault.get_note</code>, <code>vault.list_scope</code>.
      </p>
      <h3>Configuration (instance config — one entry per company)</h3>
      <p>
        Set <code>companies</code> in the plugin's instance config to a map
        keyed by Paperclip <code>companyId</code>. Each value contains:
      </p>
      <ul>
        <li>
          <code>mcpEndpoint</code> — Brain MCP server URL for this company
          (e.g. <code>http://localhost:7777</code> for WHITESTAG,{" "}
          <code>http://localhost:7778</code> for Clara Sound)
        </li>
        <li>
          <code>bearerToken</code> — Bearer token from this company's Brain MCP
          launchd plist (<code>BRAIN_PAPERCLIP_TOKEN</code>)
        </li>
        <li>
          <code>agentMap</code> — JSON object mapping this company's agent
          UUIDs to Brain ACL keys (e.g. <code>{`{"<uuid>":"CEO"}`}</code>);
          unmapped agents fall back to their UUID
        </li>
      </ul>
      <p>
        Tool calls are routed by <code>runContext.companyId</code>. A
        <code>defaultCompanyId</code> may be set as fallback.
      </p>
      <h3>Access control</h3>
      <p>
        ACLs live in the <code>brain.agent_acl</code> table of each Brain
        database (e.g. <code>paperclip_brain</code>,{" "}
        <code>paperclip_brain_clara</code>). New agents have no scope by
        default (default-deny). Edit the row to grant folder access.
      </p>
      <h3>Audit</h3>
      <p>
        Every tool call is logged to <code>brain.access_log</code> with agent
        ID, query, returned paths and latency. Query the table directly for
        DSGVO inquiries.
      </p>
    </section>
  );
}
