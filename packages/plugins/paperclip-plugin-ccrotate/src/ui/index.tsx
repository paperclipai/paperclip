import { useEffect, useState, type CSSProperties } from "react";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID } from "../manifest.js";

// ─── Types (mirror worker.ts) ────────────────────────────────────────────────

type Target = "claude" | "codex";

interface AccountRow {
  email: string;
  target: Target;
  tier: string;
  utilization5h: number | null;
  utilization7d: number | null;
  availability: string;
  isActive: boolean;
  isHealthy: boolean;
}

interface SnapshotResponse {
  fetchedAt: string;
  cacheAge: string | null;
  targets: Record<Target, { error?: string; accounts?: AccountRow[] }>;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const wrap: CSSProperties = { padding: "16px", fontSize: "13px" };

const headerRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "16px",
  gap: "12px",
};

const h1: CSSProperties = { fontSize: "18px", fontWeight: 600, margin: 0 };

const meta: CSSProperties = {
  fontSize: "11px",
  color: "var(--muted-foreground, #a1a1aa)",
  display: "flex",
  gap: "12px",
};

const button: CSSProperties = {
  fontSize: "12px",
  fontWeight: 500,
  padding: "6px 12px",
  borderRadius: "6px",
  border: "1px solid var(--border, #27272a)",
  background: "var(--secondary, #27272a)",
  color: "var(--secondary-foreground, #fafafa)",
  cursor: "pointer",
};

const card: CSSProperties = {
  border: "1px solid var(--border, #27272a)",
  borderRadius: "8px",
  background: "var(--card, #09090b)",
  marginBottom: "16px",
  overflow: "hidden",
};

const cardHeader: CSSProperties = {
  padding: "10px 16px",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted-foreground, #a1a1aa)",
  borderBottom: "1px solid var(--border, #27272a)",
  display: "flex",
  justifyContent: "space-between",
  gap: "8px",
};

const tableGrid: CSSProperties = {
  display: "grid",
  // marker · email · tier · 5h · 7d · availability
  gridTemplateColumns: "32px 1fr 90px 70px 70px 1.4fr",
  gap: "0",
};

const cellHeader: CSSProperties = {
  padding: "8px 12px",
  fontSize: "10px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted-foreground, #a1a1aa)",
  background: "var(--muted, #18181b)",
};

const cell: CSSProperties = {
  padding: "10px 12px",
  borderTop: "1px solid var(--border, #27272a)",
  fontSize: "13px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tierBadge = (tier: string): CSSProperties => {
  const t = tier.toLowerCase();
  let bg = "var(--muted, #27272a)";
  let fg = "var(--muted-foreground, #a1a1aa)";
  if (t === "base") {
    bg = "rgba(34, 197, 94, 0.15)";
    fg = "rgb(74, 222, 128)";
  } else if (t === "extra") {
    bg = "rgba(234, 179, 8, 0.15)";
    fg = "rgb(250, 204, 21)";
  } else if (t === "exhausted") {
    bg = "rgba(239, 68, 68, 0.15)";
    fg = "rgb(248, 113, 113)";
  }
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "lowercase",
    background: bg,
    color: fg,
  };
};

const utilColor = (pct: number | null): string => {
  if (pct === null) return "var(--muted-foreground, #a1a1aa)";
  if (pct >= 95) return "rgb(248, 113, 113)";
  if (pct >= 70) return "rgb(250, 204, 21)";
  return "var(--foreground, #fafafa)";
};

const errorBox: CSSProperties = {
  padding: "10px 12px",
  fontSize: "12px",
  color: "rgb(248, 113, 113)",
  background: "rgba(239, 68, 68, 0.08)",
};

// ─── Page ────────────────────────────────────────────────────────────────────

const TARGETS: Target[] = ["claude", "codex"];
const TARGET_LABEL: Record<Target, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

interface FetchState {
  loading: boolean;
  error: string | null;
  data: SnapshotResponse | null;
}

