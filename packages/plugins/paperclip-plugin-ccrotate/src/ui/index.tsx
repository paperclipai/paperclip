// ccrotate plugin UI v0.6.0 — three slots: page, sidebarPanel, settingsPage.
//
// All components hit the plugin's `apiRoutes` (snapshot, refresh, state-get,
// state-put, import, switch, set-session, relogin) via plain `fetch("/api/plugins/<id>/<path>")`.
// The host's session cookie provides board-level auth (manifest declares
// `auth: "board"` on each route), so credentials are scoped automatically.
//
// v0.6.0 follow-ups (F-UI-1..5):
//   - F-UI-1: per-row "switch" button on non-active accounts → POST /switch
//   - F-UI-2: per-row "set sessionKey" inline form → POST /set-session
//   - F-UI-3: per-model utilization columns (sonnet/opus)
//   - F-UI-4: 30s auto-refresh timer in the snapshot hook
//   - F-UI-5: narrow-viewport responsive layout (grid cards stack)
//
// Why one file: the three components share styles, the snapshot-fetcher
// hook, and the PoolTable render. Splitting would just scatter state.

import { useState, useEffect, useCallback, useRef, type CSSProperties, type FormEvent } from "react";
import { usePluginStream } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginSidebarProps,
  PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID } from "../manifest.js";
import type { SnapshotResponse, AccountRow, CcrotateTarget } from "../types.js";

// The worker emits this shape on the "snapshot" stream channel each time
// the upstream state-server reports a tier-cache mutation. The UI uses
// `usePluginStream("snapshot")` to get push-driven updates — see worker.ts
// emitSnapshot/snapshotSubscriptionLoop.
interface SnapshotStreamEvent {
  reason: string;
  snapshot: SnapshotResponse;
}

// ─── fetch helpers ──────────────────────────────────────────────────────────

function apiUrl(path: string): string {
  // Plugin scoped api routes are mounted at /api/plugins/:pluginId/api/<path>
  // (see server/src/routes/plugins.ts `router.use("/plugins/:pluginId/api", …)`
  // and worker-tier-proxy.ts:69 splat route). The inner `/api/` segment is
  // load-bearing — without it requests 404 at the api-tier router before
  // the worker-tier-proxy ever sees them. Real incident 2026-05-20: the
  // ccrotate UI was missing this segment and every snapshot/switch/etc.
  // call returned `{"error":"API route not found"}`.
  return `/api/plugins/${PLUGIN_ID}/api${path}`;
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
  if (!res.ok) {
    // Surface structured error bodies (e.g. SESSIONKEY_IDENTITY_MISMATCH)
    // so callers can render actionable messages instead of just stringified
    // HTML errors.
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch {}
    const err = new Error(parsed?.error ?? `${path} → ${res.status} ${text}`);
    (err as any).status = res.status;
    (err as any).body = parsed;
    throw err;
  }
  return (await res.json()) as T;
}

// ─── snapshot hook with SSE-driven updates + polling fallback ───────────────
//
// Primary update channel: usePluginStream("snapshot") — the worker emits an
// event each time the upstream state-server reports a tier-cache mutation
// (kkroo/ccrotate#60). The hook applies `lastEvent.snapshot` to local state
// in an effect so React state lives in this hook (not in the SDK's internal
// events array).
//
// Fallback poll: a 5-min silent re-fetch in case the SSE chain is broken
// (worker can't reach state-server, plugin host SSE bridge wedged, etc.).
// Down from the old 30s cadence because the SSE feed is now the primary
// freshness driver; the long fallback is purely a defense-in-depth net.

const FALLBACK_REFRESH_MS = 5 * 60_000;

