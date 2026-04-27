import { useState, type CSSProperties } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const layoutStack: CSSProperties = {
  display: "grid",
  gap: "12px",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "14px",
  background: "var(--card, transparent)",
};

const subtleCard: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
  borderRadius: "10px",
  padding: "12px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "13px",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  opacity: 0.65,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: "4px",
};

const buttonStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  fontSize: "13px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
};

const mutedText: CSSProperties = {
  fontSize: "12px",
  opacity: 0.72,
  lineHeight: 1.5,
};

const metricStyle: CSSProperties = {
  display: "grid",
  gap: "2px",
};

const bigNumberStyle: CSSProperties = {
  fontSize: "28px",
  fontWeight: 700,
  lineHeight: 1,
};

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: ok ? "#16a34a" : "#dc2626",
        marginRight: "6px",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// StatusData type matching the worker's data.register("status") handler
// ---------------------------------------------------------------------------

type StatusData = {
  configured: boolean;
  pushoverUser: string | null;
  notificationCount: number;
  lastNotificationAt: string | null;
  monitoredEvents: readonly string[];
};

// ---------------------------------------------------------------------------
// Dashboard Widget — compact status overview
// ---------------------------------------------------------------------------

export function NotificationStatusWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<StatusData>("status");
  const testNotification = usePluginAction("test-notification");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  if (loading) return <div style={mutedText}>Loading…</div>;
  if (error) return <div style={{ ...mutedText, color: "var(--destructive, #dc2626)" }}>Error: {error.message}</div>;

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = (await testNotification({})) as { success: boolean; error?: string };
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ ...layoutStack, gap: "10px" }}>
      <div style={rowStyle}>
        <StatusDot ok={data?.configured ?? false} />
        <strong>Mobile Notifications</strong>
      </div>

      <div style={{ display: "grid", gap: "8px", gridTemplateColumns: "1fr 1fr" }}>
        <div style={metricStyle}>
          <span style={labelStyle}>Sent</span>
          <span style={bigNumberStyle}>{data?.notificationCount ?? 0}</span>
        </div>
        <div style={metricStyle}>
          <span style={labelStyle}>Status</span>
          <span style={{ fontSize: "13px" }}>{data?.configured ? "Active" : "Not configured"}</span>
        </div>
      </div>

      {data?.lastNotificationAt ? (
        <div style={mutedText}>
          Last sent: {new Date(data.lastNotificationAt).toLocaleString()}
        </div>
      ) : (
        <div style={mutedText}>No notifications sent yet</div>
      )}

      {data?.configured ? (
        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={testing}
            onClick={() => void handleTest()}
          >
            {testing ? "Sending…" : "Send test"}
          </button>
          {testResult ? (
            <span style={{ fontSize: "12px", color: testResult.success ? "#16a34a" : "var(--destructive, #dc2626)" }}>
              {testResult.success ? "Delivered!" : testResult.error ?? "Failed"}
            </span>
          ) : null}
        </div>
      ) : (
        <div style={mutedText}>Configure Pushover credentials in plugin settings to enable.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Page — full configuration form
// ---------------------------------------------------------------------------

export function NotificationSettingsPage(_props: PluginSettingsPageProps) {
  const { data, loading, error } = usePluginData<StatusData>("status");
  const testNotification = usePluginAction("test-notification");

  const [token, setToken] = useState("");
  const [userKey, setUserKey] = useState("");
  const [events, setEvents] = useState("");
  const [prefix, setPrefix] = useState("[Paperclip]");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await fetch("/api/plugins/paperclipai.plugin-notifications/config", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          configJson: {
            pushoverToken: token.trim(),
            pushoverUser: userKey.trim(),
            notifyOnEvents: events.trim(),
            titlePrefix: prefix.trim() || "[Paperclip]",
          },
        }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
      });
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = (await testNotification({})) as { success: boolean; error?: string };
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ ...layoutStack, maxWidth: "600px" }}>
      <div style={cardStyle}>
        <div style={{ ...layoutStack, gap: "6px", marginBottom: "16px" }}>
          <strong style={{ fontSize: "16px" }}>Mobile Push Notifications</strong>
          <div style={mutedText}>
            Receive real-time notifications on your iOS or Android phone when Paperclip issues
            are created, blocked, completed, or when agents fail. Uses the{" "}
            <a href="https://pushover.net" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
              Pushover
            </a>{" "}
            service ($5 one-time per device, free trial available).
          </div>
        </div>

        <div style={subtleCard}>
          <div style={rowStyle}>
            <StatusDot ok={data?.configured ?? false} />
            <span style={{ fontSize: "13px" }}>
              {loading
                ? "Loading…"
                : error
                  ? "Error loading status"
                  : data?.configured
                    ? `Active · ${data.notificationCount} sent · user ${data.pushoverUser ?? ""}`
                    : "Not configured"}
            </span>
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <form onSubmit={(e) => void handleSave(e)} style={layoutStack}>
          <strong>Pushover Credentials</strong>
          <div style={mutedText}>
            Create a free Pushover account and app at{" "}
            <a href="https://pushover.net/apps/build" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
              pushover.net/apps/build
            </a>. Install the Pushover app on your phone, then paste your keys below.
          </div>

          <div>
            <div style={labelStyle}>Application Token *</div>
            <input
              type="password"
              style={inputStyle}
              placeholder="axxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              minLength={1}
            />
          </div>

          <div>
            <div style={labelStyle}>User / Group Key *</div>
            <input
              type="password"
              style={inputStyle}
              placeholder="uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={userKey}
              onChange={(e) => setUserKey(e.target.value)}
              required
              minLength={1}
            />
          </div>

          <div>
            <div style={labelStyle}>Notification Title Prefix</div>
            <input
              type="text"
              style={inputStyle}
              placeholder="[Paperclip]"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </div>

          <div>
            <div style={labelStyle}>Events to Notify (blank = all)</div>
            <input
              type="text"
              style={inputStyle}
              placeholder="issue.created, issue.updated, agent.run.failed, budget.incident.opened"
              value={events}
              onChange={(e) => setEvents(e.target.value)}
            />
            <div style={{ ...mutedText, marginTop: "6px" }}>
              Supported: <code>issue.created</code>, <code>issue.updated</code>,{" "}
              <code>agent.run.failed</code>, <code>budget.incident.opened</code>.
              Leave blank to receive all.
            </div>
          </div>

          <div style={rowStyle}>
            <button type="submit" style={primaryButtonStyle} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
            {saved && !saveError ? (
              <span style={{ fontSize: "12px", color: "#16a34a" }}>Saved!</span>
            ) : null}
            {saveError ? (
              <span style={{ fontSize: "12px", color: "var(--destructive, #dc2626)" }}>
                {saveError}
              </span>
            ) : null}
          </div>
        </form>
      </div>

      <div style={cardStyle}>
        <div style={layoutStack}>
          <strong>Test Notification</strong>
          <div style={mutedText}>
            Send a test push to verify your credentials are working. Make sure you have saved your
            settings first.
          </div>
          <div style={rowStyle}>
            <button
              type="button"
              style={buttonStyle}
              disabled={testing}
              onClick={() => void handleTest()}
            >
              {testing ? "Sending…" : "Send test notification"}
            </button>
            {testResult ? (
              <span
                style={{
                  fontSize: "12px",
                  color: testResult.success ? "#16a34a" : "var(--destructive, #dc2626)",
                }}
              >
                {testResult.success ? "Notification delivered to your phone!" : testResult.error ?? "Failed"}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={layoutStack}>
          <strong>Event Reference</strong>
          <div style={mutedText}>
            The plugin monitors these Paperclip events and sends a push notification for each one
            (subject to your filter list above).
          </div>
          <div style={{ display: "grid", gap: "8px" }}>
            {[
              {
                event: "issue.created",
                description: "Any new issue is created in the company",
                priority: "Normal",
              },
              {
                event: "issue.updated → blocked",
                description: "An issue transitions to blocked status",
                priority: "High (siren sound)",
              },
              {
                event: "issue.updated → done",
                description: "An issue is marked done",
                priority: "Normal (magic sound)",
              },
              {
                event: "agent.run.failed",
                description: "An agent heartbeat run fails",
                priority: "High (siren sound)",
              },
              {
                event: "budget.incident.opened",
                description: "A budget limit is exceeded",
                priority: "High (siren sound)",
              },
            ].map(({ event, description, priority }) => (
              <div key={event} style={subtleCard}>
                <div style={{ fontSize: "13px", fontFamily: "monospace" }}>{event}</div>
                <div style={mutedText}>{description}</div>
                <div style={{ ...mutedText, fontSize: "11px" }}>Priority: {priority}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