export function CcrotatePoolsPage(_props: PluginSettingsPageProps) {
  const [state, setState] = useState<FetchState>({ loading: true, error: null, data: null });

  async function load() {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/plugins/${PLUGIN_ID}/api/snapshot`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SnapshotResponse;
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({
        loading: false,
        error: err instanceof Error ? err.message : "fetch failed",
        data: null,
      });
    }
  }

  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div style={wrap}>
      <div style={headerRow}>
        <div>
          <h1 style={h1}>ccrotate accounts</h1>
          <div style={meta}>
            {state.data ? (
              <>
                <span>fetched {new Date(state.data.fetchedAt).toLocaleTimeString()}</span>
                {state.data.cacheAge && <span>cache: {state.data.cacheAge}</span>}
              </>
            ) : null}
          </div>
        </div>
        <button style={button} disabled={state.loading} onClick={load}>
          {state.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {state.error && (
        <div style={{ ...card, ...errorBox, marginBottom: "16px" }}>
          Failed to load snapshot: {state.error}
        </div>
      )}

      {state.data &&
        TARGETS.map((target) => (
          <TargetCard key={target} target={target} payload={state.data!.targets[target]} />
        ))}
    </div>
  );
}

interface TargetCardProps {
  target: Target;
  payload: { error?: string; accounts?: AccountRow[] };
}

function TargetCard({ target, payload }: TargetCardProps) {
  const accounts = payload.accounts ?? [];
  return (
    <div style={card}>
      <div style={cardHeader}>
        <span>{TARGET_LABEL[target]}</span>
        <span>
          {accounts.length} account{accounts.length === 1 ? "" : "s"}
          {payload.error ? " · error" : ""}
        </span>
      </div>
      {payload.error ? (
        <div style={errorBox}>{payload.error}</div>
      ) : accounts.length === 0 ? (
        <div style={{ ...cell, color: "var(--muted-foreground, #a1a1aa)", borderTop: "none" }}>
          No accounts. Run <code>ccrotate snap</code> + <code>ccrotate export</code> on a host
          with a fresh login, then PUT /state to publish.
        </div>
      ) : (
        <div style={tableGrid}>
          <div style={cellHeader} aria-label="Active marker"></div>
          <div style={cellHeader}>Email</div>
          <div style={cellHeader}>Tier</div>
          <div style={cellHeader}>5h</div>
          <div style={cellHeader}>7d</div>
          <div style={cellHeader}>Availability</div>
          {accounts.map((a) => (
            <AccountRowCells key={`${target}:${a.email}`} row={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRowCells({ row }: { row: AccountRow }) {
  const dim = !row.isHealthy ? { opacity: 0.55 } : {};
  const marker = row.isActive ? "★" : row.isHealthy ? "✓" : "✗";
  const markerColor = row.isActive
    ? "rgb(250, 204, 21)"
    : row.isHealthy
      ? "rgb(74, 222, 128)"
      : "rgb(248, 113, 113)";
  return (
    <>
      <div style={{ ...cell, ...dim, color: markerColor, fontWeight: 700, textAlign: "center" }}>
        {marker}
      </div>
      <div style={{ ...cell, ...dim, fontFamily: "var(--font-mono, monospace)" }}>{row.email}</div>
      <div style={{ ...cell, ...dim }}>
        <span style={tierBadge(row.tier)}>{row.tier}</span>
      </div>
      <div style={{ ...cell, ...dim, color: utilColor(row.utilization5h) }}>
        {row.utilization5h === null ? "—" : `${row.utilization5h}%`}
      </div>
      <div style={{ ...cell, ...dim, color: utilColor(row.utilization7d) }}>
        {row.utilization7d === null ? "—" : `${row.utilization7d}%`}
      </div>
      <div style={{ ...cell, ...dim, color: "var(--muted-foreground, #a1a1aa)" }}>
        {row.availability}
      </div>
    </>
  );
}

export default CcrotatePoolsPage;
