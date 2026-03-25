import React, { useState, useEffect } from "react";
import {
  usePluginData,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";

interface AgentRow {
  agentId: string;
  botToken: string;
  botUserId?: string;
  displayName?: string;
  signingSecret?: string;
}

interface ChannelRow {
  slackChannelId: string;
  channelName?: string;
  paperclipProjectId: string;
}

interface SlackConfigData {
  signingSecret?: string;
  appToken?: string;
  defaultAgentId?: string;
  agents?: AgentRow[];
  channelMappings?: ChannelRow[];
  pluginId?: string;
}

interface TokenTestResult {
  name: string;
  ok: boolean;
  userId?: string;
  error?: string;
}

interface Channel {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  prefix?: string;
}

export function SlackSettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId ?? "";

  const { data: config, loading, refresh: refreshConfig } = usePluginData<SlackConfigData>("plugin-config");
  const { data: channels } = usePluginData<Channel[]>("channel-list");
  const { data: projects } = usePluginData<Project[]>("projects-list", { companyId });
  const testTokensAction = usePluginAction("test-tokens");
  const toast = usePluginToast();

  // Local state for editable channel mappings
  const [mappings, setMappings] = useState<ChannelRow[]>([]);
  const [newChannelId, setNewChannelId] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tokenResults, setTokenResults] = useState<TokenTestResult[] | null>(null);

  // Sync local mappings from fetched config
  useEffect(() => {
    if (config?.channelMappings) {
      setMappings(config.channelMappings);
    }
  }, [config]);

  if (loading) {
    return <div style={s.loading}>Loading Slack configuration…</div>;
  }

  const agents = config?.agents ?? [];
  const pluginId = config?.pluginId ?? "";
  const availableChannels = channels ?? [];
  const availableProjects = projects ?? [];

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function handleSave() {
    if (!pluginId) {
      toast({ title: "Cannot save", body: "Plugin ID not available — is the worker running?", tone: "error" });
      return;
    }
    setSaving(true);
    try {
      const configJson: SlackConfigData = {
        signingSecret: config?.signingSecret,
        appToken: config?.appToken,
        defaultAgentId: config?.defaultAgentId,
        agents: config?.agents,
        channelMappings: mappings,
      };
      const res = await fetch(`/api/plugins/${pluginId}/config`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configJson }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
      }
      toast({ title: "Saved", body: "Channel mappings updated", tone: "success" });
      refreshConfig();
    } catch (err) {
      toast({ title: "Save failed", body: String(err), tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestTokens() {
    setTesting(true);
    setTokenResults(null);
    try {
      const results = await testTokensAction() as TokenTestResult[];
      setTokenResults(results);
    } catch (err) {
      toast({ title: "Token test failed", body: String(err), tone: "error" });
    } finally {
      setTesting(false);
    }
  }

  function handleAddMapping() {
    if (!newChannelId || !newProjectId) return;
    const channel = availableChannels.find((c) => c.id === newChannelId);
    setMappings((prev) => [
      ...prev,
      {
        slackChannelId: newChannelId,
        channelName: channel?.name ?? newChannelName,
        paperclipProjectId: newProjectId,
      },
    ]);
    setNewChannelId("");
    setNewChannelName("");
    setNewProjectId("");
  }

  function handleDeleteMapping(index: number) {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  }

  function handleChannelSelect(channelId: string) {
    setNewChannelId(channelId);
    const ch = availableChannels.find((c) => c.id === channelId);
    if (ch) setNewChannelName(ch.name);
  }

  const canAdd = newChannelId !== "" && newProjectId !== "";
  const projectName = (id: string) =>
    availableProjects.find((p) => p.id === id)?.name ?? id;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={s.container}>
      <h2 style={s.title}>Slack Plugin Settings</h2>
      <p style={s.subtitle}>
        Configure Slack bot tokens and map channels to Paperclip projects.
      </p>

      {/* ── Agent Bot Tokens ── */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Agent Bot Tokens</h3>
        {agents.length === 0 ? (
          <p style={s.empty}>
            No agents configured. Edit the plugin config JSON to add bot tokens.
          </p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Display Name</th>
                <th style={s.th}>Agent ID</th>
                <th style={s.th}>Token</th>
                <th style={s.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent, i) => {
                const result = tokenResults?.find(
                  (r) => r.name === (agent.displayName ?? agent.agentId),
                );
                return (
                  <tr key={i}>
                    <td style={s.td}>{agent.displayName ?? "—"}</td>
                    <td style={s.td}><code>{agent.agentId}</code></td>
                    <td style={s.td}>
                      <code style={s.tokenCell}>
                        {agent.botToken ? `${agent.botToken.slice(0, 14)}…` : "not set"}
                      </code>
                    </td>
                    <td style={s.td}>
                      {result ? (
                        result.ok ? (
                          <span style={s.ok}>✓ {result.userId}</span>
                        ) : (
                          <span style={s.err}>✗ {result.error}</span>
                        )
                      ) : (
                        <span style={s.neutral}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={s.row}>
          <button
            style={s.btn}
            onClick={handleTestTokens}
            disabled={testing || agents.length === 0}
          >
            {testing ? "Testing…" : "Test All Tokens"}
          </button>
          {tokenResults && (
            <span style={s.testSummary}>
              {tokenResults.filter((r) => r.ok).length}/{tokenResults.length} healthy
            </span>
          )}
        </div>
      </section>

      {/* ── Channel → Project Mappings ── */}
      <section style={s.section}>
        <div style={s.sectionHeader}>
          <h3 style={s.sectionTitle}>Channel → Project Mappings</h3>
          <button
            style={{ ...s.btn, ...s.btnPrimary }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Mappings"}
          </button>
        </div>

        {/* Existing mappings */}
        {mappings.length === 0 ? (
          <p style={s.empty}>No channel mappings yet. Add one below.</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Slack Channel</th>
                <th style={s.th}>Paperclip Project</th>
                <th style={s.th}></th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m, i) => (
                <tr key={i}>
                  <td style={s.td}>
                    #{m.channelName ?? m.slackChannelId}
                    <span style={s.muted}> ({m.slackChannelId})</span>
                  </td>
                  <td style={s.td}>
                    {projectName(m.paperclipProjectId)}
                    <span style={s.muted}> ({m.paperclipProjectId.slice(0, 8)}…)</span>
                  </td>
                  <td style={{ ...s.td, ...s.deleteTd }}>
                    <button
                      style={s.deleteBtn}
                      onClick={() => handleDeleteMapping(i)}
                      title="Remove mapping"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Add new mapping row */}
        <div style={s.addRow}>
          <select
            style={s.select}
            value={newChannelId}
            onChange={(e) => handleChannelSelect(e.target.value)}
          >
            <option value="">Select Slack channel…</option>
            {availableChannels.length > 0 ? (
              availableChannels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  #{ch.name}
                </option>
              ))
            ) : (
              <option disabled>No channels loaded</option>
            )}
          </select>

          <select
            style={s.select}
            value={newProjectId}
            onChange={(e) => setNewProjectId(e.target.value)}
          >
            <option value="">Select Paperclip project…</option>
            {availableProjects.length > 0 ? (
              availableProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))
            ) : (
              <option disabled>No projects loaded</option>
            )}
          </select>

          <button
            style={{ ...s.btn, ...(canAdd ? s.btnPrimary : {}) }}
            onClick={handleAddMapping}
            disabled={!canAdd}
          >
            Add
          </button>
        </div>

        {availableChannels.length === 0 && (
          <p style={s.hint}>
            No channels loaded — make sure a bot token is configured and the worker is running.
          </p>
        )}
      </section>

      {/* ── Connection Details ── */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Connection Details</h3>
        <dl style={s.dl}>
          <dt style={s.dt}>Signing Secret</dt>
          <dd style={s.dd}>{config?.signingSecret ? "✓ Configured" : "⚠ Not set (insecure)"}</dd>
          <dt style={s.dt}>Socket Mode</dt>
          <dd style={s.dd}>{config?.appToken ? "✓ Enabled (xapp- token set)" : "— Events API webhook mode"}</dd>
          <dt style={s.dt}>Default Agent</dt>
          <dd style={s.dd}><code>{config?.defaultAgentId ?? "not set"}</code></dd>
        </dl>
        <p style={s.hint}>
          To change tokens, signing secrets, or the default agent, edit the plugin JSON config directly.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  container: { padding: "24px", maxWidth: "900px", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" },
  loading: { padding: "24px", color: "#888" },
  title: { margin: "0 0 6px", fontSize: "20px", fontWeight: 600 },
  subtitle: { margin: "0 0 28px", color: "#666", fontSize: "14px" },
  section: { marginBottom: "36px" },
  sectionHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" },
  sectionTitle: { fontSize: "14px", fontWeight: 600, margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "#555" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "13px", marginBottom: "12px" },
  th: { textAlign: "left", padding: "8px 12px", background: "#f7f7f7", borderBottom: "2px solid #e5e5e5", fontWeight: 600, fontSize: "12px", color: "#555" },
  td: { padding: "8px 12px", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" },
  deleteTd: { textAlign: "right", width: "40px" },
  tokenCell: { fontFamily: "monospace", fontSize: "12px", color: "#666" },
  muted: { color: "#aaa", fontSize: "11px" },
  empty: { padding: "16px", color: "#aaa", fontSize: "13px", background: "#fafafa", borderRadius: "6px", margin: "0 0 12px" },
  row: { display: "flex", alignItems: "center", gap: "12px" },
  addRow: { display: "flex", gap: "8px", alignItems: "center", marginTop: "12px" },
  select: { flex: 1, padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", background: "#fff", cursor: "pointer" },
  btn: { padding: "7px 14px", border: "1px solid #ddd", borderRadius: "6px", background: "#fff", cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap" as const, flexShrink: 0 },
  btnPrimary: { background: "#0f172a", color: "#fff", border: "1px solid #0f172a" },
  deleteBtn: { background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "18px", padding: "0 4px", lineHeight: 1 },
  ok: { color: "#16a34a", fontSize: "12px" },
  err: { color: "#dc2626", fontSize: "12px" },
  neutral: { color: "#aaa", fontSize: "12px" },
  testSummary: { fontSize: "13px", color: "#555" },
  dl: { display: "grid", gridTemplateColumns: "180px 1fr", gap: "10px 0", fontSize: "13px", marginBottom: "12px" },
  dt: { fontWeight: 600, color: "#555" },
  dd: { margin: 0, color: "#333" },
  hint: { fontSize: "12px", color: "#aaa", margin: "0" },
};
