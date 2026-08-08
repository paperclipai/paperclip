import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { PluginPageProps, PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

const DEFAULT_CONFIG = {
  refreshIntervalSeconds: 60,
  showBadge: true,
  listLimit: 50,
};

const PAGE_ROUTE = "approvals-menu";

interface ApprovalRecord {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  payload?: { title?: string } | null;
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
}

interface PluginConfigShape {
  refreshIntervalSeconds?: number;
  showBadge?: boolean;
  listLimit?: number;
}

function buildApprovalsUrl(companyId: string): string {
  const search = new URLSearchParams({ status: "pending" });
  return `/api/companies/${encodeURIComponent(companyId)}/approvals?${search.toString()}`;
}

function buildPagePath(companyPrefix: string | null): string {
  return companyPrefix ? `/${companyPrefix}/${PAGE_ROUTE}` : `/${PAGE_ROUTE}`;
}

function buildApprovalDetailPath(
  companyPrefix: string | null,
  approvalId: string,
): string {
  return companyPrefix
    ? `/${companyPrefix}/approvals/${approvalId}`
    : `/approvals/${approvalId}`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

interface UsePendingApprovalsResult {
  approvals: ApprovalRecord[];
  loading: boolean;
  error: string | null;
  unauthorized: boolean;
  refresh: () => void;
}

/**
 * Polls the pending approvals list using the same-origin board session.
 *
 * Treats 401/403/404 as "the current user has no access to this company's
 * approvals" — a non-board fallback that should render silently rather than
 * surface a red error banner. Any other failure (network, 5xx, parse) is
 * reported as a regular error so operators can see real breakage.
 */
function usePendingApprovals(
  companyId: string | null,
  refreshIntervalSeconds: number,
  limit: number,
): UsePendingApprovalsResult {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(companyId));
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState<boolean>(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!companyId) {
      setApprovals([]);
      setLoading(false);
      setError(null);
      setUnauthorized(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(buildApprovalsUrl(companyId), { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setApprovals([]);
          setError(null);
          setUnauthorized(true);
          return;
        }
        if (!res.ok) {
          throw new Error(`Approvals request failed (${res.status})`);
        }
        const body = (await res.json()) as ApprovalRecord[];
        setApprovals(Array.isArray(body) ? body.slice(0, limit) : []);
        setError(null);
        setUnauthorized(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setUnauthorized(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, limit, tick]);

  useEffect(() => {
    if (!companyId || refreshIntervalSeconds <= 0) return;
    const handle = window.setInterval(
      () => setTick((t) => t + 1),
      refreshIntervalSeconds * 1000,
    );
    return () => window.clearInterval(handle);
  }, [companyId, refreshIntervalSeconds]);

  const refresh = useMemo(() => () => setTick((t) => t + 1), []);
  return { approvals, loading, error, unauthorized, refresh };
}

function useResolvedConfig() {
  const { data } = usePluginData<PluginConfigShape>("plugin-config", {});
  return {
    refreshIntervalSeconds:
      typeof data?.refreshIntervalSeconds === "number"
        ? data.refreshIntervalSeconds
        : DEFAULT_CONFIG.refreshIntervalSeconds,
    showBadge: data?.showBadge ?? DEFAULT_CONFIG.showBadge,
    listLimit:
      typeof data?.listLimit === "number" && data.listLimit > 0
        ? data.listLimit
        : DEFAULT_CONFIG.listLimit,
  };
}

// ---------------------------------------------------------------------------
// Sidebar entry — mirrors the Inbox nav item with a pending-count badge.
// Links to the plugin's own page so the sidebar is the canonical entry point
// for this plugin (do NOT bypass the plugin and link to core /approvals/pending).
// ---------------------------------------------------------------------------

const SIDEBAR_LINK_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  padding: "0.5rem 0.75rem",
  fontSize: 13,
  fontWeight: 500,
  color: "inherit",
  textDecoration: "none",
};

const SIDEBAR_BADGE_STYLE: CSSProperties = {
  minWidth: 20,
  padding: "0 6px",
  borderRadius: 10,
  background: "var(--accent, rgba(120,120,120,0.2))",
  fontSize: 11,
  textAlign: "center",
  lineHeight: "18px",
};

export function ApprovalsMenuLink({ context }: PluginSidebarProps) {
  const config = useResolvedConfig();
  const { approvals, error, unauthorized } = usePendingApprovals(
    context.companyId,
    config.refreshIntervalSeconds,
    config.listLimit,
  );

  // Non-board user (or no approvals surface available) — render nothing so the
  // sidebar stays clean instead of showing a dead link.
  if (unauthorized) return null;

  const href = buildPagePath(context.companyPrefix);
  const count = approvals.length;
  const showBadge = config.showBadge && count > 0 && !error;

  return (
    <a href={href} aria-label="Approvals" style={SIDEBAR_LINK_STYLE}>
      <span aria-hidden style={{ width: 16, textAlign: "center" }}>
        ✓
      </span>
      <span style={{ flex: 1 }}>Approvals</span>
      {showBadge ? (
        <span style={SIDEBAR_BADGE_STYLE}>{count > 99 ? "99+" : count}</span>
      ) : null}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Page — full list of pending approvals with deep links to the core detail page.
// ---------------------------------------------------------------------------

const PAGE_ROOT_STYLE: CSSProperties = {
  padding: "1.5rem",
  display: "grid",
  gap: "1rem",
};

const PAGE_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
};

const REFRESH_BUTTON_STYLE: CSSProperties = {
  marginLeft: "auto",
  padding: "0.25rem 0.75rem",
  fontSize: 12,
  borderRadius: 4,
  border: "1px solid currentColor",
  background: "transparent",
  cursor: "pointer",
};

const TABLE_STYLE: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const TABLE_HEAD_ROW_STYLE: CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid rgba(128,128,128,0.25)",
};

const TABLE_BODY_ROW_STYLE: CSSProperties = {
  borderBottom: "1px solid rgba(128,128,128,0.12)",
};

const TABLE_CELL_STYLE: CSSProperties = { padding: "0.5rem" };
const TABLE_CELL_MONO_STYLE: CSSProperties = {
  padding: "0.5rem",
  fontFamily: "monospace",
  fontSize: 12,
};

export function ApprovalsMenuPage({ context }: PluginPageProps) {
  const config = useResolvedConfig();
  const { approvals, loading, error, unauthorized, refresh } = usePendingApprovals(
    context.companyId,
    config.refreshIntervalSeconds,
    config.listLimit,
  );

  if (!context.companyId) {
    return (
      <section style={{ padding: "1.5rem" }}>
        <h1 style={{ margin: 0 }}>Approvals</h1>
        <p>Select a company to view its pending approvals.</p>
      </section>
    );
  }

  // Non-board fallback: render a neutral, non-alarming state. Operators see no
  // red error banner; the page is simply empty for users without access.
  if (unauthorized) {
    return (
      <section style={PAGE_ROOT_STYLE}>
        <header style={PAGE_HEADER_STYLE}>
          <h1 style={{ margin: 0, fontSize: 20 }}>Pending Approvals</h1>
        </header>
        <div style={{ opacity: 0.7 }}>
          Approvals are not available for your account in this company.
        </div>
      </section>
    );
  }

  return (
    <section style={PAGE_ROOT_STYLE}>
      <header style={PAGE_HEADER_STYLE}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Pending Approvals</h1>
        <span style={{ fontSize: 13, opacity: 0.7 }}>
          {loading ? "refreshing…" : `${approvals.length} pending`}
        </span>
        <button type="button" onClick={refresh} style={REFRESH_BUTTON_STYLE}>
          Refresh
        </button>
      </header>

      {error ? (
        <div role="alert" style={{ color: "var(--destructive, #b00020)" }}>
          Failed to load approvals: {error}
        </div>
      ) : null}

      {!loading && approvals.length === 0 && !error ? (
        <div style={{ opacity: 0.7 }}>No approvals awaiting review.</div>
      ) : null}

      {approvals.length > 0 ? (
        <table style={TABLE_STYLE}>
          <thead>
            <tr style={TABLE_HEAD_ROW_STYLE}>
              <th style={TABLE_CELL_STYLE}>Title</th>
              <th style={TABLE_CELL_STYLE}>Type</th>
              <th style={TABLE_CELL_STYLE}>Requested by</th>
              <th style={TABLE_CELL_STYLE}>Created</th>
              <th style={TABLE_CELL_STYLE}>Action</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((approval) => {
              const href = buildApprovalDetailPath(context.companyPrefix, approval.id);
              const title = approval.payload?.title ?? approval.type;
              const requester =
                approval.requestedByAgentId ?? approval.requestedByUserId ?? "—";
              return (
                <tr key={approval.id} style={TABLE_BODY_ROW_STYLE}>
                  <td style={TABLE_CELL_STYLE}>
                    <a href={href} style={{ color: "inherit", textDecoration: "underline" }}>
                      {title}
                    </a>
                  </td>
                  <td style={TABLE_CELL_MONO_STYLE}>{approval.type}</td>
                  <td style={TABLE_CELL_MONO_STYLE}>
                    {typeof requester === "string" ? requester.slice(0, 12) : "—"}
                  </td>
                  <td style={TABLE_CELL_STYLE}>{formatRelative(approval.createdAt)}</td>
                  <td style={TABLE_CELL_STYLE}>
                    <a href={href}>Review →</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <footer style={{ fontSize: 12, opacity: 0.6 }}>
        Auto-refresh:{" "}
        {config.refreshIntervalSeconds > 0
          ? `every ${config.refreshIntervalSeconds}s`
          : "disabled"}
      </footer>
    </section>
  );
}
