import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps, PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS } from "../constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunTurn = {
  kind: "tool_call" | "text" | "tool_result";
  label: string;
  preview: string;
  ts: string;
};

type AgentStatusEntry = {
  runId: string;
  agentId: string;
  agentName: string;
  status: string;
  taskId: string | null;
  taskTitle: string | null;
  elapsedMs: number | null;
  recentTurns: RunTurn[];
  lastActionAt: string | null;
};

type LiveData = {
  agents: AgentStatusEntry[];
  fetchedAt?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number | null): string {
  if (ms === null) return "queued";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function turnIcon(kind: string): string {
  if (kind === "tool_call") return "⚡";
  if (kind === "tool_result") return "↩";
  return "💬";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TurnRow({ turn }: { turn: RunTurn }) {
  return (
    <li style={{ padding: "4px 0", fontSize: 12, borderBottom: "1px solid #1e1e1e" }}>
      <span style={{ marginRight: 6 }}>{turnIcon(turn.kind)}</span>
      <code style={{ color: "#7ec8e3" }}>{turn.label}</code>
      {turn.preview && (
        <span style={{ color: "#999", marginLeft: 8 }}>
          {turn.preview.slice(0, 100)}{turn.preview.length > 100 ? "…" : ""}
        </span>
      )}
    </li>
  );
}

function AgentCard({ entry }: { entry: AgentStatusEntry }) {
  const statusColor = entry.status === "running" ? "#4caf50" : "#888";
  return (
    <div style={{
      border: "1px solid #2a2a2a",
      borderRadius: 6,
      padding: "12px 14px",
      marginBottom: 12,
      background: "#141414",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <strong style={{ fontSize: 14 }}>{entry.agentName}</strong>
          {entry.taskTitle && (
            <span style={{ color: "#aaa", fontSize: 12, marginLeft: 8 }}>→ {entry.taskTitle.slice(0, 60)}</span>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <span style={{ color: statusColor, fontSize: 12, fontWeight: 600 }}>{entry.status}</span>
          {entry.elapsedMs !== null && (
            <span style={{ color: "#666", fontSize: 11, marginLeft: 8 }}>{formatElapsed(entry.elapsedMs)}</span>
          )}
        </div>
      </div>

      {entry.recentTurns.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0 0" }}>
          {entry.recentTurns.map((turn, i) => (
            <TurnRow key={i} turn={turn} />
          ))}
        </ul>
      ) : (
        <p style={{ color: "#666", fontSize: 12, margin: "6px 0 0 0" }}>No activity yet.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget (compact)
// ---------------------------------------------------------------------------

export function AgentActivityWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<LiveData>(DATA_KEYS.LIVE, {
    companyId: context.companyId,
  });

  const running = data?.agents.filter((a) => a.status === "running") ?? [];

  return (
    <section style={{ fontFamily: "inherit", fontSize: 14 }}>
      <strong style={{ fontSize: 15 }}>Agent Activity</strong>
      {loading && <p style={{ color: "#888" }}>Loading…</p>}
      {error && <p style={{ color: "red" }}>Error loading activity.</p>}
      {data && (
        <>
          <div style={{ color: "#555", marginBottom: 8, fontSize: 12 }}>
            {running.length} agent{running.length !== 1 ? "s" : ""} running
            {data.agents.length - running.length > 0
              ? ` · ${data.agents.length - running.length} queued`
              : ""}
          </div>
          {running.slice(0, 3).map((entry) => (
            <AgentCard key={entry.runId} entry={entry} />
          ))}
          {running.length === 0 && (
            <p style={{ color: "#888" }}>No agents running right now.</p>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Full page (/agent-activity)
// ---------------------------------------------------------------------------

export function AgentActivityPage({ context }: PluginPageProps) {
  const { data, loading, error, refresh } = usePluginData<LiveData>(DATA_KEYS.LIVE, {
    companyId: context.companyId,
  });

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px", fontFamily: "inherit" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Agent Activity</h1>
        <button
          onClick={() => refresh?.()}
          style={{ padding: "6px 14px", fontSize: 13, cursor: "pointer", borderRadius: 4, border: "1px solid #333", background: "#1e1e1e", color: "#ccc" }}
        >
          Refresh
        </button>
      </div>

      {loading && <p style={{ color: "#888" }}>Loading…</p>}
      {error && <p style={{ color: "red" }}>Failed to load activity. Check plugin health.</p>}

      {data && (
        <>
          <div style={{ color: "#666", marginBottom: 16, fontSize: 13 }}>
            <strong style={{ color: "#ccc" }}>{data.agents.length}</strong> run{data.agents.length !== 1 ? "s" : ""} live
            {data.fetchedAt && (
              <span style={{ marginLeft: 8, fontSize: 11, color: "#555" }}>
                (as of {new Date(data.fetchedAt).toLocaleTimeString()})
              </span>
            )}
          </div>

          {data.agents.length > 0 ? (
            data.agents.map((entry) => (
              <AgentCard key={entry.runId} entry={entry} />
            ))
          ) : (
            <p style={{ color: "#888" }}>No active agent runs. All quiet.</p>
          )}
        </>
      )}
    </main>
  );
}
