import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  AssigneePicker,
  StatusBadge,
  usePluginAction,
  usePluginData,
  usePluginStream,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { errorMessage, uiText } from "./locale.js";

export type PublicConnection = {
  telegramUserId: string;
  username: string | null;
  displayName: string;
  assignedAgentId: string | null;
  incomingMode: string;
  paused: boolean;
  live: boolean;
  hasSession: boolean;
  acceptUnlistedSenders?: boolean;
  allowedPeerIds?: string[];
};

type ConnectionCardPatch = {
  assignedAgentId?: string | null;
  paused?: boolean;
  acceptUnlistedSenders?: boolean;
  allowedPeerIds?: string[];
};

export type OverviewData = {
  pluginId: string;
  credentialsConfigured: boolean;
  connections: PublicConnection[];
};

type LoginStatus =
  | { state: "idle" }
  | { state: "qr_pending"; loginId: string; qr: { imageDataUrl: string } }
  | { state: "password_required"; loginId: string; hint: string | null; message?: string | null }
  | { state: "connected"; loginId: string; account: { telegramUserId: string; username: string | null; displayName: string } }
  | { state: "error"; loginId: string; message: string };

const layout: CSSProperties = {
  display: "grid",
  gap: "calc(var(--spacing) * 4)",
  maxWidth: "calc(var(--spacing) * 180)",
  fontFamily: "var(--font-sans)",
};

const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: "calc(var(--spacing) * 4)",
  display: "grid",
  gap: "calc(var(--spacing) * 3)",
  background: "var(--card, transparent)",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "calc(var(--spacing) * 2)",
  alignItems: "center",
};

const muted: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--muted-foreground)",
  lineHeight: 1.45,
};

const button: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--foreground)",
  padding: "calc(var(--spacing) * 1.5) calc(var(--spacing) * 3)",
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
  padding: "calc(var(--spacing) * 2) calc(var(--spacing) * 2.5)",
  background: "transparent",
  color: "var(--foreground)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

// The host preflight sets img { max-width: 100%; height: auto }. A fit-content
// frame makes that percentage cyclic, so the code collapses to 0×0. The size
// is an integer multiple of the SVG width so modules stay on whole pixels.
const QR_BOX_FALLBACK = 328;

const qrFrame: CSSProperties = {
  boxSizing: "content-box",
  padding: 16,
  background: "#ffffff",
  colorScheme: "light",
  borderRadius: 12,
};

const qrImage: CSSProperties = {
  display: "block",
  maxWidth: "none",
  maxHeight: "none",
  background: "#ffffff",
};

function qrBoxPixels(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  let svg = payload;
  try {
    svg = decodeURIComponent(payload);
  } catch {
    svg = payload;
  }
  const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 0);
  if (!Number.isFinite(width) || width < 32) return QR_BOX_FALLBACK;
  return width >= 240 ? width : width * 2;
}

type CacheStatus = {
  enabled: boolean;
  bytes: number;
  dialogs: number;
  avatars: number;
  maxBytes: number;
  updatedAt: string | null;
};

