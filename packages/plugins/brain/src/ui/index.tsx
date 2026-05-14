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
      <h3>Configuration (env vars on the worker)</h3>
      <ul>
        <li>
          <code>BRAIN_MCP_ENDPOINT</code> — Brain MCP server URL (default{" "}
          <code>http://localhost:7777</code>)
        </li>
        <li>
          <code>BRAIN_PAPERCLIP_TOKEN</code> — Bearer token issued by the Brain
          MCP server
        </li>
        <li>
          <code>BRAIN_AGENT_MAP</code> — JSON object mapping Paperclip agent
          UUIDs to ACL keys (e.g. <code>{`{"<uuid>":"CEO"}`}</code>); unmapped
          agents fall back to their UUID
        </li>
      </ul>
      <h3>Access control</h3>
      <p>
        ACLs live in the <code>brain.agent_acl</code> table of the
        <code>paperclip_brain</code> database. New agents have no scope by
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