function useSnapshot(companyId: string | null | undefined) {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const fetchOnce = useCallback(async (silent = false) => {
    if (!companyId) return;
    if (!silent) setLoading(true);
    try {
      const r = await getJson<SnapshotResponse>(`/snapshot?companyId=${encodeURIComponent(companyId)}`);
      if (mounted.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  }, [companyId]);

  // SSE channel subscription — pushed by the worker on every state-server
  // mutation event.
  const stream = usePluginStream<SnapshotStreamEvent>("snapshot", companyId ? { companyId } : undefined);
  useEffect(() => {
    const evt = stream.lastEvent;
    if (!evt?.snapshot || !mounted.current) return;
    setData(evt.snapshot);
    setError(null);
    setLoading(false);
  }, [stream.lastEvent]);

  useEffect(() => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    void fetchOnce(false);
    // Long-interval fallback. Primary freshness is the SSE stream; this just
    // catches the case where the worker → state-server SSE chain silently
    // dies and the page sits open for ages.
    const handle = setInterval(() => { void fetchOnce(true); }, FALLBACK_REFRESH_MS);
    return () => clearInterval(handle);
  }, [companyId, fetchOnce]);

  const refresh = useCallback(async () => {
    if (!companyId) return;
    setRefreshing(true);
    setError(null);
    try {
      await postJson("/refresh", { companyId });
      await fetchOnce(false);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [companyId, fetchOnce]);

  return {
    data,
    loading,
    error,
    refreshing,
    refresh,
    reload: fetchOnce,
    streamConnected: stream.connected,
  };
}

// ─── styles ─────────────────────────────────────────────────────────────────

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
  overflowX: "auto", // F-UI-5: prevent horizontal layout break on narrow viewports
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  marginBottom: "12px",
  flexWrap: "wrap", // F-UI-5
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
  minWidth: "640px", // F-UI-5: table is still wide; card scrolls horizontally
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

const smallBtnStyle: CSSProperties = {
  ...secondaryBtnStyle,
  fontSize: "11px",
  padding: "4px 10px",
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

const inputStyle: CSSProperties = {
  fontSize: "12px",
  padding: "6px 10px",
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  border: "1px solid var(--border, #27272a)",
  borderRadius: "6px",
  background: "var(--input, #18181b)",
  color: "var(--foreground, #fafafa)",
  outline: "none",
  width: "100%",
};

// ─── skeleton placeholders (v0.8.0) ─────────────────────────────────────────
//
// Replaces the bare `loading…` text shown on first paint while the
// snapshot fetch is in flight. The shimmer animation is injected once on
// mount via a `<style>` tag because plugin UI runs in the host's React
// tree with no separate CSS pipeline; the animation lives entirely in
// this file. Components are sized so the skeleton roughly matches the
// real content's layout — fewer layout shifts when data lands.

let skeletonStyleInjected = false;
function ensureSkeletonStyle() {
  if (skeletonStyleInjected || typeof document === "undefined") return;
  const tag = document.createElement("style");
  tag.setAttribute("data-ccrotate-skeleton", "");
  tag.textContent = `
    @keyframes ccrotate-shimmer {
      0%   { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .ccrotate-skeleton {
      display: inline-block;
      background: linear-gradient(
        90deg,
        var(--muted, #27272a) 0%,
        var(--muted-foreground, #3f3f46) 50%,
        var(--muted, #27272a) 100%
      );
      background-size: 200% 100%;
      animation: ccrotate-shimmer 1.6s linear infinite;
      border-radius: 4px;
      vertical-align: middle;
    }
  `;
  document.head.appendChild(tag);
  skeletonStyleInjected = true;
}

function SkeletonBar({
  width = "100%",
  height = 12,
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}) {
  ensureSkeletonStyle();
  return (
    <span
      className="ccrotate-skeleton"
      style={{ width, height, ...style }}
      aria-hidden
    />
  );
}

// Renders N table rows with skeleton cells matching the 10-column PoolTable
// shape (star, email, tier, 5h, 7d, sonnet, opus, availability, api, actions).
// Used inside the same <tbody> the real rows would occupy so column widths
// don't jump when the data arrives.
function PoolTableSkeletonRows({ rows = 4 }: { rows?: number }) {
  const cellWidths: (number | string)[] = [12, 180, 64, 36, 36, 44, 44, 96, 110, 80];
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={`skel-${i}`}>
          {cellWidths.map((w, j) => (
            <td key={j} style={tdStyle}>
              <SkeletonBar width={w} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function accountIsStale(row: AccountRow): boolean {
  return row.isStale === true || row.availabilityMark === "🔴" || /^stale\b/i.test(row.availability || "");
}

function tierDot(row: AccountRow): { color: string; label: string } {
  if (accountIsStale(row) || !row.isHealthy) return { color: "#ef4444", label: "stale" };
  const tier = (row.tier || "").toLowerCase();
  if (tier.includes("extra")) return { color: "#22c55e", label: row.tier };
  if (tier.includes("exhausted")) return { color: "#71717a", label: row.tier };
  if (tier.includes("base") || tier.includes("available")) return { color: "#eab308", label: row.tier };
  return { color: "#71717a", label: row.tier || "?" };
}

// ─── inline per-row sessionKey paste form (F-UI-2) ──────────────────────────

function SetSessionInlineForm({
  email,
  companyId,
  onClose,
  onSuccess,
}: {
  email: string;
  companyId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [sessionKey, setSessionKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = sessionKey.trim();
    if (trimmed.length < 40 || !trimmed.startsWith("sk-ant-")) {
      setErr("expected sk-ant-sid01-... (≥40 chars)");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await postJson("/set-session", { companyId, email, target: "claude", sessionKey: trimmed });
      onSuccess();
      onClose();
    } catch (e: any) {
      // Mismatch error has structured body
      if (e?.body?.code === "SESSIONKEY_IDENTITY_MISMATCH") {
        setErr(`mismatch: key belongs to ${e.body.snappedEmail}`);
      } else {
        setErr(e?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "6px", marginTop: "6px" }}>
      <input
        type="text"
        autoFocus
        placeholder="sk-ant-sid01-..."
        value={sessionKey}
        onChange={(e) => setSessionKey(e.target.value)}
        style={inputStyle}
        disabled={busy}
      />
      {err && <div style={{ ...subtleStyle, color: "#ef4444" }}>{err}</div>}
      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
        <button type="button" style={smallBtnStyle} onClick={onClose} disabled={busy}>
          cancel
        </button>
        <button type="submit" style={{ ...smallBtnStyle, ...primaryBtnStyle, fontSize: "11px", padding: "4px 10px" }} disabled={busy || !sessionKey.trim()}>
          {busy ? "relogging in…" : "set + relogin"}
        </button>
      </div>
    </form>
  );
}

// ─── pool table (shared by Page + SettingsPage) ─────────────────────────────

function PoolTable({
  target,
  accounts,
  companyId,
  onMutated,
  loading = false,
}: {
  target: CcrotateTarget;
  accounts: AccountRow[];
  companyId: string | null;
  onMutated: () => void;
  // v0.8.0: when true and there are no accounts yet, render skeleton
  // rows in place of the empty-state message so the table chrome
  // (column widths, card height) is stable on first paint.
  loading?: boolean;
}) {
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [refreshingEmail, setRefreshingEmail] = useState<string | null>(null);
  const [reloginEmail, setReloginEmail] = useState<string | null>(null);
  const [sessionFormEmail, setSessionFormEmail] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ email: string; msg: string } | null>(null);

  if (!accounts.length) {
    if (loading) {
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>★</th>
              <th style={thStyle}>account</th>
              <th style={thStyle}>tier</th>
              <th style={thStyle}>5h</th>
              <th style={thStyle}>7d</th>
              <th style={thStyle}>7d sonnet</th>
              <th style={thStyle}>7d opus</th>
              <th style={thStyle}>availability</th>
              <th style={thStyle}>api limit</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            <PoolTableSkeletonRows rows={4} />
          </tbody>
        </table>
      );
    }
    return <div style={subtleStyle}>(no {target} accounts in pool)</div>;
  }

  async function doSwitch(email: string) {
    if (!companyId) return;
    setBusyEmail(email);
    setRowError(null);
    try {
      await postJson("/switch", { companyId, email, target });
      onMutated();
    } catch (e: any) {
      setRowError({ email, msg: e?.message ?? String(e) });
    } finally {
      setBusyEmail(null);
    }
  }

  async function doRefreshOne(email: string) {
    if (!companyId) return;
    setRefreshingEmail(email);
    setRowError(null);
    try {
      await postJson("/refresh-one", { companyId, email, target });
      onMutated();
    } catch (e: any) {
      setRowError({ email, msg: e?.message ?? String(e) });
    } finally {
      setRefreshingEmail(null);
    }
  }

  async function doRelogin(email: string) {
    if (!companyId) return;
    setReloginEmail(email);
    setRowError(null);
    try {
      await postJson(target === "claude" ? "/claude-relogin" : "/codex-relogin", { companyId, email });
      onMutated();
    } catch (e: any) {
      setRowError({ email, msg: e?.message ?? String(e) });
    } finally {
      setReloginEmail(null);
    }
  }

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>★</th>
          <th style={thStyle}>account</th>
          <th style={thStyle}>tier</th>
          <th style={thStyle}>5h</th>
          <th style={thStyle}>7d</th>
          {/* F-UI-3: per-model utilization */}
          <th style={thStyle}>7d sonnet</th>
          <th style={thStyle}>7d opus</th>
          <th style={thStyle}>availability</th>
          <th style={thStyle}>api limit</th>
          <th style={thStyle}></th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((row) => {
          const { color, label } = tierDot(row);
          const isBusy = busyEmail === row.email;
          const isRefreshing = refreshingEmail === row.email;
          const isRelogging = reloginEmail === row.email;
          const isSessionFormOpen = sessionFormEmail === row.email;
          const rowIsStale = accountIsStale(row);
          const canRelogin = rowIsStale || !row.isHealthy;
          return (
            <>
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
                <td style={tdStyle}>{row.utilization7dSonnet != null ? `${row.utilization7dSonnet}%` : "—"}</td>
                <td style={tdStyle}>{row.utilization7dOpus != null ? `${row.utilization7dOpus}%` : "—"}</td>
                <td style={tdStyle}>{row.availability || "—"}</td>
                <td style={tdStyle}>{row.apiLimit || "unknown"}</td>
                <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  {/* force-relogin for stale/unhealthy rows */}
                  {canRelogin && (
                    <button type="button" style={smallBtnStyle} disabled={isRelogging || !companyId}
                      onClick={() => doRelogin(row.email)}
                      title={target === "claude"
                        ? "Trigger Claude email-magic relogin (auto-completes via Gmail forwarding)"
                        : "Trigger Codex device-auth relogin (auto-completes via Gmail forwarding)"}>
                      {isRelogging ? "relogging…" : "↺ relogin"}
                    </button>
                  )}
                  {/* F-UI-1: switch button per row */}
                  {target === "claude" && !row.isActive && (
                    <button
                      type="button"
                      style={{ ...smallBtnStyle, marginLeft: "4px" }}
                      disabled={isBusy || !companyId}
                      onClick={() => doSwitch(row.email)}
                      title="Make this the active account"
                    >
                      {isBusy ? "switching…" : "switch"}
                    </button>
                  )}
                  {/* v0.7.0: per-row refresh-one button */}
                  <button
                    type="button"
                    style={{ ...smallBtnStyle, marginLeft: "4px" }}
                    disabled={isRefreshing || !companyId}
                    onClick={() => doRefreshOne(row.email)}
                    title={rowIsStale
                      ? "Try a live Usage API re-probe; relogin or paste sessionKey if the profile remains stale"
                      : "Force a live Usage API re-probe of this account now"}
                  >
                    {isRefreshing ? "↻…" : "↻"}
                  </button>
                  {/* F-UI-2: per-row sessionKey paste (claude only) */}
                  {target === "claude" && (
                    <button
                      type="button"
                      style={{ ...smallBtnStyle, marginLeft: "4px" }}
                      onClick={() => setSessionFormEmail(isSessionFormOpen ? null : row.email)}
                      title="Paste a fresh sessionKey for this account"
                    >
                      {isSessionFormOpen ? "close" : "sessionKey"}
                    </button>
                  )}
                </td>
              </tr>
              {isSessionFormOpen && companyId && (
                <tr key={`${row.email}-form`}>
                  <td colSpan={10} style={{ ...tdStyle, paddingTop: 0, paddingBottom: "16px" }}>
                    <SetSessionInlineForm
                      email={row.email}
                      companyId={companyId}
                      onClose={() => setSessionFormEmail(null)}
                      onSuccess={onMutated}
                    />
                  </td>
                </tr>
              )}
              {rowError && rowError.email === row.email && (
                <tr key={`${row.email}-err`}>
                  <td colSpan={10} style={{ ...tdStyle, color: "#ef4444" }}>{rowError.msg}</td>
                </tr>
              )}
            </>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── slot: Page (full nav page) ─────────────────────────────────────────────

export function CcrotatePage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? null;
  const { data, loading, error, refreshing, refresh, reload, streamConnected } = useSnapshot(companyId);

  return (
    <div style={pageStyle}>
      <div style={{ ...headerRowStyle, marginBottom: 0 }}>
        <div>
          <h2 style={{ ...headerTitleStyle, fontSize: "20px" }}>ccrotate pool</h2>
          <div style={subtleStyle}>
            {data?.fetchedAt ? (
              `tier-cache fetched ${new Date(data.fetchedAt).toLocaleTimeString()}${data.cacheAge ? ` (age ${data.cacheAge})` : ""}  ·  ${streamConnected ? "live (SSE)" : "fallback polling"}`
            ) : loading ? (
              <SkeletonBar width={280} height={11} />
            ) : (
              "no data"
            )}
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
              <PoolTable
                target={target}
                accounts={pool?.accounts ?? []}
                companyId={companyId}
                onMutated={() => void reload(false)}
                loading={loading && !data}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── slot: SidebarPanel ─────────────────────────────────────────────────────

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
        <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
          <SkeletonBar width="80%" height={10} />
          <SkeletonBar width="60%" height={10} />
          <SkeletonBar width="60%" height={10} />
        </div>
      ) : error ? (
        <div style={{ ...subtleStyle, color: "#ef4444" }}>{error}</div>
      ) : !data ? (
        <div style={subtleStyle}>no data</div>
      ) : (
        <div style={{ display: "grid", gap: "6px", fontSize: "12px" }}>
          <div>
            <span style={{ color: "var(--muted-foreground, #a1a1aa)" }}>★ active: </span>
            {claudeActive ? <span style={{ wordBreak: "break-all" }}>{claudeActive.email}</span> : <span style={subtleStyle}>none</span>}
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

// ─── slot: SettingsPage ─────────────────────────────────────────────────────

export function CcrotateSettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId ?? null;
  const [persisted, setPersisted] = useState<{ blob?: string; capturedAt?: string } | null>(null);
  const [importBlob, setImportBlob] = useState("");
  const [busy, setBusy] = useState<"idle" | "loading" | "saving" | "importing" | "clearing">("loading");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clearResult, setClearResult] = useState<{ cleared: number; emails: string[]; refreshError?: string } | null>(null);

  async function handleBulkClear() {
    if (!companyId) return;
    // Confirm without count (simpler than a prefetch — server returns the
    // actual count in the response anyway, so the operator sees what fired).
    if (!confirm("Clear all 'extra' tier labels from the Claude tier-cache? The next per-account probe will re-classify each account.")) {
      return;
    }
    setBusy("clearing");
    setError(null);
    setSuccess(null);
    setClearResult(null);
    try {
      const r = await postJson<{ ok: boolean; cleared: number; emails: string[]; refreshError?: string }>(
        "/clear-stale-tiers",
        { companyId, target: "claude" },
      );
      setClearResult({ cleared: r.cleared, emails: r.emails, refreshError: r.refreshError });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("idle");
    }
  }

  useEffect(() => {
    if (!companyId) return;
    setBusy("loading");
    getJson<{ snapshot: { blob?: string; capturedAt?: string } | null }>(`/state?companyId=${encodeURIComponent(companyId)}`)
      .then((r) => { setPersisted(r.snapshot); setError(null); })
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
            {persisted?.capturedAt ? (
              `captured ${new Date(persisted.capturedAt).toLocaleString()}`
            ) : busy === "loading" ? (
              <SkeletonBar width={180} height={11} />
            ) : (
              "none yet"
            )}
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

      <div style={cardStyle}>
        <div style={headerRowStyle}>
          <h3 style={headerTitleStyle}>Bulk-clear stale tier labels</h3>
        </div>
        <div style={subtleStyle}>
          Removes 'extra' tier labels from tier-cache; next per-account
          probe re-classifies. Use after PR #55-style classifier changes
          to drop pre-fix entries without waiting hours for the
          freshness-loop to re-probe each account.
        </div>
        {clearResult && (
          <div
            style={{
              marginTop: "12px",
              padding: "10px",
              borderRadius: "6px",
              background: "var(--input, #18181b)",
              border: "1px solid var(--border, #27272a)",
              fontSize: "12px",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
            }}
          >
            <div>
              Cleared {clearResult.cleared} account
              {clearResult.cleared === 1 ? "" : "s"}
              {clearResult.emails.length > 0 ? ":" : "."}
            </div>
            {clearResult.emails.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: "20px" }}>
                {clearResult.emails.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {clearResult.refreshError && (
              <div style={{ marginTop: "6px", color: "#eab308" }}>
                refresh kick failed: {clearResult.refreshError} (freshness-loop will re-probe on its own cadence)
              </div>
            )}
          </div>
        )}
        <div style={{ marginTop: "12px", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            style={secondaryBtnStyle}
            onClick={handleBulkClear}
            disabled={busy === "clearing" || !companyId}
          >
            {busy === "clearing" ? "clearing…" : "Clear stale tier=extra labels"}
          </button>
        </div>
      </div>
    </div>
  );
}
