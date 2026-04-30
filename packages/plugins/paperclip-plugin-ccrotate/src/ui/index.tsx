import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID } from "../manifest.js";

// ---------------------------------------------------------------------------
// Types — narrow projections of the JSON shape returned by the worker routes.
// We deliberately keep these loose so a future ccrotate `tier-cache` schema
// bump (extra fields) is non-breaking; only the columns we render are typed.
// ---------------------------------------------------------------------------

type Target = "claude" | "codex";

interface AccountRow {
  email: string;
  serviceTier?: string | null;
  utilization5h?: number | null;
  utilization7d?: number | null;
  reset5h?: number | null; // unix seconds
  reset7d?: number | null;
  resetAt?: string | null;
  lastUsed?: string | null;
  isCurrent?: boolean;
}

interface PoolPayload {
  cachedAt?: string | null;
  currentEmail?: string | null;
  accounts?: AccountRow[];
  // ccrotate's tier-cache JSON is a record keyed by email — accept either shape.
  [email: string]: unknown;
  error?: string;
}

interface PoolsResponse {
  pools: Record<Target, PoolPayload>;
  fetchedAt: string;
}

interface SshConfig {
  host: string;
  user: string;
  port: number;
  identityFile: string;
  strictHostKeyChecking: boolean;
}

interface PanelHostState {
  ssh: SshConfig | null;
  /** Persisted in localStorage so operators don't re-enter the SSH config every visit. */
  remembered: boolean;
}

const SSH_LOCAL_STORAGE_KEY = `${PLUGIN_ID}:ssh-host`;

// ---------------------------------------------------------------------------
// Styles (match the linear plugin's tokens)
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  border: "1px solid var(--border, #27272a)",
  borderRadius: "8px",
  padding: "16px",
  background: "var(--card, #09090b)",
  marginBottom: "12px",
};

const labelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted-foreground, #a1a1aa)",
};

const inputStyle: CSSProperties = {
  fontSize: "13px",
  padding: "6px 10px",
  border: "1px solid var(--border, #27272a)",
  borderRadius: "6px",
  background: "var(--input, #18181b)",
  color: "var(--foreground, #fafafa)",
  outline: "none",
  width: "100%",
};

const btnStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 500,
  padding: "4px 10px",
  borderRadius: "6px",
  border: "1px solid var(--border, #27272a)",
  background: "var(--secondary, #27272a)",
  color: "var(--secondary-foreground, #fafafa)",
  cursor: "pointer",
};

const tableHeaderRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.5fr 0.6fr 0.7fr 0.7fr 0.7fr 0.6fr",
  gap: "8px",
  padding: "8px 0",
  borderBottom: "1px solid var(--border, #27272a)",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted-foreground, #a1a1aa)",
};

const tableRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.5fr 0.6fr 0.7fr 0.7fr 0.7fr 0.6fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border, #1f1f22)",
  fontSize: "13px",
  alignItems: "center",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadStoredSsh(): SshConfig | null {
  try {
    const raw = window.localStorage.getItem(SSH_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SshConfig> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.host !== "string" || typeof parsed.user !== "string") return null;
    if (typeof parsed.identityFile !== "string") return null;
    return {
      host: parsed.host,
      user: parsed.user,
      port: typeof parsed.port === "number" && parsed.port > 0 ? parsed.port : 22,
      identityFile: parsed.identityFile,
      strictHostKeyChecking: parsed.strictHostKeyChecking !== false,
    };
  } catch {
    return null;
  }
}

function storeSsh(ssh: SshConfig) {
  try {
    window.localStorage.setItem(SSH_LOCAL_STORAGE_KEY, JSON.stringify(ssh));
  } catch {
    // ignore — localStorage may be unavailable in private browsing
  }
}

/**
 * Normalize the loose PoolPayload returned from `ccrotate tier-cache` into
 * a list of AccountRows ready for the table. Defensive: ccrotate has shipped
 * a few different cache shapes across 1.0.x → 1.1.x.
 */