const CACHE_LIMITS = [16, 64, 256] as const;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function CacheSettings({ companyId }: { companyId: string | null }) {
  const cache = usePluginData<CacheStatus>("cache-status", companyId ? { companyId } : undefined);
  const saveCache = usePluginAction("cache-save");
  const clearCache = usePluginAction("cache-clear");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = cache.data;

  async function run(task: () => Promise<unknown>) {
    if (!companyId) return;
    setBusy(true);
    setError(null);
    try {
      await task();
      cache.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={card}>
      <strong>{uiText("Local cache")}</strong>
      <p style={muted}>
        {uiText("Dialogs and avatars are stored on this server and shown before Telegram answers.")}
      </p>
      {cache.loading && !status ? <p style={muted}>{uiText("Loading cache…")}</p> : null}
      {cache.error ? <p role="alert">{errorMessage(cache.error)}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {status ? (
        <>
          <div style={muted}>
            {status.enabled ? uiText("Cache is on") : uiText("Cache is off")}
            {" · "}
            {uiText("Used")} {formatBytes(status.bytes)} / {formatBytes(status.maxBytes)}
            {" · "}
            {uiText("Dialogs")} {status.dialogs}
            {" · "}
            {uiText("Avatars")} {status.avatars}
          </div>
          <div style={row}>
            <button
              type="button"
              style={status.enabled ? button : primaryButton}
              disabled={busy}
              onClick={() => void run(() => saveCache({ companyId, enabled: !status.enabled }))}
            >
              {status.enabled ? uiText("Turn cache off") : uiText("Turn cache on")}
            </button>
            <span style={muted}>{uiText("Limit")}</span>
            {CACHE_LIMITS.map((mb) => {
              const maxBytes = mb * 1024 * 1024;
              const selected = status.maxBytes === maxBytes;
              return (
                <button
                  key={mb}
                  type="button"
                  style={selected ? primaryButton : button}
                  disabled={busy || selected}
                  onClick={() => void run(() => saveCache({ companyId, maxBytes }))}
                >
                  {mb} MB
                </button>
              );
            })}
          </div>
          <div style={row}>
            <button type="button" style={button} disabled={busy} onClick={() => void run(() => clearCache({ companyId, scope: "avatars" }))}>
              {uiText("Clear avatars")}
            </button>
            <button type="button" style={button} disabled={busy} onClick={() => void run(() => clearCache({ companyId, scope: "dialogs" }))}>
              {uiText("Clear dialogs")}
            </button>
            <button type="button" style={button} disabled={busy} onClick={() => void run(() => clearCache({ companyId, scope: "all" }))}>
              {uiText("Clear cache")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
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
  const loginChannel = !companyId
    ? "telegram-login:none"
    : loginId
      ? `telegram-login:${companyId}:${loginId}`
      : `telegram-login:${companyId}`;
  const loginStream = usePluginStream<{ status?: LoginStatus }>(loginChannel, companyId ? { companyId } : undefined);

  const status = login.data ?? { state: "idle" as const };

  useEffect(() => {
    if (!loginStream.lastEvent) return;
    login.refresh();
    overview.refresh();
  }, [loginStream.lastEvent]);

  const loginRefresh = useRef(login.refresh);
  loginRefresh.current = login.refresh;
  useEffect(() => {
    const waiting = status.state === "qr_pending"
      || status.state === "password_required"
      || (Boolean(loginId) && status.state === "idle");
    if (!waiting) return undefined;
    const timer = setInterval(() => {
      loginRefresh.current();
    }, 1500);
    return () => clearInterval(timer);
  }, [status.state, loginId]);

  useEffect(() => {
    if (status.state === "connected" || status.state === "error") {
      setPassword("");
      overview.refresh();
    }
  }, [status.state]);

  useEffect(() => {
    if (status.state !== "qr_pending" && status.state !== "password_required") return;
    if (status.loginId && status.loginId !== loginId) setLoginId(status.loginId);
  }, [status, loginId]);

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

  const qrUrl = status.state === "qr_pending" && status.qr?.imageDataUrl ? status.qr.imageDataUrl : "";
  const qrBox = qrUrl ? qrBoxPixels(qrUrl) : 0;
  const hint = status.state === "password_required" ? status.hint : null;
  const passwordMessage = status.state === "password_required" ? status.message : null;

  return (
    <section aria-label={uiText("Connect Telegram")} style={layout}>
      <div>
        <h2 style={{ margin: 0, marginBottom: "calc(var(--spacing) * 1.5)", fontSize: "var(--text-xl)", fontFamily: "var(--font-sans)" }}>Telegram</h2>
        <p style={muted}>
          {uiText("Connect a personal Telegram account with QR login. Incoming direct messages become issues. Assign the answering agent on the connection; changing it does not require a new login.")}
        </p>
      </div>

      <div style={card}>
        <strong>{uiText("Connect Telegram")}</strong>
        {overview.data && !overview.data.credentialsConfigured ? (
          <p style={muted}>{uiText("Set Telegram api_id and api_hash in plugin settings before scanning a QR code.")}</p>
        ) : null}
        {status.state === "error" ? <p role="alert">{uiText(status.message)}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {qrUrl ? (
          <div style={{ ...qrFrame, width: qrBox, height: qrBox }}>
            <img
              src={qrUrl}
              alt={uiText("Telegram login QR code")}
              width={qrBox}
              height={qrBox}
              style={{ ...qrImage, width: qrBox, height: qrBox }}
            />
          </div>
        ) : null}
        {status.state === "qr_pending" ? (
          <p style={muted}>
            {uiText("The code refreshes on its own. Scan the image on screen now.")}
            {" "}
            {uiText("In Telegram open Settings, then Devices, then Link Desktop Device. The camera in a chat does not open this code.")}
          </p>
        ) : null}
        {status.state === "password_required" ? (
          <form onSubmit={onPassword} style={{ display: "grid", gap: "calc(var(--spacing) * 2)" }}>
            {passwordMessage ? <p role="alert">{uiText(passwordMessage)}</p> : null}
            <label>
              {uiText("Cloud password")}{hint ? ` (${hint})` : ""}
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
              <button type="button" style={button} onClick={() => void onCancel()}>
                {uiText("Cancel")}
              </button>
              <button type="submit" style={primaryButton} disabled={busy || password.length === 0}>
                {uiText("Continue")}
              </button>
            </div>
          </form>
        ) : (
          <div style={row}>
            {status.state === "qr_pending" ? (
              <button type="button" style={button} onClick={() => void onCancel()}>
                {uiText("Cancel")}
              </button>
            ) : null}
            <button type="button" style={primaryButton} onClick={() => void onConnect()} disabled={busy || !companyId}>
              {busy ? uiText("Starting…") : uiText("Connect Telegram")}
            </button>
          </div>
        )}
      </div>

      <div style={card}>
        <strong>{uiText("Connected accounts")}</strong>
        {overview.loading ? <p style={muted}>{uiText("Loading accounts…")}</p> : null}
        {overview.error ? <p role="alert">{errorMessage(overview.error)}</p> : null}
        {connections.length === 0 && !overview.loading && !overview.error ? (
          <p style={muted}>{uiText("No Telegram accounts connected yet.")}</p>
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
              if ("acceptUnlistedSenders" in patch || "allowedPeerIds" in patch) {
                await updateConnection({
                  companyId,
                  telegramUserId: connection.telegramUserId,
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

      <CacheSettings companyId={companyId} />
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
  onChange: (patch: ConnectionCardPatch) => Promise<void>;
}) {
  const [cardError, setCardError] = useState<string | null>(null);
  const allowedText = (connection.allowedPeerIds ?? []).join(" ");
  const [peerDraft, setPeerDraft] = useState(allowedText);
  useEffect(() => {
    setPeerDraft(allowedText);
  }, [allowedText]);
  const assigneeValue = useMemo(
    () => (connection.assignedAgentId ? `agent:${connection.assignedAgentId}` : ""),
    [connection.assignedAgentId],
  );
  async function apply(patch: ConnectionCardPatch) {
    setCardError(null);
    try {
      await onChange(patch);
    } catch (err) {
      setCardError(errorMessage(err));
    }
  }
  function commitPeers() {
    const next = peerDraft.split(/[\s,]+/).filter((item) => item.length > 0);
    if (next.join(" ") === allowedText) return;
    void apply({ allowedPeerIds: next });
  }
  return (
    <div style={{ ...card, padding: "calc(var(--spacing) * 3)" }}>
      <div style={row}>
        <strong>{connection.displayName}</strong>
        {connection.username ? <span style={muted}>@{connection.username}</span> : null}
        <StatusBadge label={uiText(connection.live ? "Live" : "Offline")} status={connection.live ? "ok" : "warning"} />
        {connection.paused ? <StatusBadge label={uiText("Paused")} status="pending" /> : null}
      </div>
      <div style={muted}>{uiText("Incoming mode: dialog = task")}</div>
      <label style={row}>
        <input
          type="checkbox"
          checked={Boolean(connection.acceptUnlistedSenders)}
          onChange={(event) => {
            void apply({ acceptUnlistedSenders: event.target.checked });
          }}
        />
        {uiText("Accept private chats from anyone")}
      </label>
      <label style={{ display: "grid", gap: "calc(var(--spacing) * 1.5)" }}>
        {uiText("Allowed user ids")}
        <input
          value={peerDraft}
          style={input}
          spellCheck={false}
          onChange={(event) => setPeerDraft(event.target.value)}
          onBlur={() => commitPeers()}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commitPeers();
          }}
        />
        <span style={muted}>{uiText("One id per word. Other private chats stay closed.")}</span>
      </label>
      <label style={{ display: "grid", gap: "calc(var(--spacing) * 1.5)" }}>
        {uiText("Answering agent")}
        <AssigneePicker
          companyId={companyId}
          value={assigneeValue}
          includeUsers={false}
          placeholder={uiText("No agent")}
          noneLabel={uiText("No agent")}
          searchPlaceholder={uiText("Search agents")}
          emptyMessage={uiText("No agents")}
          onChange={(_value, selection) => {
            void apply({ assignedAgentId: selection.assigneeAgentId });
          }}
        />
      </label>
      {cardError ? <p role="alert">{cardError}</p> : null}
      <div style={row}>
        <button
          type="button"
          style={button}
          onClick={() => void apply({ paused: !connection.paused })}
        >
          {uiText(connection.paused ? "Resume inbound" : "Pause inbound")}
        </button>
      </div>
    </div>
  );
}
