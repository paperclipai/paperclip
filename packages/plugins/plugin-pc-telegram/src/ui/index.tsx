import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  AssigneePicker,
  StatusBadge,
  usePluginAction,
  usePluginData,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

type PublicConnection = {
  telegramUserId: string;
  username: string | null;
  displayName: string;
  assignedAgentId: string | null;
  incomingMode: string;
  paused: boolean;
  live: boolean;
  hasSession: boolean;
};

type OverviewData = {
  pluginId: string;
  credentialsConfigured: boolean;
  connections: PublicConnection[];
};

type LoginStatus =
  | { state: "idle" }
  | { state: "qr_pending"; loginId: string; qr: { imageDataUrl: string } }
  | { state: "password_required"; loginId: string; hint: string | null }
  | { state: "connected"; loginId: string; account: { telegramUserId: string; username: string | null; displayName: string } }
  | { state: "error"; loginId: string; message: string };

const layout: CSSProperties = {
  display: "grid",
  gap: "16px",
  maxWidth: "720px",
};

const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "16px",
  display: "grid",
  gap: "12px",
  background: "var(--card, transparent)",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};

const muted: CSSProperties = {
  fontSize: "13px",
  opacity: 0.75,
  lineHeight: 1.45,
};

const button: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "6px 12px",
  fontSize: "13px",
  cursor: "pointer",
};

const primaryButton: CSSProperties = {
  ...button,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
};

const input: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function TelegramConnectPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const overview = usePluginData<OverviewData>("overview", companyId ? { companyId } : undefined);
  const startLogin = usePluginAction("start-login");
  const submitPassword = usePluginAction("submit-password");
  const cancelLogin = usePluginAction("cancel-login");
  const updateConnection = usePluginAction("update-connection");
  const setPaused = usePluginAction("set-paused");
  const [loginId, setLoginId] = useState<string | null>(null);
  const login = usePluginData<LoginStatus>("login-status", companyId && loginId ? { companyId, loginId } : companyId ? { companyId } : undefined);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = login.data ?? { state: "idle" as const };

  useEffect(() => {
    if (status.state === "connected") {
      setPassword("");
      overview.refresh();
    }
  }, [status.state]);

  const connections = overview.data?.connections ?? [];

  async function onConnect() {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startLogin({ companyId }) as { loginId?: string };
      if (typeof result.loginId === "string") setLoginId(result.loginId);
      login.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPassword(event: FormEvent) {
    event.preventDefault();
    if (!companyId || !loginId) return;
    const submitted = password;
    setPassword("");
    setBusy(true);
    setError(null);
    try {
      await submitPassword({ companyId, loginId, password: submitted });
      login.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!companyId || !loginId) return;
    setPassword("");
    await cancelLogin({ companyId, loginId }).catch(() => undefined);
    setLoginId(null);
    login.refresh();
  }

  const qrUrl = status.state === "qr_pending" ? status.qr.imageDataUrl : null;
  const hint = status.state === "password_required" ? status.hint : null;

  return (
    <section aria-label="Connect Telegram" style={layout}>
      <div>
        <h2 style={{ margin: "0 0 6px", fontSize: "20px" }}>Telegram</h2>
        <p style={muted}>
          Connect a personal Telegram account with QR login. Incoming direct messages become issues.
          Assign the answering agent on the connection; changing it does not require a new login.
        </p>
      </div>

      <div style={card}>
        <strong>Connect Telegram</strong>
        {overview.data && !overview.data.credentialsConfigured ? (
          <p style={muted}>Set Telegram api_id and api_hash in plugin settings before scanning a QR code.</p>
        ) : null}
        {status.state === "error" ? <p role="alert">{status.message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {qrUrl ? (
          <img src={qrUrl} alt="Telegram login QR code" width={220} height={220} />
        ) : null}
        {status.state === "password_required" ? (
          <form onSubmit={onPassword} style={{ display: "grid", gap: "8px" }}>
            <label>
              Cloud password{hint ? ` (${hint})` : ""}
              <input
                style={input}
                type="password"
                name="cloud-password"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <div style={row}>
              <button type="submit" style={primaryButton} disabled={busy || password.length === 0}>
                Continue
              </button>
              <button type="button" style={button} onClick={() => void onCancel()}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div style={row}>
            <button type="button" style={primaryButton} onClick={() => void onConnect()} disabled={busy || !companyId}>
              {busy ? "Starting…" : "Connect Telegram"}
            </button>
            {status.state === "qr_pending" ? (
              <button type="button" style={button} onClick={() => void onCancel()}>
                Cancel
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div style={card}>
        <strong>Connected accounts</strong>
        {overview.loading ? <p style={muted}>Loading accounts…</p> : null}
        {connections.length === 0 && !overview.loading ? (
          <p style={muted}>No Telegram accounts connected yet.</p>
        ) : null}
        {connections.map((connection) => (
          <ConnectionCard
            key={connection.telegramUserId}
            companyId={companyId}
            connection={connection}
            onChange={async (patch) => {
              if (!companyId) return;
              if ("assignedAgentId" in patch) {
                await updateConnection({
                  companyId,
                  telegramUserId: connection.telegramUserId,
                  assignedAgentId: patch.assignedAgentId,
                });
              }
              if ("paused" in patch) {
                await setPaused({
                  companyId,
                  telegramUserId: connection.telegramUserId,
                  paused: patch.paused,
                });
              }
              overview.refresh();
            }}
          />
        ))}
      </div>
    </section>
  );
}

function ConnectionCard({
  companyId,
  connection,
  onChange,
}: {
  companyId: string | null;
  connection: PublicConnection;
  onChange: (patch: { assignedAgentId?: string | null; paused?: boolean }) => Promise<void>;
}) {
  const assigneeValue = useMemo(
    () => (connection.assignedAgentId ? `agent:${connection.assignedAgentId}` : ""),
    [connection.assignedAgentId],
  );
  return (
    <div style={{ ...card, padding: "12px" }}>
      <div style={row}>
        <strong>{connection.displayName}</strong>
        {connection.username ? <span style={muted}>@{connection.username}</span> : null}
        <StatusBadge label={connection.live ? "Live" : "Offline"} status={connection.live ? "ok" : "warning"} />
        {connection.paused ? <StatusBadge label="Paused" status="pending" /> : null}
      </div>
      <div style={muted}>Incoming mode: dialog = task</div>
      <label style={{ display: "grid", gap: "6px" }}>
        Answering agent
        <AssigneePicker
          companyId={companyId}
          value={assigneeValue}
          includeUsers={false}
          noneLabel="No answering agent"
          onChange={(_value, selection) => {
            void onChange({ assignedAgentId: selection.assigneeAgentId });
          }}
        />
      </label>
      <div style={row}>
        <button
          type="button"
          style={button}
          onClick={() => void onChange({ paused: !connection.paused })}
        >
          {connection.paused ? "Resume inbound" : "Pause inbound"}
        </button>
      </div>
    </div>
  );
}