function normalizePoolAccounts(pool: PoolPayload): AccountRow[] {
  if (!pool || typeof pool !== "object") return [];
  if (Array.isArray(pool.accounts)) return pool.accounts;

  // Fall back to record-keyed-by-email shape: { "email@x.com": { ...rateLimits } }
  const rows: AccountRow[] = [];
  for (const [key, value] of Object.entries(pool)) {
    if (key === "cachedAt" || key === "currentEmail" || key === "error" || key === "accounts") {
      continue;
    }
    if (!key.includes("@") || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    rows.push({
      email: key,
      serviceTier: typeof v.serviceTier === "string" ? v.serviceTier : null,
      utilization5h: typeof v.utilization5h === "number" ? v.utilization5h : null,
      utilization7d: typeof v.utilization7d === "number" ? v.utilization7d : null,
      reset5h: typeof v.reset5h === "number" ? v.reset5h : null,
      reset7d: typeof v.reset7d === "number" ? v.reset7d : null,
      resetAt: typeof v.resetAt === "string" ? v.resetAt : null,
      lastUsed: typeof v.lastUsed === "string" ? v.lastUsed : null,
      isCurrent: pool.currentEmail === key,
    });
  }
  return rows;
}

function formatCountdown(epochSeconds: number | null | undefined, nowMs: number): string {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return "—";
  const deltaMs = epochSeconds * 1000 - nowMs;
  if (deltaMs <= 0) return "now";
  const totalMinutes = Math.floor(deltaMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function formatUtilization(util: number | null | undefined): string {
  if (typeof util !== "number" || !Number.isFinite(util)) return "—";
  return `${Math.round(util)}%`;
}

function formatTier(tier: string | null | undefined): string {
  if (!tier) return "—";
  return tier;
}

function tierColor(tier: string | null | undefined): string {
  if (tier === "base") return "var(--success, #4ade80)";
  if (tier === "extra") return "var(--warning, #fbbf24)";
  if (tier === "exhausted") return "var(--destructive, #ef4444)";
  return "var(--muted-foreground, #a1a1aa)";
}

async function callPluginRoute<T = unknown>(
  routePath: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const res = await fetch(`/api/plugins/${PLUGIN_ID}/api${routePath}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ok = res.ok;
    const status = res.status;
    let data: T | null = null;
    let error: string | undefined;
    try {
      data = (await res.json()) as T;
    } catch {
      // non-JSON response (e.g. nginx 503 HTML); fall through with error.
    }
    if (!ok) error = `HTTP ${status}`;
    return { ok, status, data, error };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

// ---------------------------------------------------------------------------
// SSH host editor (top of panel) — operators paste the same config the
// environment driver uses. Persisted to localStorage so reloads keep state.
// ---------------------------------------------------------------------------

function HostEditor({
  ssh,
  onChange,
}: {
  ssh: SshConfig | null;
  onChange: (next: SshConfig) => void;
}) {
  const [draft, setDraft] = useState<SshConfig>(
    ssh ?? {
      host: "",
      user: "",
      port: 22,
      identityFile: "",
      strictHostKeyChecking: true,
    },
  );

  function commit() {
    if (!draft.host.trim() || !draft.user.trim() || !draft.identityFile.trim()) return;
    const next: SshConfig = { ...draft, host: draft.host.trim(), user: draft.user.trim() };
    storeSsh(next);
    onChange(next);
  }

  return (
    <div style={cardStyle}>
      <div style={{ ...labelStyle, marginBottom: "10px" }}>SSH host (where ccrotate lives)</div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 0.6fr", gap: "8px", marginBottom: "8px" }}>
        <input
          style={inputStyle}
          placeholder="host (e.g. 69.25.95.32)"
          value={draft.host}
          onChange={(e) => setDraft({ ...draft, host: e.target.value })}
        />
        <input
          style={inputStyle}
          placeholder="user"
          value={draft.user}
          onChange={(e) => setDraft({ ...draft, user: e.target.value })}
        />
        <input
          style={inputStyle}
          placeholder="port"
          type="number"
          value={draft.port}
          onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 22 })}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px" }}>
        <input
          style={inputStyle}
          placeholder="identity file (absolute path on the plugin worker host)"
          value={draft.identityFile}
          onChange={(e) => setDraft({ ...draft, identityFile: e.target.value })}
        />
        <button style={btnStyle} onClick={commit}>
          Use host
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pool table — accounts for one target (claude or codex)
// ---------------------------------------------------------------------------

function PoolTable({
  target,
  pool,
  ssh,
  onAfterAction,
}: {
  target: Target;
  pool: PoolPayload | null | undefined;
  ssh: SshConfig;
  onAfterAction: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  // Live countdown — re-render every 30s without re-polling routes.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const accounts = useMemo(
    () => (pool ? normalizePoolAccounts(pool) : []),
    [pool],
  );

  if (!pool) {
    return (
      <div style={{ color: "var(--muted-foreground, #a1a1aa)", padding: "12px" }}>
        Loading {target}…
      </div>
    );
  }

  if (pool.error) {
    return (
      <div style={{ color: "var(--destructive, #ef4444)", padding: "12px", fontSize: "13px" }}>
        {target}: {pool.error}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div style={{ color: "var(--muted-foreground, #a1a1aa)", padding: "12px" }}>
        No accounts in {target} pool. Run <code>ccrotate snap</code> on the host.
      </div>
    );
  }

  async function doSwitch(email: string) {
    setBusy(`switch:${email}`);
    const res = await callPluginRoute("/switch", { ssh, email, target });
    setBusy(null);
    onAfterAction();
    if (!res.ok) {
      window.alert(`switch failed: ${res.error ?? "unknown"}`);
    }
  }

  async function doRefresh() {
    setBusy("refresh");
    const res = await callPluginRoute("/refresh", { ssh, target });
    setBusy(null);
    onAfterAction();
    if (!res.ok) {
      window.alert(`refresh failed: ${res.error ?? "unknown"}`);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <div style={{ ...labelStyle, fontSize: "13px", textTransform: "none" }}>
          {target} ({accounts.length} accounts)
        </div>
        <button style={btnStyle} disabled={busy === "refresh"} onClick={doRefresh}>
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div style={tableHeaderRow}>
        <div>Email</div>
        <div>Tier</div>
        <div>5h util</div>
        <div>7d util</div>
        <div>Reset</div>
        <div></div>
      </div>

      {accounts.map((acct) => {
        const earliestReset =
          typeof acct.reset5h === "number" && typeof acct.reset7d === "number"
            ? Math.min(acct.reset5h, acct.reset7d)
            : (acct.reset5h ?? acct.reset7d ?? null);
        const isBusy = busy === `switch:${acct.email}`;
        return (
          <div key={acct.email} style={tableRowStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
              {acct.isCurrent && (
                <span style={{ color: "var(--success, #4ade80)" }} title="current account">★</span>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {acct.email}
              </span>
            </div>
            <div style={{ color: tierColor(acct.serviceTier), fontWeight: 500 }}>
              {formatTier(acct.serviceTier)}
            </div>
            <div>{formatUtilization(acct.utilization5h)}</div>
            <div>{formatUtilization(acct.utilization7d)}</div>
            <div style={{ color: "var(--muted-foreground, #a1a1aa)", fontSize: "12px" }}>
              {formatCountdown(earliestReset, now)}
            </div>
            <div>
              <button
                style={{ ...btnStyle, opacity: acct.isCurrent ? 0.5 : 1 }}
                disabled={acct.isCurrent || isBusy}
                onClick={() => doSwitch(acct.email)}
              >
                {isBusy ? "…" : "Switch"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level settings page export
// ---------------------------------------------------------------------------

export function CcrotatePoolsPage(_props: PluginSettingsPageProps) {
  const [ssh, setSsh] = useState<SshConfig | null>(() => loadStoredSsh());
  const [response, setResponse] = useState<PoolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPools(currentSsh: SshConfig) {
    setLoading(true);
    setError(null);
    const res = await callPluginRoute<PoolsResponse>("/pools", {
      ssh: currentSsh,
      targets: ["claude", "codex"],
    });
    setLoading(false);
    if (res.ok && res.data) {
      setResponse(res.data);
    } else {
      setError(res.error ?? "request failed");
    }
  }

  useEffect(() => {
    if (!ssh) return;
    fetchPools(ssh);
  }, [ssh]);

  // Auto-refresh every 30s once an SSH host is set. Cheap on the host: each
  // poll just re-reads the on-disk tier-cache, no Anthropic API hits.
  useEffect(() => {
    if (!ssh) return;
    const id = window.setInterval(() => fetchPools(ssh), 30_000);
    return () => window.clearInterval(id);
  }, [ssh]);

  return (
    <div style={{ maxWidth: "900px", padding: "16px" }}>
      <div style={{ marginBottom: "12px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: 600, margin: 0 }}>ccrotate Pools</h1>
        <p style={{ color: "var(--muted-foreground, #a1a1aa)", margin: "4px 0 0", fontSize: "13px" }}>
          Live tier cache for the Claude and Codex account pools. Reads from{" "}
          <code>ccrotate tier-cache</code> on the SSH host — does not hit the Anthropic API.
        </p>
      </div>

      <HostEditor ssh={ssh} onChange={setSsh} />

      {!ssh && (
        <div style={{ ...cardStyle, color: "var(--muted-foreground, #a1a1aa)" }}>
          Enter the SSH host above to load pools.
        </div>
      )}

      {error && (
        <div style={{ ...cardStyle, color: "var(--destructive, #ef4444)" }}>
          Error: {error}
        </div>
      )}

      {ssh && (
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <div style={labelStyle}>
              {loading
                ? "Loading…"
                : response
                  ? `Fetched ${new Date(response.fetchedAt).toLocaleTimeString()}`
                  : ""}
            </div>
            <button style={btnStyle} disabled={loading} onClick={() => fetchPools(ssh)}>
              {loading ? "…" : "Reload"}
            </button>
          </div>
          <PoolTable
            target="claude"
            pool={response?.pools?.claude}
            ssh={ssh}
            onAfterAction={() => fetchPools(ssh)}
          />
          <div style={{ height: "16px" }} />
          <PoolTable
            target="codex"
            pool={response?.pools?.codex}
            ssh={ssh}
            onAfterAction={() => fetchPools(ssh)}
          />
        </div>
      )}
    </div>
  );
}

export default CcrotatePoolsPage;
