import React, { useState } from "react";
import {
  usePluginData,
  usePluginAction,
  useHostContext,
} from "@paperclipai/plugin-sdk/ui";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";

interface AgentRow {
  agentId: string;
  botToken: string;
  botUserId: string;
  displayName: string;
}

interface ChannelRow {
  slackChannelId: string;
  channelName: string;
  paperclipProjectId: string;
}

interface SlackConfigData {
  signingSecret?: string;
  appToken?: string;
  defaultAgentId?: string;
  agents?: AgentRow[];
  channelMappings?: ChannelRow[];
}

export function SlackSettingsPage({ context }: PluginSettingsPageProps) {
  const { data: config, loading } = usePluginData<SlackConfigData>("plugin-config");
  const { data: channels } = usePluginData<Array<{ id: string; name: string }>>(
    "channel-list",
  );
  const testTokens = usePluginAction("test-tokens");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  if (loading) {
    return <div style={styles.loading}>Loading Slack configuration…</div>;
  }

  const agents = config?.agents ?? [];
  const mappings = config?.channelMappings ?? [];

  async function handleTestTokens() {
    setTesting(true);
    setTestResult(null);
    try {
      await testTokens({ companyId: context.companyId ?? "" });
      setTestResult("All tokens tested. Check the activity log for results.");
    } catch {
      setTestResult("Token test failed — check activity log.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Slack Plugin Settings</h2>
      <p style={styles.subtitle}>
        Each Paperclip agent has their own Slack bot. Configure the tokens here,
        then map Slack channels to Paperclip projects.
      </p>

      {/* Agent tokens section */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Agent Bot Tokens</h3>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Agent ID</th>
              <th style={styles.th}>Display Name</th>
              <th style={styles.th}>Bot Token (xoxb-…)</th>
              <th style={styles.th}>Bot User ID</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 ? (
              <tr>
                <td colSpan={4} style={styles.empty}>
                  No agents configured. Add entries in the JSON config below.
                </td>
              </tr>
            ) : (
              agents.map((agent, i) => (
                <tr key={i}>
                  <td style={styles.td}><code>{agent.agentId}</code></td>
                  <td style={styles.td}>{agent.displayName || "—"}</td>
                  <td style={styles.td}>
                    <code>{agent.botToken ? `${agent.botToken.slice(0, 16)}…` : "not set"}</code>
                  </td>
                  <td style={styles.td}><code>{agent.botUserId || "—"}</code></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <button
          style={styles.button}
          onClick={handleTestTokens}
          disabled={testing || agents.length === 0}
        >
          {testing ? "Testing…" : "Test All Tokens"}
        </button>
        {testResult && <p style={styles.testResult}>{testResult}</p>}
      </section>

      {/* Channel mappings section */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Channel → Project Mappings</h3>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Slack Channel</th>
              <th style={styles.th}>Paperclip Project ID</th>
            </tr>
          </thead>
          <tbody>
            {mappings.length === 0 ? (
              <tr>
                <td colSpan={2} style={styles.empty}>
                  No channel mappings configured.
                </td>
              </tr>
            ) : (
              mappings.map((m, i) => (
                <tr key={i}>
                  <td style={styles.td}>
                    <code>{m.channelName ? `#${m.channelName}` : m.slackChannelId}</code>
                  </td>
                  <td style={styles.td}><code>{m.paperclipProjectId}</code></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {channels && channels.length > 0 && (
          <p style={styles.hint}>
            Available channels: {channels.map((c) => `#${c.name}`).join(", ")}
          </p>
        )}
      </section>

      {/* Config info */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Connection Details</h3>
        <dl style={styles.dl}>
          <dt style={styles.dt}>Signing Secret</dt>
          <dd style={styles.dd}>{config?.signingSecret ? "✅ Configured" : "⚠️ Not set (insecure)"}</dd>
          <dt style={styles.dt}>Socket Mode (App Token)</dt>
          <dd style={styles.dd}>{config?.appToken ? "✅ Enabled (dev mode)" : "—  Using Events API webhook"}</dd>
          <dt style={styles.dt}>Default Agent</dt>
          <dd style={styles.dd}><code>{config?.defaultAgentId ?? "not set"}</code></dd>
        </dl>
      </section>

      <p style={styles.hint}>
        To update configuration, use the JSON config editor in the plugin admin panel.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal inline styles (no external CSS dependency)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: { padding: "24px", maxWidth: "900px", fontFamily: "system-ui, sans-serif" },
  loading: { padding: "24px", color: "#666" },
  title: { margin: "0 0 8px", fontSize: "20px", fontWeight: 600 },
  subtitle: { margin: "0 0 24px", color: "#555", fontSize: "14px" },
  section: { marginBottom: "32px" },
  sectionTitle: { fontSize: "15px", fontWeight: 600, margin: "0 0 12px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
  th: { textAlign: "left", padding: "8px 12px", background: "#f5f5f5", borderBottom: "1px solid #ddd", fontWeight: 600 },
  td: { padding: "8px 12px", borderBottom: "1px solid #eee" },
  empty: { padding: "12px", color: "#999", textAlign: "center" },
  button: { marginTop: "12px", padding: "8px 16px", cursor: "pointer", borderRadius: "6px", border: "1px solid #ccc", background: "#fff", fontSize: "13px" },
  testResult: { marginTop: "8px", fontSize: "13px", color: "#444" },
  dl: { display: "grid", gridTemplateColumns: "200px 1fr", gap: "8px 0", fontSize: "13px" },
  dt: { fontWeight: 600, color: "#555", paddingRight: "12px" },
  dd: { margin: 0 },
  hint: { fontSize: "12px", color: "#888", marginTop: "8px" },
};
