import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
  type PluginSettingsPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, DEFAULT_CONFIG, PLUGIN_ID, PAGE_ROUTE } from "../constants.js";

// ---------------------------------------------------------------------------
// Shared types & styles
// ---------------------------------------------------------------------------

type SentryIssueRow = {
  id: string;
  shortId: string;
  title: string;
  level: string;
  status: string;
  count: string;
  userCount: number;
  lastSeen: string;
  firstSeen: string;
  culprit: string;
  project: string;
  permalink: string;
};

type OverviewData = {
  configured: boolean;
  issues: SentryIssueRow[];
  error?: string;
};

type IssueDetailData = {
  issue: SentryIssueRow & { metadata: Record<string, unknown> };
  latestEvent: {
    eventID: string;
    title: string;
    message: string;
    dateCreated: string;
    tags: Array<{ key: string; value: string }>;
  } | null;
  stacktrace: unknown;
  breadcrumbs: unknown;
  events: Array<{
    eventID: string;
    title: string;
    message: string;
    dateCreated: string;
    tags: Array<{ key: string; value: string }>;
  }>;
};

const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#e0e0e0",
    padding: "16px",
  } satisfies CSSProperties,
  card: {
    background: "rgba(255,255,255,0.04)",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.08)",
    padding: "16px",
    marginBottom: "12px",
  } satisfies CSSProperties,
  heading: {
    fontSize: "18px",
    fontWeight: 600,
    margin: "0 0 12px 0",
    color: "#f0f0f0",
  } satisfies CSSProperties,
  subheading: {
    fontSize: "14px",
    fontWeight: 600,
    margin: "0 0 8px 0",
    color: "#d0d0d0",
  } satisfies CSSProperties,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "13px",
  } satisfies CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "8px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    color: "#999",
    fontWeight: 500,
    fontSize: "11px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  } satisfies CSSProperties,
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
    verticalAlign: "top" as const,
  } satisfies CSSProperties,
  levelBadge: (level: string): CSSProperties => ({
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    background:
      level === "fatal"
        ? "rgba(220,38,38,0.2)"
        : level === "error"
          ? "rgba(239,68,68,0.15)"
          : level === "warning"
            ? "rgba(234,179,8,0.15)"
            : "rgba(100,100,100,0.15)",
    color: level === "fatal" ? "#fca5a5" : level === "error" ? "#fca5a5" : level === "warning" ? "#fde047" : "#aaa",
  }),
  link: {
    color: "#60a5fa",
    textDecoration: "none",
    cursor: "pointer",
  } satisfies CSSProperties,
  muted: {
    color: "#888",
    fontSize: "12px",
  } satisfies CSSProperties,
  empty: {
    color: "#666",
    textAlign: "center" as const,
    padding: "24px",
    fontSize: "14px",
  } satisfies CSSProperties,
  error: {
    color: "#fca5a5",
    background: "rgba(220,38,38,0.1)",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "13px",
  } satisfies CSSProperties,
  pre: {
    background: "rgba(0,0,0,0.3)",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
    fontFamily: "monospace",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
    color: "#ccc",
    maxHeight: "400px",
    overflow: "auto",
  } satisfies CSSProperties,
  btn: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "6px",
    color: "#e0e0e0",
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: "13px",
  } satisfies CSSProperties,
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// Issue table (shared between page and widget)
// ---------------------------------------------------------------------------

