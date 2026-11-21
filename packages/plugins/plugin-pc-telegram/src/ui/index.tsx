import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  AssigneePicker,
  StatusBadge,
  usePluginAction,
  usePluginData,
  usePluginStream,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

type PublicConnection = {
  telegramUserId: string;
  username: string | null;
  displayName: string;
  assignedAgentId: string | null;
  incomingMode: string;
  paused: boolean;
  acceptUnlistedSenders: boolean;
  allowedPeerIds: string[];
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
  gap: "var(--spacing)",
  maxWidth: "100%",
  fontFamily: "var(--font-sans)",
};

const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: "var(--spacing)",
  display: "grid",
  gap: "var(--spacing)",
  background: "var(--card, transparent)",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--spacing)",
  alignItems: "center",
};

const footer: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--spacing)",
};

const muted: CSSProperties = {
  fontSize: "var(--text-sm)",
  lineHeight: "var(--text-sm--line-height)",
  color: "var(--muted-foreground)",
};

const button: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--foreground)",
  padding: "var(--spacing)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-sans)",
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
  borderRadius: "var(--radius-md)",
  padding: "var(--spacing)",
  background: "transparent",
  color: "var(--foreground)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

function statusLoginId(status: LoginStatus): string | null {
  return "loginId" in status ? status.loginId : null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function TelegramConnectPage(props: PluginCompanySettingsPageProps) {
  return <TelegramCompanyConnect key={props.context.companyId ?? ""} {...props} />;
}

function TelegramCompanyConnect({ context }: PluginCompanySettingsPageProps) {
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
  const [streamStatus, setStreamStatus] = useState<LoginStatus | null>(null);
  const loginChannel = !companyId
    ? "telegram-login:none"
    : loginId
      ? `telegram-login:${companyId}:${loginId}`
      : `telegram-login:${companyId}`;
  const loginStream = usePluginStream<{ status?: LoginStatus }>(loginChannel, companyId ? { companyId } : undefined);

  const status = streamStatus ?? login.data ?? { state: "idle" as const };
  const activeLoginId = loginId ?? statusLoginId(status);

  useEffect(() => {
    const nextId = statusLoginId(status);
    if (!nextId) return;
    setLoginId((current) => current ?? nextId);
  }, [status]);

  useEffect(() => {
    const next = loginStream.lastEvent?.status;
    if (!next) return;
    const secret = next.state === "qr_pending" || next.state === "password_required";
    if (secret && !loginId) return;
    if (loginId && "loginId" in next && next.loginId !== loginId) return;
    if (next.state !== "idle") setStreamStatus(next);
    login.refresh();
    overview.refresh();
  }, [loginStream.lastEvent, loginId]);

  useEffect(() => {
    if (status.state === "connected") {
      setPassword("");
      overview.refresh();
    }
  }, [status.state]);

  const connections = overview.data?.connections ?? [];

  async function onConnect() {
    if (!companyId) return;
    setStreamStatus(null);
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
    if (!companyId || !activeLoginId) return;
    const submitted = password;
    setPassword("");
    setBusy(true);
    setError(null);
    try {
      await submitPassword({ companyId, loginId: activeLoginId, password: submitted });
      login.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!companyId || !activeLoginId) return;
    setPassword("");
    setStreamStatus(null);
    await cancelLogin({ companyId, loginId: activeLoginId }).catch(() => undefined);
    setLoginId(null);
    login.refresh();
  }

  const qrUrl = status.state === "qr_pending" ? status.qr.imageDataUrl : null;
  const hint = status.state === "password_required" ? status.hint : null;

  return (
    <section aria-label="Connect Telegram" style={layout}>
      <div style={{ display: "grid", gap: "var(--spacing)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--text-xl)", lineHeight: "var(--text-xl--line-height)", fontFamily: "var(--font-sans)" }}>Telegram</h2>
        <p style={muted}>
          Connect a personal Telegram account with QR login. A direct message becomes an issue only
          when the sender is listed, or when a board user allows every private chat.
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
          <img src={qrUrl} alt="Telegram login QR code" style={{ maxWidth: "100%", height: "auto" }} />
        ) : null}
        {status.state === "password_required" ? (
          <form onSubmit={onPassword} style={{ display: "grid", gap: "var(--spacing)" }}>
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
            <div style={footer}>
              <button type="button" style={button} onClick={() => void onCancel()}>
                Cancel
              </button>
              <button type="submit" style={primaryButton} disabled={busy || password.length === 0}>
                Continue
              </button>
            </div>
          </form>
        ) : (
          <div style={{ ...footer, justifyContent: status.state === "qr_pending" ? "space-between" : "flex-end" }}>
            {status.state === "qr_pending" ? (
              <button type="button" style={button} onClick={() => void onCancel()}>
                Cancel
              </button>
            ) : null}
            <button type="button" style={primaryButton} onClick={() => void onConnect()} disabled={busy || !companyId}>
              {busy ? "Starting…" : "Connect Telegram"}
            </button>
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
              if (
                "assignedAgentId" in patch
                || "acceptUnlistedSenders" in patch
                || "allowedPeerIds" in patch
              ) {
                await updateConnection({
                  companyId,
                  telegramUserId: connection.telegramUserId,
                  ...("assignedAgentId" in patch ? { assignedAgentId: patch.assignedAgentId } : {}),
                  ...("acceptUnlistedSenders" in patch ? { acceptUnlistedSenders: patch.acceptUnlistedSenders } : {}),
                  ...("allowedPeerIds" in patch ? { allowedPeerIds: patch.allowedPeerIds } : {}),
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
  onChange: (patch: {
    assignedAgentId?: string | null;
    paused?: boolean;
    acceptUnlistedSenders?: boolean;
    allowedPeerIds?: string[];
  }) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const allowedPeerIds = connection.allowedPeerIds ?? [];
  const [acceptUnlisted, setAcceptUnlisted] = useState(connection.acceptUnlistedSenders === true);
  const [peerList, setPeerList] = useState(allowedPeerIds.join(", "));
  useEffect(() => {
    setAcceptUnlisted(connection.acceptUnlistedSenders === true);
    setPeerList((connection.allowedPeerIds ?? []).join(", "));
  }, [connection.acceptUnlistedSenders, connection.allowedPeerIds]);
  const assigneeValue = useMemo(
    () => (connection.assignedAgentId ? `agent:${connection.assignedAgentId}` : ""),
    [connection.assignedAgentId],
  );
  async function apply(patch: {
    assignedAgentId?: string | null;
    paused?: boolean;
    acceptUnlistedSenders?: boolean;
    allowedPeerIds?: string[];
  }) {
    setError(null);
    try {
      await onChange(patch);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <div style={card}>
      <div style={row}>
        <strong>{connection.displayName}</strong>
        {connection.username ? <span style={muted}>@{connection.username}</span> : null}
        <StatusBadge label={connection.live ? "Live" : "Offline"} status={connection.live ? "ok" : "warning"} />
        {connection.paused ? <StatusBadge label="Paused" status="pending" /> : null}
      </div>
      <div style={muted}>Incoming mode: dialog = task</div>
      <label style={{ display: "grid", gap: "var(--spacing)" }}>
        Answering agent
        <AssigneePicker
          companyId={companyId}
          value={assigneeValue}
          includeUsers={false}
          noneLabel="No answering agent"
          onChange={(_value, selection) => {
            void apply({ assignedAgentId: selection.assigneeAgentId });
          }}
        />
      </label>
      <label style={{ display: "grid", gap: "var(--spacing)" }}>
        <span>
          <input
            type="checkbox"
            checked={acceptUnlisted}
            onChange={(event) => setAcceptUnlisted(event.target.checked)}
          />
          {" "}
          Accept direct messages from any Telegram user
        </span>
      </label>
      <label style={{ display: "grid", gap: "var(--spacing)" }}>
        Allowed Telegram user ids
        <input
          style={input}
          value={peerList}
          onChange={(event) => setPeerList(event.target.value)}
        />
      </label>
      <div style={row}>
        <button
          type="button"
          style={button}
          onClick={() => void apply({
            acceptUnlistedSenders: acceptUnlisted,
            allowedPeerIds: peerList.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
          })}
        >
          Save senders
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div style={row}>
        <button
          type="button"
          style={button}
          onClick={() => void apply({ paused: !connection.paused })}
        >
          {connection.paused ? "Resume inbound" : "Pause inbound"}
        </button>
      </div>
    </div>
  );
}
