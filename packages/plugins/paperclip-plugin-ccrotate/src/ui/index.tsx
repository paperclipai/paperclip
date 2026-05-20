// ccrotate plugin UI — three slots: page, sidebarPanel, settingsPage.
//
// All three components hit the plugin's `apiRoutes` (snapshot, refresh,
// state-get, state-put, import) via plain `fetch("/api/plugins/<id>/<path>")`.
// The host's session cookie provides board-level auth (manifest declares
// `auth: "board"` on each route), so credentials are scoped automatically.
//
// Why one file: ccrotate's UI is small and the three components share
// types, styles, and the snapshot-fetcher hook. Splitting would just
// scatter the styles and force the hook to live in a shared module.

import { useState, useEffect, useCallback, type CSSProperties } from "react";
import type {
  PluginPageProps,
  PluginSidebarProps,
  PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID } from "../manifest.js";
import type { SnapshotResponse, AccountRow, CcrotateTarget } from "../types.js";

// ─── shared fetch helpers ───────────────────────────────────────────────────

function apiUrl(path: string): string {
  return `/api/plugins/${PLUGIN_ID}${path}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: "include" });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// ─── snapshot hook ──────────────────────────────────────────────────────────

function useSnapshot(companyId: string | null | undefined) {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await getJson<SnapshotResponse>(`/snapshot?companyId=${encodeURIComponent(companyId)}`);
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    if (!companyId) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const r = await getJson<SnapshotResponse>(`/snapshot?companyId=${encodeURIComponent(companyId)}`);
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  const refresh = useCallback(async () => {
    if (!companyId) return;
    setRefreshing(true);
    setError(null);
    try {
      await postJson("/refresh", { companyId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [companyId, load]);

  return { data, loading, error, refreshing, refresh, reload: load };
}

// ─── shared styles ──────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px",
  display: "grid",
  gap: "24px",
  color: "var(--foreground, #fafafa)",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border, #27272a)",
  borderRadius: "8px",
  padding: "16px",
  background: "var(--card, #09090b)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  marginBottom: "12px",
};

const headerTitleStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 600,
  margin: 0,
};

const subtleStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--muted-foreground, #a1a1aa)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  borderBottom: "1px solid var(--border, #27272a)",
  fontWeight: 500,
  color: "var(--muted-foreground, #a1a1aa)",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #27272a)",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
};

const primaryBtnStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  padding: "8px 16px",
  borderRadius: "6px",
  border: "none",
  background: "var(--primary, #fafafa)",
  color: "var(--primary-foreground, #09090b)",
  cursor: "pointer",
};

const secondaryBtnStyle: CSSProperties = {
  ...primaryBtnStyle,
  background: "var(--secondary, #27272a)",
  color: "var(--secondary-foreground, #fafafa)",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: "120px",
  padding: "10px",
  fontSize: "12px",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  border: "1px solid var(--border, #27272a)",
  borderRadius: "6px",
  background: "var(--input, #18181b)",
  color: "var(--foreground, #fafafa)",
  resize: "vertical",
};

// Tier color + dot rendering matches `/ccrotate:when` output semantics
// (extra=green, base=yellow, exhausted=gray dim, stale=red).
function tierDot(row: AccountRow): { color: string; label: string } {
  if (!row.isHealthy) return { color: "#ef4444", label: "stale" };
  const tier = (row.tier || "").toLowerCase();
  if (tier.includes("extra")) return { color: "#22c55e", label: row.tier };
  if (tier.includes("exhausted")) return { color: "#71717a", label: row.tier };
  if (tier.includes("base") || tier.includes("available")) return { color: "#eab308", label: row.tier };
  return { color: "#71717a", label: row.tier || "?" };
}

// ─── pool table (shared by Page + SettingsPage) ─────────────────────────────

function PoolTable({ target, accounts }: { target: CcrotateTarget; accounts: AccountRow[] }) {
  if (!accounts.length) {
    return <div style={subtleStyle}>(no {target} accounts in pool)</div>;
  }
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>★</th>
          <th style={thStyle}>account</th>
          <th style={thStyle}>tier</th>
          <th style={thStyle}>5h util</th>
          <th style={thStyle}>7d util</th>
          <th style={thStyle}>availability</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((row) => {
          const { color, label } = tierDot(row);
          return (
            <tr key={row.email}>
              <td style={tdStyle}>{row.isActive ? "★" : ""}</td>
              <td style={tdStyle}>{row.email}</td>
              <td style={tdStyle}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: color, display: "inline-block" }} />
                  {label}
                </span>
              </td>
              <td style={tdStyle}>{row.utilization5h != null ? `${row.utilization5h}%` : "—"}</td>
              <td style={tdStyle}>{row.utilization7d != null ? `${row.utilization7d}%` : "—"}</td>
              <td style={tdStyle}>{row.availability || "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── slot: Page (full nav page at /plugins/kkroo.ccrotate) ──────────────────

export function CcrotatePage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? null;
  const { data, loading, error, refreshing, refresh } = useSnapshot(companyId);

  return (
    <div style={pageStyle}>
      <div style={{ ...headerRowStyle, marginBottom: 0 }}>
        <div>
          <h2 style={{ ...headerTitleStyle, fontSize: "20px" }}>ccrotate pool</h2>
          <div style={subtleStyle}>
            {data?.fetchedAt
              ? `tier-cache fetched ${new Date(data.fetchedAt).toLocaleTimeString()}${data.cacheAge ? ` (age ${data.cacheAge})` : ""}`
              : loading
                ? "loading…"
                : "no data"}
          </div>
        </div>
        <button
          type="button"
          style={primaryBtnStyle}
          onClick={refresh}
          disabled={refreshing || loading}
        >
          {refreshing ? "refreshing…" : "Refresh now"}
        </button>
      </div>

      {error && (
        <div style={{ ...cardStyle, borderColor: "#ef4444", color: "#ef4444" }}>
          {error}
        </div>
      )}

      {(["claude", "codex"] as const).map((target) => {
        const pool = data?.targets?.[target];
        return (
          <div key={target} style={cardStyle}>
            <div style={headerRowStyle}>
              <h3 style={headerTitleStyle}>
                {target === "claude" ? "Claude Code" : "Codex"}
              </h3>
              <span style={subtleStyle}>
                {pool?.accounts ? `${pool.accounts.length} accounts` : pool?.error ? `error: ${pool.error}` : ""}
              </span>
            </div>
            {pool?.error ? (
              <div style={subtleStyle}>{pool.error}</div>
            ) : (
              <PoolTable target={target} accounts={pool?.accounts ?? []} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── slot: SidebarPanel (compact status widget) ─────────────────────────────

export function CcrotateSidebarPanel({ context }: PluginSidebarProps) {
  const companyId = context.companyId ?? null;
  const { data, loading, error } = useSnapshot(companyId);

  const claudeActive = data?.targets?.claude?.accounts?.find((a: AccountRow) => a.isActive);
  const claudeHealthy = data?.targets?.claude?.accounts?.filter((a: AccountRow) => a.isHealthy && !a.tier?.toLowerCase().includes("exhausted")).length ?? 0;
  const codexHealthy = data?.targets?.codex?.accounts?.filter((a: AccountRow) => a.isHealthy && !a.tier?.toLowerCase().includes("exhausted")).length ?? 0;

  return (
    <div style={{ padding: "12px", color: "var(--foreground, #fafafa)", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ fontSize: "11px", fontWeight: 500, color: "var(--muted-foreground, #a1a1aa)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "8px" }}>
        ccrotate
      </div>
      {loading && !data ? (
        <div style={subtleStyle}>loading…</div>
      ) : error ? (
        <div style={{ ...subtleStyle, color: "#ef4444" }}>{error}</div>
      ) : !data ? (
        <div style={subtleStyle}>no data</div>
      ) : (
        <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
          <div>
            <span style={{ color: "var(--muted-foreground, #a1a1aa)" }}>★ active: </span>
            {claudeActive ? claudeActive.email : <span style={subtleStyle}>none</span>}
          </div>
          <div>
            <span style={{ color: "var(--muted-foreground, #a1a1aa)" }}>claude usable: </span>
            <span style={{ color: claudeHealthy > 0 ? "#22c55e" : "#ef4444" }}>{claudeHealthy}</span>
            <span style={{ color: "var(--muted-foreground, #a1a1aa)" }}> / {data?.targets?.claude?.accounts?.length ?? 0}</span>
          </div>
          <div>
            <span style={{ color: "var(--muted-foreground, #a1a1aa)" }}>codex usable: </span>
            <span style={{ color: codexHealthy > 0 ? "#22c55e" : "#ef4444" }}>{codexHealthy}</span>
            <span style={{ color: "var(--muted-foreground, #a1a1aa)" }}> / {data?.targets?.codex?.accounts?.length ?? 0}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── slot: SettingsPage (state import/export) ───────────────────────────────

export function CcrotateSettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId ?? null;
  const [persisted, setPersisted] = useState<{ blob?: string; capturedAt?: string } | null>(null);
  const [importBlob, setImportBlob] = useState("");
  const [busy, setBusy] = useState<"idle" | "loading" | "saving" | "importing">("loading");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    setBusy("loading");
    getJson<{ blob?: string; capturedAt?: string }>(`/state?companyId=${encodeURIComponent(companyId)}`)
      .then((r) => { setPersisted(r); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy("idle"));
  }, [companyId]);

  async function handleImport() {
    if (!companyId || !importBlob.trim()) return;
    setBusy("importing");
    setError(null);
    setSuccess(null);
    try {
      await postJson("/import", { companyId, blob: importBlob.trim() });
      setSuccess("import complete — accounts merged into pool");
      setImportBlob("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div style={pageStyle}>
      <div>
        <h2 style={{ ...headerTitleStyle, fontSize: "20px" }}>ccrotate settings</h2>
        <div style={subtleStyle}>
          Operator-facing controls for the in-pod ccrotate pool. The
          live pool table lives on the main ccrotate page.
        </div>
      </div>

      {error && <div style={{ ...cardStyle, borderColor: "#ef4444", color: "#ef4444" }}>{error}</div>}
      {success && <div style={{ ...cardStyle, borderColor: "#22c55e", color: "#22c55e" }}>{success}</div>}

      <div style={cardStyle}>
        <div style={headerRowStyle}>
          <h3 style={headerTitleStyle}>Last persisted export</h3>
          <span style={subtleStyle}>
            {persisted?.capturedAt
              ? `captured ${new Date(persisted.capturedAt).toLocaleString()}`
              : busy === "loading"
                ? "loading…"
                : "none yet"}
          </span>
        </div>
        <div style={subtleStyle}>
          This blob is re-imported by job-pod preRun hooks so jobs see
          the same pool the auth-bot snapped. Refresh writes a fresh
          blob automatically.
        </div>
        {persisted?.blob && (
          <textarea
            readOnly
            value={persisted.blob}
            style={{ ...textareaStyle, marginTop: "12px" }}
            onClick={(e) => e.currentTarget.select()}
          />
        )}
      </div>

      <div style={cardStyle}>
        <div style={headerRowStyle}>
          <h3 style={headerTitleStyle}>Import export blob</h3>
        </div>
        <div style={subtleStyle}>
          Paste an <code>mp-gz-b64:</code> blob from <code>ccrotate export</code>
          to merge accounts into the pool. Existing entries are
          preserved if locally fresher.
        </div>
        <textarea
          value={importBlob}
          onChange={(e) => setImportBlob(e.target.value)}
          placeholder="mp-gz-b64:..."
          style={{ ...textareaStyle, marginTop: "12px" }}
        />
        <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            style={secondaryBtnStyle}
            onClick={handleImport}
            disabled={busy === "importing" || !importBlob.trim() || !companyId}
          >
            {busy === "importing" ? "importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
