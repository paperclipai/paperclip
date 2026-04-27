import React from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

// ─── Shared styles ────────────────────────────────────────────────────────────

const styles = {
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "16px 20px",
    marginBottom: 12,
  } as React.CSSProperties,
  badge: (ok: boolean): React.CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: ok ? "#d1fae5" : "#fee2e2",
    color: ok ? "#065f46" : "#991b1b",
    marginLeft: 6,
  }),
  pre: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 6,
    padding: 12,
    fontSize: 13,
    whiteSpace: "pre-wrap" as const,
    overflowX: "auto" as const,
    maxHeight: 400,
    overflow: "auto",
  } as React.CSSProperties,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type TodaySummary = {
  date: string | null;
  summary: string | null;
  eventCount: number;
};

type ConfigStatus = {
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  calendarId: string;
  timezone: string;
};

// ─── Today Widget (dashboard) ─────────────────────────────────────────────────

export function TodayWidget() {
  const { data, loading } = usePluginData<TodaySummary>("today-summary");

  if (loading)
    return <div style={{ padding: 16, color: "#6b7280" }}>Loading calendar…</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>📅 Today's Events</div>
      {data?.summary ? (
        <>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
            {data.eventCount} event{data.eventCount === 1 ? "" : "s"} · {data.date}
          </div>
          <div style={styles.pre}>{data.summary}</div>
        </>
      ) : (
        <div style={{ color: "#6b7280", fontSize: 14 }}>
          Configure credentials in plugin settings to see today's events.
        </div>
      )}
    </div>
  );
}

// ─── Full Calendar Page ───────────────────────────────────────────────────────

export function CalendarPage() {
  const { data: status } = usePluginData<ConfigStatus>("config-status");
  const { data: today, loading: todayLoading } = usePluginData<TodaySummary>("today-summary");

  const allConfigured =
    status?.hasClientId && status?.hasClientSecret && status?.hasRefreshToken;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>📅 Google Calendar</h1>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        Google Calendar API v3 connector. Configure OAuth2 credentials in plugin settings, then
        use agent tools to view, create, update, and delete events.
      </p>

      {/* Connection Status */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Connection Status</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
          <div>
            Client ID
            <span style={styles.badge(Boolean(status?.hasClientId))}>
              {status?.hasClientId ? "configured" : "not set"}
            </span>
          </div>
          <div>
            Client Secret
            <span style={styles.badge(Boolean(status?.hasClientSecret))}>
              {status?.hasClientSecret ? "configured" : "not set"}
            </span>
          </div>
          <div>
            Refresh Token
            <span style={styles.badge(Boolean(status?.hasRefreshToken))}>
              {status?.hasRefreshToken ? "configured" : "not set"}
            </span>
          </div>
          <div>
            Calendar ID
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.calendarId ?? "primary"}
            </span>
          </div>
          <div>
            Timezone
            <span style={{ marginLeft: 8, fontWeight: 600 }}>
              {status?.timezone ?? "America/Chicago"}
            </span>
          </div>
        </div>
      </div>

      {/* Available Tools */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Available Agent Tools</div>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
          <li>
            <code>gcal_get_day_summary</code> — human-readable summary of a day's events
          </li>
          <li>
            <code>gcal_list_events</code> — list events in a date range
          </li>
          <li>
            <code>gcal_get_event</code> — fetch a single event by ID
          </li>
          <li>
            <code>gcal_create_event</code> — create a new event
          </li>
          <li>
            <code>gcal_update_event</code> — update an existing event
          </li>
          <li>
            <code>gcal_delete_event</code> — delete an event permanently
          </li>
        </ul>
      </div>

      {/* Today's Events */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Today's Events</div>
        {!allConfigured ? (
          <div style={{ color: "#6b7280", fontSize: 14 }}>
            Configure all three OAuth2 credentials above to enable live event data.
          </div>
        ) : todayLoading ? (
          <div style={{ color: "#6b7280", fontSize: 14 }}>Loading…</div>
        ) : today?.summary ? (
          <>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
              {today.eventCount} event{today.eventCount === 1 ? "" : "s"} · {today.date}
            </div>
            <div style={styles.pre}>{today.summary}</div>
          </>
        ) : (
          <div style={{ color: "#6b7280", fontSize: 14 }}>No events found for today.</div>
        )}
      </div>

      {/* Setup Instructions */}
      <div style={styles.card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Setup Guide</div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 2, color: "#374151" }}>
          <li>
            Go to{" "}
            <strong>Google Cloud Console → APIs &amp; Services → Credentials</strong>
          </li>
          <li>
            Create an <strong>OAuth 2.0 Client ID</strong> (Desktop app type)
          </li>
          <li>
            Enable the <strong>Google Calendar API</strong> for your project
          </li>
          <li>
            Run the OAuth consent flow to obtain a <strong>refresh token</strong> (scopes:{" "}
            <code>https://www.googleapis.com/auth/calendar</code>)
          </li>
          <li>
            Paste <strong>Client ID</strong>, <strong>Client Secret</strong>, and{" "}
            <strong>Refresh Token</strong> into Plugin Settings
          </li>
          <li>
            Set your <strong>Calendar ID</strong> (use <code>primary</code> for default) and
            your <strong>Timezone</strong>
          </li>
        </ol>
      </div>
    </div>
  );
}