function IssueTable({
  issues,
  compact,
  onSelect,
}: {
  issues: SentryIssueRow[];
  compact?: boolean;
  onSelect?: (id: string) => void;
}) {
  if (issues.length === 0) {
    return <div style={styles.empty}>No unresolved issues found.</div>;
  }
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Level</th>
          <th style={styles.th}>Issue</th>
          {!compact && <th style={styles.th}>Culprit</th>}
          <th style={styles.th}>Events</th>
          {!compact && <th style={styles.th}>Users</th>}
          <th style={styles.th}>Last Seen</th>
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <tr key={issue.id}>
            <td style={styles.td}>
              <span style={styles.levelBadge(issue.level)}>{issue.level}</span>
            </td>
            <td style={styles.td}>
              {onSelect ? (
                <span style={{ ...styles.link, fontWeight: 500 }} onClick={() => onSelect(issue.id)}>
                  {issue.shortId}
                </span>
              ) : (
                <a
                  href={issue.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...styles.link, fontWeight: 500 }}
                >
                  {issue.shortId}
                </a>
              )}
              <div
                style={{
                  color: "#bbb",
                  fontSize: "12px",
                  marginTop: "2px",
                  maxWidth: compact ? "200px" : "400px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {issue.title}
              </div>
            </td>
            {!compact && <td style={{ ...styles.td, ...styles.muted }}>{issue.culprit}</td>}
            <td style={{ ...styles.td, fontVariantNumeric: "tabular-nums" }}>{issue.count}</td>
            {!compact && <td style={{ ...styles.td, fontVariantNumeric: "tabular-nums" }}>{issue.userCount}</td>}
            <td style={{ ...styles.td, ...styles.muted }}>{timeAgo(issue.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Issue detail view
// ---------------------------------------------------------------------------

function IssueDetail({ issueId, onBack }: { issueId: string; onBack: () => void }) {
  const { data, loading, error } = usePluginData<IssueDetailData>(DATA_KEYS.issueDetail, { issueId });

  return (
    <div>
      <div style={{ marginBottom: "12px" }}>
        <span style={styles.btn} onClick={onBack}>
          &larr; Back to issues
        </span>
      </div>
      {loading && <div style={styles.muted}>Loading issue detail...</div>}
      {error && <div style={styles.error}>{error.message}</div>}
      {data && (
        <>
          <div style={styles.card}>
            <h3 style={styles.heading}>
              <span style={styles.levelBadge(data.issue.level)}>{data.issue.level}</span> {data.issue.shortId}:{" "}
              {data.issue.title}
            </h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: "12px",
                fontSize: "13px",
              }}
            >
              <div>
                <span style={styles.muted}>Status</span>
                <div>{data.issue.status}</div>
              </div>
              <div>
                <span style={styles.muted}>Events</span>
                <div>{data.issue.count}</div>
              </div>
              <div>
                <span style={styles.muted}>Users</span>
                <div>{data.issue.userCount}</div>
              </div>
              <div>
                <span style={styles.muted}>First Seen</span>
                <div>{timeAgo(data.issue.firstSeen)}</div>
              </div>
              <div>
                <span style={styles.muted}>Last Seen</span>
                <div>{timeAgo(data.issue.lastSeen)}</div>
              </div>
              <div>
                <span style={styles.muted}>Culprit</span>
                <div>{data.issue.culprit}</div>
              </div>
            </div>
            {data.issue.permalink && (
              <div style={{ marginTop: "12px" }}>
                <a href={data.issue.permalink} target="_blank" rel="noopener noreferrer" style={styles.link}>
                  View in Sentry &rarr;
                </a>
              </div>
            )}
          </div>

          {data.stacktrace && (
            <div style={styles.card}>
              <h4 style={styles.subheading}>Stacktrace</h4>
              <pre style={styles.pre}>{JSON.stringify(data.stacktrace, null, 2)}</pre>
            </div>
          )}

          {data.breadcrumbs && (
            <div style={styles.card}>
              <h4 style={styles.subheading}>Breadcrumbs</h4>
              <pre style={styles.pre}>{JSON.stringify(data.breadcrumbs, null, 2)}</pre>
            </div>
          )}

          {data.latestEvent && (
            <div style={styles.card}>
              <h4 style={styles.subheading}>Latest Event</h4>
              <div style={{ fontSize: "13px", marginBottom: "8px" }}>
                <span style={styles.muted}>Event ID:</span> {data.latestEvent.eventID}
              </div>
              <div style={{ fontSize: "13px", marginBottom: "8px" }}>
                <span style={styles.muted}>Date:</span> {data.latestEvent.dateCreated}
              </div>
              {data.latestEvent.message && (
                <div style={{ fontSize: "13px", marginBottom: "8px" }}>
                  <span style={styles.muted}>Message:</span> {data.latestEvent.message}
                </div>
              )}
              {data.latestEvent.tags && data.latestEvent.tags.length > 0 && (
                <div>
                  <span style={styles.muted}>Tags:</span>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "4px",
                      marginTop: "4px",
                    }}
                  >
                    {data.latestEvent.tags.map((tag, i) => (
                      <span
                        key={i}
                        style={{
                          background: "rgba(255,255,255,0.06)",
                          borderRadius: "4px",
                          padding: "2px 6px",
                          fontSize: "11px",
                          color: "#aaa",
                        }}
                      >
                        {tag.key}={tag.value}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {data.events.length > 1 && (
            <div style={styles.card}>
              <h4 style={styles.subheading}>Recent Events ({data.events.length})</h4>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Event ID</th>
                    <th style={styles.th}>Title</th>
                    <th style={styles.th}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((evt) => (
                    <tr key={evt.eventID}>
                      <td style={{ ...styles.td, ...styles.muted, fontFamily: "monospace" }}>
                        {evt.eventID.slice(0, 12)}...
                      </td>
                      <td style={styles.td}>{evt.title}</td>
                      <td style={{ ...styles.td, ...styles.muted }}>{timeAgo(evt.dateCreated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exports: Page
// ---------------------------------------------------------------------------

export function SentryPage(_props: PluginPageProps) {
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const { data, loading, error } = usePluginData<OverviewData>(DATA_KEYS.overview, {});

  if (selectedIssueId) {
    return (
      <div style={styles.container}>
        <IssueDetail issueId={selectedIssueId} onBack={() => setSelectedIssueId(null)} />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Sentry Errors</h2>
      {loading && <div style={styles.muted}>Loading...</div>}
      {error && <div style={styles.error}>{error.message}</div>}
      {data && !data.configured && (
        <div style={styles.card}>
          <p style={{ color: "#fde047", margin: 0 }}>
            Sentry is not configured. Set the auth token and organization slug in plugin settings.
          </p>
        </div>
      )}
      {data?.error && <div style={styles.error}>{data.error}</div>}
      {data?.configured && (
        <div style={styles.card}>
          <h3 style={styles.subheading}>Unresolved Issues ({data.issues.length})</h3>
          <IssueTable issues={data.issues} onSelect={setSelectedIssueId} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exports: Dashboard Widget
// ---------------------------------------------------------------------------

export function SentryDashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<OverviewData>(DATA_KEYS.overview, {});

  const issues = data?.issues?.slice(0, 5) ?? [];

  return (
    <div style={styles.container}>
      <h3 style={styles.subheading}>Sentry Errors</h3>
      {loading && <div style={styles.muted}>Loading...</div>}
      {error && <div style={{ ...styles.error, fontSize: "12px" }}>{error.message}</div>}
      {data && !data.configured && (
        <div style={{ ...styles.muted, fontSize: "12px" }}>Not configured — set up in plugin settings.</div>
      )}
      {data?.error && <div style={{ ...styles.error, fontSize: "12px" }}>{data.error}</div>}
      {data?.configured && issues.length === 0 && <div style={styles.muted}>No unresolved issues</div>}
      {data?.configured && issues.length > 0 && <IssueTable issues={issues} compact />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings config hook (reads/writes plugin config via host API)
// ---------------------------------------------------------------------------

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

function useSettingsConfig() {
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({
    ...DEFAULT_CONFIG,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: Record<string, unknown> | null } | null>(`/api/plugins/${PLUGIN_ID}/config`)
      .then((result) => {
        if (cancelled) return;
        setConfigJson({ ...DEFAULT_CONFIG, ...(result?.configJson ?? {}) });
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(nextConfig: Record<string, unknown>) {
    setSaving(true);
    try {
      await hostFetchJson(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: nextConfig }),
      });
      setConfigJson(nextConfig);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    } finally {
      setSaving(false);
    }
  }

  return { configJson, setConfigJson, loading, saving, error, save };
}

const inputStyle: CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "6px",
  color: "#e0e0e0",
  padding: "8px 10px",
  fontSize: "13px",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "4px",
  fontSize: "13px",
};

const primaryBtnStyle: CSSProperties = {
  background: "#3b82f6",
  border: "none",
  borderRadius: "6px",
  color: "#fff",
  padding: "8px 20px",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

// ---------------------------------------------------------------------------
// Exports: Settings Page
// ---------------------------------------------------------------------------

export function SentrySettingsPage(_props: PluginSettingsPageProps) {
  const { configJson, setConfigJson, loading, saving, error, save } = useSettingsConfig();
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  function setField(key: string, value: unknown) {
    setConfigJson((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await save(configJson);
      setSavedMessage("Settings saved!");
      window.setTimeout(() => setSavedMessage(null), 2000);
    } catch {
      // error is already set by the hook
    }
  }

  async function onTestConnection() {
    setTestStatus("Testing...");
    try {
      await hostFetchJson(`/api/plugins/${PLUGIN_ID}/config/test`, {
        method: "POST",
        body: JSON.stringify({ configJson }),
      });
      setTestStatus("Connection successful!");
    } catch (err) {
      setTestStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    window.setTimeout(() => setTestStatus(null), 4000);
  }

  if (loading) {
    return <div style={{ fontSize: "12px", opacity: 0.7, padding: "16px" }}>Loading plugin config...</div>;
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "20px", padding: "16px", maxWidth: "600px" }}>
      <div>
        <h3 style={{ ...styles.subheading, marginBottom: "4px" }}>Sentry Configuration</h3>
        <div style={{ fontSize: "12px", color: "#888" }}>
          Connect to your Sentry instance to enable error tracking for agents and the board dashboard.
        </div>
      </div>

      <label style={labelStyle}>
        <span>
          Auth Token <span style={{ color: "#f87171" }}>*</span>
        </span>
        <input
          type="password"
          style={inputStyle}
          value={String(configJson.authToken ?? "")}
          onChange={(e) => setField("authToken", e.target.value)}
          placeholder="sntrys_..."
        />
        <span style={{ fontSize: "11px", color: "#666" }}>
          Sentry API token with org:read, project:read, event:read scopes
        </span>
      </label>

      <label style={labelStyle}>
        <span>
          Organization Slug <span style={{ color: "#f87171" }}>*</span>
        </span>
        <input
          style={inputStyle}
          value={String(configJson.organizationSlug ?? "")}
          onChange={(e) => setField("organizationSlug", e.target.value)}
          placeholder="my-org"
        />
      </label>

      <label style={labelStyle}>
        <span>Project Slug</span>
        <input
          style={inputStyle}
          value={String(configJson.projectSlug ?? "")}
          onChange={(e) => setField("projectSlug", e.target.value)}
          placeholder="my-project (optional — leave empty for all projects)"
        />
      </label>

      <label style={labelStyle}>
        <span>Sentry Base URL</span>
        <input
          style={inputStyle}
          value={String(configJson.sentryBaseUrl ?? DEFAULT_CONFIG.sentryBaseUrl)}
          onChange={(e) => setField("sentryBaseUrl", e.target.value)}
          placeholder="https://sentry.io"
        />
        <span style={{ fontSize: "11px", color: "#666" }}>
          For self-hosted Sentry instances. Defaults to https://sentry.io
        </span>
      </label>

      {error && <div style={styles.error}>{error}</div>}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <button type="submit" style={primaryBtnStyle} disabled={saving}>
          {saving ? "Saving..." : "Save settings"}
        </button>
        <button type="button" style={styles.btn} onClick={onTestConnection} disabled={saving}>
          Test connection
        </button>
        {savedMessage && <span style={{ fontSize: "12px", color: "#4ade80" }}>{savedMessage}</span>}
        {testStatus && (
          <span
            style={{
              fontSize: "12px",
              color: testStatus.startsWith("Failed") ? "#fca5a5" : "#4ade80",
            }}
          >
            {testStatus}
          </span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Exports: Sidebar Link
// ---------------------------------------------------------------------------

export function SentrySidebarLink(_props: PluginSidebarProps) {
  const ctx = useHostContext();
  const prefix = ctx.companyPrefix ?? "";
  const [hovered, setHovered] = useState(false);
  return (
    <a
      href={`/${prefix}/${PAGE_ROUTE}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        fontSize: "13px",
        fontWeight: 500,
        color: hovered ? "hsl(var(--foreground))" : "hsl(var(--foreground) / 0.8)",
        backgroundColor: hovered ? "hsl(var(--accent) / 0.5)" : "transparent",
        textDecoration: "none",
        cursor: "pointer",
        transition: "color 0.15s, background-color 0.15s",
        borderRadius: "4px",
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Sentry Errors</span>
    </a>
  );
}
