import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  AssigneePicker,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginStream,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  isTelegramMessageId,
  menuPosition,
  MORE_REACTIONS,
  QUICK_REACTIONS,
} from "../message-menu.js";
import {
  avatarPair,
  feedIsCompact,
  filterChats,
  formatClock,
  formatLastSeen,
  formatListTime,
  groupThread,
  initialLetter,
  keepShownPhoto,
  isNearBottom,
  issueRefFromPath,
  mergeThreadMessages,
  oldestNumericId,
  parseTime,
  rememberCacheKey,
  sameThreadTop,
  shellIsNarrow,
  shiftFeedRange,
  slideFeedRange,
  tailFeedRange,
  unreadLabel,
  type FeedRange,
} from "./inbox-model.js";

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
  | { state: "password_required"; loginId: string; hint: string | null; message?: string | null }
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

// The board stores the locale in localStorage. documentElement.lang stays "en".
const LOCALE_STORAGE_KEY = "paperclip.locale";

const RU: Record<string, string> = {
  "Connect Telegram": "Подключить Telegram",
  "Connect a personal Telegram account with QR login. Incoming direct messages become issues. Assign the answering agent on the connection; changing it does not require a new login.":
    "Подключите личный аккаунт Telegram по QR. Входящие личные сообщения становятся задачами. Отвечающего агента выбирают на подключении; чтобы сменить его, входить заново не нужно.",
  "Set Telegram api_id and api_hash in plugin settings before scanning a QR code.":
    "Сначала создайте секреты api_id и api_hash кнопкой «+» в полях ниже и нажмите «Сохранить конфигурацию». Значения берутся на my.telegram.org/apps. После сохранения нажмите «Подключить Telegram».",
  "Plugin config is missing apiId. Set Telegram api_id and api_hash in plugin settings.":
    "api_id ещё не сохранён. Создайте секреты api_id и api_hash кнопкой «+» в полях ниже и нажмите «Сохранить конфигурацию». Значения берутся на my.telegram.org/apps.",
  "Plugin config is missing apiHash. Set Telegram api_id and api_hash in plugin settings.":
    "api_hash ещё не сохранён. Создайте секреты api_id и api_hash кнопкой «+» в полях ниже и нажмите «Сохранить конфигурацию». Значения берутся на my.telegram.org/apps.",
  "Telegram login QR code": "QR-код входа в Telegram",
  "The code refreshes on its own. Scan the image on screen now.":
    "Код обновляется сам. Сканируйте картинку, которая на экране сейчас.",
  "In Telegram open Settings, then Devices, then Link Desktop Device. The camera in a chat does not open this code.":
    "В Telegram откройте Настройки → Устройства → Подключить устройство. Камера в чате этот код не открывает.",
  "Cloud password": "Облачный пароль",
  "Cloud password was not accepted.": "Облачный пароль не подошёл.",
  "Cloud password timed out.": "Время ввода облачного пароля вышло.",
  "Telegram login cancelled.": "Вход в Telegram отменён.",
  "Telegram login failed.": "Вход в Telegram не выполнен.",
  "Missing or unknown invocation scope": "Не задана или неизвестна область вызова.",
  "Activation failed: Missing or unknown invocation scope": "Активация не выполнена: не задана или неизвестна область вызова.",
  "Telegram session was empty after login.": "После входа сессия Telegram пустая.",
  "Telegram did not return the signed-in user.": "Telegram не вернул вошедшего пользователя.",
  "Continue": "Продолжить",
  "Cancel": "Отменить",
  "Starting…": "Запуск…",
  "Connected accounts": "Подключённые аккаунты",
  "Loading accounts…": "Загрузка аккаунтов…",
  "No Telegram accounts connected yet.": "Аккаунты Telegram ещё не подключены.",
  "Live": "Сейчас",
  "Offline": "Не в сети",
  "Paused": "На паузе",
  "Incoming mode: dialog = task": "Входящие: диалог = задача",
  "Answering agent": "Отвечающий агент",
  "No answering agent": "Без отвечающего агента",
  "Resume inbound": "Возобновить входящие",
  "Pause inbound": "Поставить входящие на паузу",
  "Something went wrong.": "Что-то пошло не так.",
  "No chats": "Нет чатов",
  Telegram: "Telegram",
  "Choose a chat": "Выберите чат",
  "Select a chat": "Выберите чат",
  Search: "Поиск",
  Today: "Сегодня",
  Yesterday: "Вчера",
  Back: "Назад",
  "No messages": "Сообщений нет",
  "The Telegram account is offline. Showing messages already saved on the task.": "Аккаунт Telegram не в сети. Показаны сообщения, которые уже лежат на задаче.",
  "Message": "Сообщение",
  "Forwarded": "Переслано",
  Send: "Отправить",
  Task: "Задача",
  You: "Вы",
  Photo: "Фото",
  File: "Файл",
  "Voice message": "Голосовое",
  Video: "Видео",
  Sticker: "Стикер",
  Location: "Геолокация",
  "User Info": "Информация",
  Close: "Закрыть",
  Phone: "Телефон",
  Username: "Имя пользователя",
  Bio: "О себе",
  Channel: "Канал",
  "Shared groups": "Общие группы",
  Reply: "Ответить",
  Copy: "Копировать",
  Pin: "Закрепить",
  Unpin: "Открепить",
  Forward: "Переслать",
  Select: "Выбрать",
  Delete: "Удалить",
  "Delete for me": "Удалить у меня",
  "Delete for everyone": "Удалить у всех",
  "More reactions": "Ещё реакции",
  "Message id is required.": "Нужен идентификатор сообщения.",
  "Unknown message action.": "Неизвестное действие.",
  "Reaction is unavailable.": "Такой реакции нет.",
  "Telegram reactions are unavailable.": "Реакции Telegram сейчас недоступны.",
  "Telegram pin is unavailable.": "Закрепление сейчас недоступно.",
  "Telegram delete is unavailable.": "Удаление сейчас недоступно.",
  "Telegram forward is unavailable.": "Пересылка сейчас недоступна.",
  online: "в сети",
  "last seen recently": "был(а) недавно",
  "last seen within a week": "был(а) на этой неделе",
  "last seen within a month": "был(а) в этом месяце",
  "last seen a long time ago": "был(а) давно",
  "Message text is required.": "Нужен текст сообщения.",
  "Message text is too long.": "Сообщение слишком длинное.",
  "This issue is not a Telegram dialog.": "Это не диалог Telegram.",
  "That Telegram account is not connected.": "Этот аккаунт Telegram не подключён.",
  "That Telegram account is not live in the plugin worker.": "Этот аккаунт Telegram сейчас не в сети.",
  "This text is a Paperclip operator note. Send one short plain customer reply with telegram_send_text. Do not include task ids, task links, task status, or the phrase «Ответил в Telegram».": "Это служебная заметка. Клиенту нужно короткое обычное сообщение без номеров задач, ссылок и фразы «Ответил в Telegram».",
};

function readUiLocale(): string {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return "";
    return storage.getItem(LOCALE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function isRuLocale(): boolean {
  return readUiLocale().toLowerCase().split("-")[0] === "ru";
}

function uiText(text: string): string {
  if (!isRuLocale()) return text;
  return RU[text] ?? text;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return uiText(error.message);
  }
  return error instanceof Error ? uiText(error.message) : uiText("Something went wrong.");
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
    if (status.state === "connected" || status.state === "error") {
      setPassword("");
      overview.refresh();
    }
  }, [status.state]);

  useEffect(() => {
    if (status.state !== "qr_pending" && status.state !== "password_required") return;
    if (status.loginId && status.loginId !== loginId) setLoginId(status.loginId);
  }, [status, loginId]);

  useEffect(() => {
    if (status.state !== "qr_pending" && status.state !== "password_required") return;
    const timer = window.setInterval(() => {
      login.refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status.state, login.refresh]);

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
        <h2 style={{ margin: "0 0 6px", fontSize: "20px" }}>Telegram</h2>
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
          <form onSubmit={onPassword} style={{ display: "grid", gap: "8px" }}>
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
              <button type="submit" style={primaryButton} disabled={busy || password.length === 0}>
                {uiText("Continue")}
              </button>
              <button type="button" style={button} onClick={() => void onCancel()}>
                {uiText("Cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div style={row}>
            <button type="button" style={primaryButton} onClick={() => void onConnect()} disabled={busy || !companyId}>
              {busy ? uiText("Starting…") : uiText("Connect Telegram")}
            </button>
            {status.state === "qr_pending" ? (
              <button type="button" style={button} onClick={() => void onCancel()}>
                {uiText("Cancel")}
              </button>
            ) : null}
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
        <StatusBadge label={uiText(connection.live ? "Live" : "Offline")} status={connection.live ? "ok" : "warning"} />
        {connection.paused ? <StatusBadge label={uiText("Paused")} status="pending" /> : null}
      </div>
      <div style={muted}>{uiText("Incoming mode: dialog = task")}</div>
      <label style={{ display: "grid", gap: "6px" }}>
        {uiText("Answering agent")}
        <AssigneePicker
          companyId={companyId}
          value={assigneeValue}
          includeUsers={false}
          noneLabel={uiText("No answering agent")}
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
          {uiText(connection.paused ? "Resume inbound" : "Pause inbound")}
        </button>
      </div>
    </div>
  );
}

type PresenceView = { code?: string | null; at?: string | null } | null;

type TelegramChatRow = {
  issueId: string;
  identifier: string | null;
  label: string;
  status: string;
  updatedAt: string;
  preview?: string | null;
  unread?: number | null;
  photo?: string | null;
  presence?: PresenceView;
};

const chatLink: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "0 8px",
  padding: "6px 8px",
  borderRadius: 8,
  color: "inherit",
  textDecoration: "none",
  fontSize: "var(--text-compact, 13px)",
  fontWeight: 500,
  minWidth: 0,
};

const chatLabel: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

function instanceLabel(displayName: string): string {
  const name = displayName.trim();
  if (!name || /^\d{5,}$/.test(name)) return uiText("Telegram");
  return name;
}

export function TelegramChatsNav({
  context,
}: {
  context?: { companyId?: string | null; companyPrefix?: string | null } | null;
}) {
  const companyId = context?.companyId ?? "";
  const prefix = context?.companyPrefix ?? "";
  const navigation = useHostNavigation();
  const overview = usePluginData<OverviewData>(
    "overview",
    companyId ? { companyId } : undefined,
  );
  const refreshOverview = useRef(overview.refresh);
  refreshOverview.current = overview.refresh;
  useEffect(() => {
    if (!companyId) return undefined;
    const timer = window.setInterval(() => refreshOverview.current(), 20000);
    return () => window.clearInterval(timer);
  }, [companyId]);
  const accounts = overview.data?.connections ?? [];
  if (!companyId || !prefix || overview.error) return null;
  if (accounts.length === 0) {
    if (overview.loading) return null;
    return <div style={{ ...chatLink, opacity: 0.6 }}>{uiText("No chats")}</div>;
  }
  return (
    <div style={{ display: "grid", gap: 2 }}>
      {accounts.map((account) => {
        const label = instanceLabel(account.displayName);
        return (
          <a
            key={account.telegramUserId}
            {...navigation.linkProps(`/${prefix}/telegram-inbox`)}
            style={chatLink}
            title={label}
          >
            <span style={{ fontSize: 10, opacity: 0.6, width: 16, flex: "0 0 auto" }}>TG</span>
            <span style={chatLabel}>{label}</span>
          </a>
        );
      })}
    </div>
  );
}

type ChatBubbleView = {
  id: string;
  direction: "in" | "out";
  text: string;
  at: string;
  forward?: { kind?: string | null; name?: string | null; author?: string | null } | null;
};

type ChatThreadData = {
  found?: boolean;
  live?: boolean;
  hasMore?: boolean;
  label?: string;
  issueId?: string;
  identifier?: string | null;
  photo?: string | null;
  presence?: PresenceView;
  messages?: ChatBubbleView[];
};

type ThreadView = {
  messages: ChatBubbleView[];
  live: boolean;
  label: string;
  photo: string | null;
  presence: PresenceView;
  hasMore: boolean;
  exhausted: boolean;
  issueId: string;
  identifier: string | null;
};

const threadCache = new Map<string, ThreadView>();
const threadCacheOrder: string[] = [];
const streamAhead = new Map<string, ChatBubbleView[]>();
const THREAD_CACHE_LIMIT = 8;

function storeThread(key: string, view: ThreadView) {
  threadCache.set(key, view);
  const evicted = rememberCacheKey(threadCacheOrder, key, THREAD_CACHE_LIMIT);
  if (evicted) {
    threadCache.delete(evicted);
    streamAhead.delete(evicted);
  }
}

function queueStreamBubble(key: string, bubble: ChatBubbleView) {
  streamAhead.set(key, mergeThreadMessages(streamAhead.get(key) ?? [], [bubble]));
}

function absorbStreamAhead(key: string, messages: ChatBubbleView[]): ChatBubbleView[] {
  const ahead = streamAhead.get(key);
  if (!ahead?.length) return messages;
  streamAhead.delete(key);
  return mergeThreadMessages(messages, ahead);
}

type ChatProfileData = {
  found?: boolean;
  name?: string;
  username?: string | null;
  phone?: string | null;
  about?: string | null;
  photo?: string | null;
  presence?: PresenceView;
  channel?: string | null;
  sharedChats?: number | null;
};

type InboxStreamEvent = {
  companyId?: string;
  kind?: string;
  issueRef?: string;
  bubble?: ChatBubbleView;
  messageIds?: string[];
  preview?: string;
  unread?: number;
  activityAt?: string;
  photo?: string | null;
};

type RowPatch = {
  preview?: string | null;
  unread?: number;
  updatedAt?: string;
  photo?: string | null;
};

function bubbleNode(element: HTMLElement, id: string): HTMLElement | null {
  const nodes = element.querySelectorAll<HTMLElement>("[data-mid]");
  for (const node of nodes) {
    if (node.dataset.mid === id) return node;
  }
  return null;
}

function captureFeedAnchor(element: HTMLElement): { id: string; offset: number } | null {
  const rootTop = element.getBoundingClientRect().top;
  const nodes = element.querySelectorAll<HTMLElement>("[data-mid]");
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= rootTop + 1) continue;
    const id = node.dataset.mid;
    if (!id) continue;
    return { id, offset: rect.top - rootTop };
  }
  return null;
}

const TG_CSS = `
.tg-shell {
  box-sizing: border-box;
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  height: calc(100dvh - 108px);
  margin: 0;
  border: 1px solid #101010;
  border-radius: 12px;
  background: #0e0e0e;
  color: #ffffff;
  color-scheme: dark;
  font-family: Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif;
  font-size: 16px;
  font-weight: 400;
  line-height: 1.3125;
  --surface-color: #212121;
  --background-color: #181818;
  --body-background-color: #181818;
  --border-color: #0f0f0f;
  --primary-color: #8774e1;
  --primary-text-color: #ffffff;
  --secondary-text-color: #aaaaaa;
  --secondary-color: #707579;
  --danger-color: #ff595a;
  --input-search-border-color: #2f2f2f;
  --message-highlighting-color: hsla(299.14, 44.17%, 37.47%, 0.4);
  --message-out-time-color: #fff9;
}
.tg-shell *,
.tg-shell *::before,
.tg-shell *::after { box-sizing: border-box; }
.tg-shell button,
.tg-shell input,
.tg-shell textarea {
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  color: inherit;
}
.tg-shell a { color: inherit; text-decoration: none; }
.tg-shell svg { display: block; max-width: none; }
.tg-list {
  flex: 0 0 360px;
  width: 360px;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #212121;
  border-right: 1px solid #0f0f0f;
}
.tg-shell.is-narrow .tg-list {
  flex: 1 1 auto;
  width: 100%;
  border-right: 0;
}
.tg-thread {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #0e0e0e;
}
.tg-search { flex: 0 0 auto; padding: 8px 10px; }
.tg-search-field { position: relative; display: block; height: 36px; }
.tg-search-icon {
  position: absolute;
  left: 10px;
  top: 8px;
  width: 20px;
  height: 20px;
  color: #8d8d8d;
  pointer-events: none;
}
.tg-search-icon svg { width: 20px; height: 20px; }
.tg-search-input {
  width: 100%;
  height: 36px;
  border-radius: 18px;
  border: 0;
  background: #181818;
  color: #ffffff;
  padding: 0 12px 0 36px;
  font-size: 15px;
  outline: none;
}
.tg-search-input::placeholder { color: #8d8d8d; }
.tg-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.tg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 6px 12px;
  color: inherit;
  text-decoration: none;
}
.tg-row:hover { background: rgba(255, 255, 255, 0.04); }
.tg-row.is-selected,
.tg-row.is-selected:hover { background: rgba(255, 255, 255, 0.08); }
.tg-row.is-selected .tg-badge { background: #8774e1; color: #ffffff; }
.tg-avatar {
  position: relative;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #ffffff;
  font-size: 16px;
  font-weight: 500;
  line-height: 1;
  background-size: cover;
  background-position: center;
}
.tg-avatar.has-photo { color: transparent; }
.tg-online {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border-radius: 50%;
  background: #0ac630;
  border: 2px solid #0e0e0e;
}
.tg-avatar svg { width: 22px; height: 22px; }
.tg-avatar-top {
  width: 34px;
  height: 34px;
  flex-basis: 34px;
  font-size: 14px;
}
.tg-avatar-top svg { width: 18px; height: 18px; }
.tg-row-body { flex: 1 1 auto; min-width: 0; }
a.tg-row-body { color: inherit; text-decoration: none; }
.tg-row-top,
.tg-row-bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.tg-row-bottom { margin-top: 2px; }
.tg-row-name,
.tg-row-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-row-name { font-size: 15px; font-weight: 500; color: #ffffff; }
.tg-row-preview { font-size: 14px; font-weight: 400; color: #8d8d8d; }
.tg-row-time { flex-shrink: 0; font-size: 12px; font-weight: 400; color: #8d8d8d; }
.tg-badge {
  flex-shrink: 0;
  box-sizing: border-box;
  height: 22px;
  min-width: 22px;
  padding: 0 7px;
  border-radius: 11px;
  background: #8774e1;
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  text-align: center;
}
.tg-list-empty,
.tg-empty {
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  min-height: 0;
  color: #aaaaaa;
  font-size: 14px;
  font-weight: 400;
  text-align: center;
  padding: 16px;
}
.tg-topbar {
  flex: 0 0 48px;
  height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: #212121;
  border-bottom: 1px solid #0f0f0f;
}
.tg-back {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: grid;
  place-items: center;
  color: #ffffff;
  background: transparent;
  border: 0;
  padding: 0;
}
.tg-peer-btn,
.tg-avatar-btn {
  border: 0;
  background: transparent;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.tg-avatar-btn { border-radius: 50%; line-height: 0; }
.tg-peer-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}
.tg-peer-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.tg-peer-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 16px;
  font-weight: 500;
  color: #ffffff;
}
.tg-peer-status {
  font-size: 13px;
  font-weight: 400;
  color: #8d8d8d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-peer-status.is-online { color: #0ac630; }
.tg-info-scrim {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 18px 12px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.55);
}
.tg-info {
  width: min(380px, 100%);
  max-height: calc(100% - 8px);
  overflow: auto;
  border-radius: 16px;
  background: #212121;
  color: #ffffff;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.tg-info-bar {
  height: 52px;
  display: flex;
  align-items: center;
  padding: 0 4px;
}
.tg-info-close {
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 20px;
  background: transparent;
  color: #ffffff;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.tg-info-title {
  flex: 1 1 auto;
  margin-right: 40px;
  text-align: center;
  font-size: 16px;
  font-weight: 500;
}
.tg-info-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 16px 18px;
}
.tg-avatar-hero {
  width: 120px;
  height: 120px;
  flex-basis: 120px;
  font-size: 42px;
}
.tg-avatar-hero svg { width: 56px; height: 56px; }
.tg-avatar-hero .tg-online { width: 18px; height: 18px; border-width: 3px; }
.tg-info-name {
  max-width: 100%;
  font-size: 20px;
  font-weight: 500;
  text-align: center;
  overflow-wrap: anywhere;
}
.tg-info-seen { font-size: 14px; color: #aaaaaa; }
.tg-info-seen.is-online { color: #0ac630; }
.tg-info-block { padding: 8px 16px 14px; }
.tg-info-value {
  font-size: 15px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.tg-info-label { margin-top: 2px; font-size: 13px; color: #8d8d8d; }
.tg-shell a.tg-task {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 400;
  color: #aaaaaa;
}
.tg-offline {
  flex: 0 0 auto;
  padding: 6px 12px;
  background: #212121;
  color: #aaaaaa;
  font-size: 13px;
}
.tg-feed {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 8px;
  overflow-anchor: none;
  background-color: #0e0e0e;
  background-image: radial-gradient(rgba(255, 255, 255, 0.045) 0.6px, transparent 0.7px);
  background-size: 22px 22px;
}
.tg-history {
  position: sticky;
  top: 8px;
  z-index: 3;
  height: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.tg-history i {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-top-color: #ffffff;
  animation: tg-spin 0.7s linear infinite;
}
@keyframes tg-spin { to { transform: rotate(360deg); } }
.tg-day { display: flex; flex-direction: column; width: 100%; }
.tg-date {
  position: sticky;
  top: 6px;
  z-index: 2;
  align-self: center;
  margin: 6px 0 10px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #d6d6d6;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
}
.tg-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 0 0 8px;
  max-width: 100%;
}
.tg-group.out { align-items: flex-end; }
.tg-bubble {
  width: fit-content;
  max-width: min(480px, 78%);
  padding: 6px 10px 5px;
  border-radius: 16px;
  color: #ffffff;
  font-size: 15px;
  font-weight: 400;
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tg-feed.is-compact .tg-bubble { max-width: calc(100% - 24px); }
.tg-bubble.in { background: #212121; }
.tg-bubble.out { background: #766ac8; margin-inline-start: auto; }
.tg-bubble.in.first { border-bottom-left-radius: 5px; }
.tg-bubble.in.middle { border-top-left-radius: 5px; border-bottom-left-radius: 5px; }
.tg-bubble.in.last { border-top-left-radius: 5px; }
.tg-bubble.out.first { border-bottom-right-radius: 5px; }
.tg-bubble.out.middle { border-top-right-radius: 5px; border-bottom-right-radius: 5px; }
.tg-bubble.out.last { border-top-right-radius: 5px; }
.tg-bubble-time {
  float: right;
  margin: 5px 0 -2px 10px;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
.tg-forward {
  display: block;
  margin: 0 0 3px;
  padding-left: 7px;
  border-left: 2px solid #8774e1;
  color: #c4b5fd;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
}
.tg-bubble.out .tg-forward {
  border-left-color: rgba(255, 255, 255, 0.9);
  color: #ffffff;
}
.tg-bubble.in .tg-bubble-time { color: #9a9a9a; }
.tg-bubble.out .tg-bubble-time { color: rgba(255, 255, 255, 0.72); }
.tg-composer-wrap {
  flex: 0 0 auto;
  background: #212121;
  border-top: 1px solid #101010;
  padding: 8px 10px;
}
.tg-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.tg-composer-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 40px;
  max-height: 160px;
  border: 0;
  border-radius: 20px;
  background: #181818;
  color: #ffffff;
  padding: 9px 14px;
  resize: none;
  outline: none;
  overflow-y: hidden;
  font-size: 15px;
}
.tg-composer-input::placeholder { color: #aaaaaa; }
.tg-send {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  display: grid;
  place-items: center;
  background: #766ac8;
  color: #ffffff;
  cursor: pointer;
}
.tg-send:disabled { background: #3a3a3a; color: #9a9a9a; cursor: default; }
.tg-send-error {
  color: #ff595a;
  font-size: 13px;
  padding: 2px 8px 4px;
}
.tg-reply {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 4px 6px;
  padding: 4px 4px 4px 8px;
  border-left: 2px solid #8774e1;
  color: #ffffff;
}
.tg-reply-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #d6d6d6;
}
.tg-reply-x {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: #aaaaaa;
  cursor: pointer;
}
.tg-selectbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #212121;
  border-top: 1px solid #101010;
}
.tg-selectbar span { flex: 1 1 auto; text-align: center; font-size: 14px; }
.tg-selectbar button {
  border: 0;
  background: transparent;
  color: #ffffff;
  font-size: 14px;
  cursor: pointer;
}
.tg-selectbar button:disabled { color: #6a6a6a; cursor: default; }
.tg-selectbar button.is-danger { color: #ff595a; }
.tg-bubble { cursor: default; }
.tg-bubble.is-picked { outline: 2px solid #8774e1; }
.tg-react-badge {
  display: inline-block;
  margin: 4px 0 0 6px;
  padding: 0 6px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.28);
  font-size: 14px;
  line-height: 20px;
}
.tg-menu-scrim { position: absolute; inset: 0; z-index: 20; }
.tg-menu-stack {
  position: absolute;
  z-index: 21;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 220px;
}
.tg-reacts {
  display: flex;
  align-items: center;
  gap: 0;
  height: 44px;
  padding: 0 4px;
  border-radius: 22px;
  background: rgba(32, 32, 34, 0.98);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.tg-reacts button, .tg-react-grid button {
  border: 0;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  font-size: 22px;
  line-height: 1;
}
.tg-reacts button { width: 26px; height: 36px; padding: 0; }
.tg-reacts button:hover, .tg-react-grid button:hover, .tg-menu button:hover { background: rgba(255, 255, 255, 0.08); }
.tg-react-more {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}
.tg-react-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 2px;
  padding: 8px;
  border-radius: 16px;
  background: rgba(32, 32, 34, 0.98);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.tg-react-grid button { height: 36px; }
.tg-menu {
  border-radius: 12px;
  background: rgba(32, 32, 34, 0.98);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  padding: 6px 0;
  overflow: hidden;
}
.tg-menu button {
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: #ffffff;
  font-size: 15px;
  cursor: pointer;
  text-align: start;
}
.tg-menu button.is-danger, .tg-menu button.is-danger svg { color: #ff595a; }
.tg-menu button:disabled { color: #6a6a6a; cursor: default; }
.tg-menu svg { flex: 0 0 20px; }
.tg-forward-list { max-height: 240px; overflow-y: auto; }
`;

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16.5 20 20.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function MenuIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.1" fill="currentColor" />
      <path fill="currentColor" d="M5.8 18.4c.9-2.7 3.1-4.1 6.2-4.1s5.3 1.4 6.2 4.1c.2.5-.2.9-.7.9H6.5c-.5 0-.9-.4-.7-.9z" />
    </svg>
  );
}

function forwardLine(forward: { kind?: string | null; name?: string | null; author?: string | null }): string {
  const clean = (value: string | null | undefined) => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    if (!text || /^\d+$/.test(text)) return "";
    return text.slice(0, 128);
  };
  const name = clean(forward.name);
  const author = clean(forward.author);
  const fromPlace = forward.kind === "channel" || forward.kind === "chat";
  if (!name) return uiText("Forwarded");
  const line = fromPlace
    ? (isRuLocale() ? `Переслано из ${name}` : `Forwarded from ${name}`)
    : (isRuLocale() ? `Переслано от ${name}` : `Forwarded from ${name}`);
  if (!author || !fromPlace) return line;
  return `${line}, ${author}`;
}

function genericName(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === "Telegram" || /^\d{5,}$/.test(trimmed);
}

function safePhoto(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("data:image/") || value.length > 480_000) return null;
  if (/[\s"'()]/.test(value)) return null;
  return value;
}

function presenceText(presence: PresenceView, ru: boolean): string {
  const code = presence?.code ?? "";
  if (code === "online") return uiText("online");
  if (code === "recently") return uiText("last seen recently");
  if (code === "last_week") return uiText("last seen within a week");
  if (code === "last_month") return uiText("last seen within a month");
  if (code === "offline") {
    const at = presence?.at ? parseTime(presence.at) : null;
    if (!at) return uiText("last seen a long time ago");
    return formatLastSeen(at, ru);
  }
  return "";
}

function Avatar({
  id,
  name,
  photo,
  topbar = false,
  hero = false,
  online = false,
}: {
  id: string;
  name: string;
  photo?: string | null;
  topbar?: boolean;
  hero?: boolean;
  online?: boolean;
}) {
  const generic = genericName(name);
  const [from, to] = avatarPair(id || name);
  const src = safePhoto(photo);
  const size = hero ? "tg-avatar tg-avatar-hero" : topbar ? "tg-avatar tg-avatar-top" : "tg-avatar";
  return (
    <span
      className={src ? `${size} has-photo` : size}
      style={{ backgroundImage: src ? `url("${src}")` : `linear-gradient(to bottom, ${from}, ${to})` }}
      aria-hidden="true"
    >
      {src ? null : generic ? <PersonIcon /> : initialLetter(name)}
      {online ? <span className="tg-online" /> : null}
    </span>
  );
}

function resizeComposer(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const parsedLine = Number.parseFloat(style.lineHeight);
  const line = Number.isFinite(parsedLine) ? parsedLine : fontSize * 1.3125;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const max = line * 8 + padding;
  const next = Math.min(Math.max(element.scrollHeight, 40), max);
  element.style.height = `${next}px`;
  element.style.overflowY = element.scrollHeight > max + 1 ? "auto" : "hidden";
}

function isHostBack(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const link = element instanceof HTMLAnchorElement ? element : element.querySelector("a");
  if (!(link instanceof HTMLAnchorElement)) return false;
  const text = (link.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text !== "Back" && text !== "Назад") return false;
  return /\/dashboard\/?$/.test(link.getAttribute("href") ?? "");
}

function hideHostBack(shell: HTMLElement): () => void {
  const hidden: HTMLElement[] = [];
  let node: HTMLElement | null = shell;
  for (let depth = 0; node && depth < 8; depth += 1) {
    let previous = node.previousElementSibling;
    while (previous) {
      if (isHostBack(previous)) {
        previous.style.display = "none";
        hidden.push(previous);
      }
      previous = previous.previousElementSibling;
    }
    node = node.parentElement;
  }
  return () => {
    for (const element of hidden) element.style.display = "";
  };
}

function useObservedWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return undefined;
    const read = (next: number) => {
      setWidth((current) => (current === next ? current : next));
    };
    read(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      read(entries[0]?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

type MessageMenuState = {
  ids: string[];
  text: string;
  x: number;
  y: number;
  page: "menu" | "delete" | "forward" | "reactions";
};

export function TelegramInboxPage({
  context,
}: {
  context?: { companyId?: string | null; companyPrefix?: string | null } | null;
}) {
  const companyId = context?.companyId ?? "";
  const prefix = context?.companyPrefix ?? "";
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const issueRef = issueRefFromPath(prefix, location.pathname);
  const inboxStream = usePluginStream<InboxStreamEvent>(
    "telegram-inbox",
    companyId ? { companyId } : undefined,
  );
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const [feed, setFeed] = useState<HTMLDivElement | null>(null);
  const shellWidth = useObservedWidth(shell);
  const feedWidth = useObservedWidth(feed);
  const narrow = shellIsNarrow(shellWidth);
  const chats = usePluginData<{ chats?: TelegramChatRow[] }>(
    "chats",
    companyId ? { companyId } : undefined,
  );
  const thread = usePluginData<ChatThreadData>(
    "chat-thread",
    companyId && issueRef ? { companyId, issueRef } : undefined,
  );
  const cacheKey = companyId && issueRef ? `${companyId}:${issueRef}` : "";
  const [transcript, setTranscript] = useState<ThreadView | null>(() => (cacheKey ? threadCache.get(cacheKey) ?? null : null));
  const [readyKey, setReadyKey] = useState("");
  const [olderBefore, setOlderBefore] = useState<string | null>(null);
  const older = usePluginData<ChatThreadData>(
    "chat-thread",
    companyId && issueRef ? { companyId, issueRef, beforeId: olderBefore ?? "0" } : undefined,
  );
  const [profileRef, setProfileRef] = useState<string | null>(null);
  const profile = usePluginData<ChatProfileData>(
    "chat-profile",
    companyId && profileRef ? { companyId, issueRef: profileRef } : undefined,
  );
  const sendReply = usePluginAction("send-chat-reply");
  const menuAction = usePluginAction("chat-message-menu");
  const refreshThread = useRef(thread.refresh);
  const refreshChats = useRef(chats.refresh);
  const refreshProfile = useRef(profile.refresh);
  refreshThread.current = thread.refresh;
  refreshChats.current = chats.refresh;
  refreshProfile.current = profile.refresh;
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [rowPatches, setRowPatches] = useState<Record<string, RowPatch>>({});
  const shownListPhotos = useRef<Record<string, string>>({});
  const [feedRange, setFeedRange] = useState<FeedRange | null>(null);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MessageMenuState | null>(null);
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reactions, setReactions] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState<string[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef(transcript);
  const olderBeforeRef = useRef(olderBefore);
  const sawLoading = useRef(false);
  const olderSeen = useRef("");
  const stickRef = useRef(true);
  const holdScroll = useRef<{ height: number; top: number } | null>(null);
  const pendingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const feedNode = useRef<HTMLDivElement | null>(null);
  const feedRangeRef = useRef(feedRange);
  const requestOlderRef = useRef(() => {});
  const hiddenIds = useRef(new Set<string>());
  const seenStream = useRef<InboxStreamEvent | null>(null);
  transcriptRef.current = transcript;
  olderBeforeRef.current = olderBefore;
  feedNode.current = feed;
  feedRangeRef.current = feedRange;
  requestOlderRef.current = () => {
    const view = transcriptRef.current;
    const element = feedNode.current;
    if (!view || !view.hasMore || view.exhausted || olderBeforeRef.current || !element) return;
    if (feedRangeRef.current && feedRangeRef.current.start > 0) return;
    const id = oldestNumericId(view.messages);
    if (!id) return;
    if (feedRangeRef.current) {
      pendingAnchor.current = captureFeedAnchor(element);
      holdScroll.current = null;
    } else {
      holdScroll.current = { height: element.scrollHeight, top: element.scrollTop };
    }
    olderBeforeRef.current = id;
    setOlderBefore(id);
  };
  const messages = (transcript?.messages ?? []).filter((item) => !hiddenIds.current.has(item.id));
  const visibleMessages = feedRange ? messages.slice(feedRange.start, feedRange.end) : messages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const ru = isRuLocale();
  const now = new Date();
  const streamConnected = inboxStream.connected;

  useEffect(() => {
    const event = inboxStream.lastEvent;
    if (!event || event === seenStream.current) return;
    seenStream.current = event;
    if (event.companyId && companyId && event.companyId !== companyId) return;
    if (event.kind === "gap") {
      refreshThread.current();
      refreshChats.current();
      return;
    }
    const ref = event.issueRef ?? "";
    if (!ref) return;
    if (event.preview != null || event.activityAt || event.photo !== undefined || typeof event.unread === "number") {
      setRowPatches((current) => ({
        ...current,
        [ref]: {
          ...current[ref],
          preview: event.preview ?? current[ref]?.preview,
          unread: typeof event.unread === "number" ? event.unread : current[ref]?.unread,
          updatedAt: event.activityAt || current[ref]?.updatedAt,
          photo: event.photo === undefined ? current[ref]?.photo : keepShownPhoto(current[ref]?.photo, event.photo),
        },
      }));
    }
    const key = companyId ? `${companyId}:${ref}` : "";
    if (!key) return;
    if (event.kind === "delete" && event.messageIds?.length) {
      const drop = new Set(event.messageIds);
      for (const id of event.messageIds) hiddenIds.current.add(id);
      const base = threadCache.get(key);
      if (!base) return;
      const next = { ...base, messages: base.messages.filter((item) => !drop.has(item.id)) };
      storeThread(key, next);
      if (key === cacheKey) setTranscript(next);
      return;
    }
    if (event.kind === "message" && event.bubble) {
      const base = threadCache.get(key);
      if (!base) {
        queueStreamBubble(key, event.bubble);
        return;
      }
      const next = {
        ...base,
        messages: absorbStreamAhead(key, mergeThreadMessages(base.messages, [event.bubble])).filter((item) => !hiddenIds.current.has(item.id)),
      };
      storeThread(key, next);
      if (key === cacheKey) {
        setTranscript(next);
        if (stickRef.current) setFeedRange(tailFeedRange(next.messages.length));
      }
    }
  }, [inboxStream.lastEvent, companyId, cacheKey]);

  useEffect(() => {
    if (!companyId || !issueRef || streamConnected) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshThread.current();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [companyId, issueRef, streamConnected]);

  useEffect(() => {
    if (!companyId) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshChats.current();
    }, 20000);
    return () => window.clearInterval(timer);
  }, [companyId]);

  useEffect(() => {
    if (!profileRef) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileRef(null);
    };
    window.addEventListener("keydown", onKey);
    const timer = window.setInterval(() => {
      if (!document.hidden) refreshProfile.current();
    }, 20000);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearInterval(timer);
    };
  }, [profileRef]);

  useLayoutEffect(() => {
    if (!shell) return undefined;
    const restore = hideHostBack(shell);
    const fit = () => {
      const top = shell.getBoundingClientRect().top;
      if (top <= 0 || top > window.innerHeight * 0.6) return;
      const next = Math.max(320, Math.round(window.innerHeight - top - 16));
      shell.style.height = `${next}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      shell.style.height = "";
      restore();
    };
  }, [shell]);

  useLayoutEffect(() => {
    sawLoading.current = false;
    olderSeen.current = "";
    stickRef.current = true;
    holdScroll.current = null;
    pendingAnchor.current = null;
    const cached = cacheKey ? threadCache.get(cacheKey) ?? null : null;
    setTranscript(cached);
    setReadyKey(cached ? cacheKey : "");
    setFeedRange(tailFeedRange(cached?.messages.length ?? 0));
    setOlderBefore(null);
    hiddenIds.current = new Set();
    setDraft("");
    setMenu(null);
    setReply(null);
    setSelecting(false);
    setSelected([]);
    setReactions({});
    setPinned([]);
  }, [cacheKey]);

  useEffect(() => {
    if (!cacheKey) return;
    if (thread.loading) {
      sawLoading.current = true;
      return;
    }
    if (!sawLoading.current || !thread.data) return;
    if (thread.data.found === false) {
      const empty: ThreadView = {
        messages: [],
        live: false,
        label: "",
        photo: null,
        presence: null,
        hasMore: false,
        exhausted: true,
        issueId: "",
        identifier: null,
      };
      storeThread(cacheKey, empty);
      setTranscript(empty);
      setReadyKey(cacheKey);
      return;
    }
    const incoming = thread.data.messages ?? [];
    const incomingHasMore = typeof thread.data.hasMore === "boolean" ? thread.data.hasMore : incoming.length >= 40;
    const cached = threadCache.get(cacheKey);
    const ahead = streamAhead.get(cacheKey) ?? [];
    if (!streamConnected && cached && ahead.length === 0 && sameThreadTop(cached.messages, incoming)) {
      const next: ThreadView = {
        ...cached,
        live: thread.data.live !== false,
        label: thread.data.label || cached.label,
        photo: thread.data.photo ?? cached.photo,
        presence: thread.data.presence ?? cached.presence,
        issueId: thread.data.issueId || cached.issueId,
        identifier: thread.data.identifier ?? cached.identifier,
      };
      storeThread(cacheKey, next);
      setTranscript(next);
      setReadyKey(cacheKey);
      return;
    }
    const base = threadCache.get(cacheKey) ?? transcriptRef.current;
    const next: ThreadView = {
      messages: absorbStreamAhead(cacheKey, mergeThreadMessages(base?.messages ?? [], incoming)).filter((item) => !hiddenIds.current.has(item.id)),
      live: thread.data.live !== false,
      label: thread.data.label || base?.label || "",
      photo: thread.data.photo ?? base?.photo ?? null,
      presence: thread.data.presence ?? base?.presence ?? null,
      hasMore: base?.exhausted ? false : incomingHasMore,
      exhausted: base?.exhausted ?? false,
      issueId: thread.data.issueId || base?.issueId || "",
      identifier: thread.data.identifier ?? base?.identifier ?? null,
    };
    storeThread(cacheKey, next);
    setTranscript(next);
    setReadyKey(cacheKey);
  }, [cacheKey, thread.loading, thread.data, streamConnected]);

  useEffect(() => {
    if (!olderBefore || !cacheKey) return;
    if (older.loading) {
      olderSeen.current = olderBefore;
      return;
    }
    if (olderSeen.current !== olderBefore || !older.data) return;
    const page = older.data.messages ?? [];
    const element = feedNode.current;
    if (element && feedRangeRef.current) pendingAnchor.current = captureFeedAnchor(element);
    setTranscript((current) => {
      const base = current ?? threadCache.get(cacheKey) ?? null;
      if (!base) return current;
      const merged = mergeThreadMessages(base.messages, page).filter((item) => !hiddenIds.current.has(item.id));
      const exhausted = page.length < 40 || merged.length === base.messages.length;
      const next: ThreadView = {
        ...base,
        messages: merged,
        hasMore: !exhausted && base.hasMore,
        exhausted: exhausted || base.exhausted,
      };
      storeThread(cacheKey, next);
      setFeedRange((range) => shiftFeedRange(range, merged.length - base.messages.length));
      return next;
    });
    olderSeen.current = "";
    setOlderBefore(null);
  }, [older.loading, older.data, olderBefore, cacheKey]);

  useEffect(() => {
    const element = feed;
    if (!element) return undefined;
    const onScroll = () => {
      const nearBottom = isNearBottom(element.scrollTop, element.scrollHeight, element.clientHeight);
      stickRef.current = nearBottom;
      const list = messagesRef.current;
      if (nearBottom) {
        const tail = tailFeedRange(list.length);
        const range = feedRangeRef.current;
        if (tail && range && (range.end < list.length || range.start !== tail.start)) {
          pendingAnchor.current = null;
          setFeedRange(tail);
        }
      } else if (list.length > 40) {
        const anchor = captureFeedAnchor(element);
        if (anchor) {
          const index = list.findIndex((item) => item.id === anchor.id);
          const next = slideFeedRange(list.length, index, feedRangeRef.current);
          if (next && next !== feedRangeRef.current) {
            pendingAnchor.current = anchor;
            setFeedRange(next);
          }
        }
      }
      if (element.scrollTop < 240) requestOlderRef.current();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [feed]);

  useLayoutEffect(() => {
    const element = feed;
    if (!element) return;
    const anchor = pendingAnchor.current;
    if (anchor) {
      const node = bubbleNode(element, anchor.id);
      if (node) {
        const delta = node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
        element.scrollTop += delta;
      }
      pendingAnchor.current = null;
      return;
    }
    const hold = holdScroll.current;
    if (hold) {
      element.scrollTop = hold.top + Math.max(0, element.scrollHeight - hold.height);
      holdScroll.current = null;
      return;
    }
    if (stickRef.current) element.scrollTop = element.scrollHeight;
  }, [feed, messages, cacheKey, feedRange]);

  useEffect(() => {
    const element = feed;
    const view = transcriptRef.current;
    if (!element || !view?.hasMore || view.exhausted || olderBefore) return;
    if (element.scrollHeight > element.clientHeight + 8) return;
    const range = feedRangeRef.current;
    if (range && range.start > 0) {
      setFeedRange({ start: Math.max(0, range.start - 20), end: range.end });
      return;
    }
    requestOlderRef.current();
  }, [feed, messages.length, olderBefore, transcript?.hasMore, transcript?.exhausted, feedRange]);

  useLayoutEffect(() => {
    if (composerRef.current) resizeComposer(composerRef.current);
  }, [draft, issueRef]);

  async function submit() {
    const text = draft.trim();
    if (!text || !companyId || !issueRef || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const replyTo = reply && isTelegramMessageId(reply.id) ? reply.id : "";
      await sendReply({ companyId, issueRef, text, ...(replyTo ? { replyTo } : {}) });
      setDraft("");
      setReply(null);
      refreshThread.current();
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  function openMenu(clientX: number, clientY: number, message: { id: string; text: string }) {
    const node = shell;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setMenu({
      ids: [message.id],
      text: message.text,
      x: clientX - rect.left,
      y: clientY - rect.top,
      page: "menu",
    });
  }

  function holdMessage(event: ReactPointerEvent<HTMLDivElement>, message: { id: string; text: string }) {
    if (event.pointerType === "mouse" || selecting) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const node = event.currentTarget;
    const timer = window.setTimeout(() => openMenu(startX, startY, message), 420);
    const stop = () => {
      window.clearTimeout(timer);
      node.removeEventListener("pointerup", stop);
      node.removeEventListener("pointercancel", stop);
      node.removeEventListener("pointermove", move);
    };
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8) stop();
    };
    node.addEventListener("pointerup", stop);
    node.addEventListener("pointercancel", stop);
    node.addEventListener("pointermove", move);
  }

  async function copyMessage(text: string) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("copy");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setMenu(null);
  }

  async function runMenu(
    op: "react" | "pin" | "unpin" | "delete" | "forward",
    extra: { emoji?: string; revoke?: boolean; targetIssueRef?: string },
  ) {
    if (!menu || !companyId || !issueRef || acting) return;
    const ids = menu.ids.filter(isTelegramMessageId);
    if (ids.length === 0) return;
    setActing(true);
    setSendError(null);
    try {
      await menuAction({ companyId, issueRef, op, messageIds: ids, ...extra });
      if (op === "delete") {
        const drop = new Set(ids);
        for (const id of ids) hiddenIds.current.add(id);
        setTranscript((current) => {
          const base = current ?? (cacheKey ? threadCache.get(cacheKey) ?? null : null);
          if (!base) return current;
          const next = { ...base, messages: base.messages.filter((item) => !drop.has(item.id)) };
          if (cacheKey) storeThread(cacheKey, next);
          return next;
        });
        setSelecting(false);
        setSelected([]);
      } else if (op === "react") {
        setReactions((current) => ({ ...current, [ids[0] ?? ""]: extra.emoji ?? "" }));
      } else if (op === "pin") {
        setPinned((current) => current.includes(ids[0] ?? "") ? current : [...current, ids[0] ?? ""]);
      } else if (op === "unpin") {
        setPinned((current) => current.filter((id) => id !== ids[0]));
      }
      setMenu(null);
      refreshThread.current();
    } catch (error) {
      setSendError(errorMessage(error));
      setMenu(null);
    } finally {
      setActing(false);
    }
  }

  if (!companyId || !prefix) return null;
  const listed = (chats.data?.chats ?? []).map((chat) => {
    const ref = chat.identifier || chat.issueId;
    const patch = rowPatches[ref];
    const photo = keepShownPhoto(shownListPhotos.current[ref], patch?.photo ?? chat.photo);
    if (photo) shownListPhotos.current[ref] = photo;
    if (!patch && photo === (chat.photo ?? null)) return chat;
    return {
      ...chat,
      preview: patch?.preview ?? chat.preview,
      unread: patch?.unread ?? chat.unread,
      updatedAt: patch?.updatedAt || chat.updatedAt,
      photo,
    };
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const rows = filterChats(listed, query);
  const showList = !narrow || !issueRef;
  const showThread = !narrow || Boolean(issueRef);
  const openChat = listed.find((chat) => (chat.identifier || chat.issueId) === issueRef);
  const label = openChat?.label || transcript?.label || uiText("Telegram");
  const headerPhoto = safePhoto(transcript?.photo) || safePhoto(openChat?.photo);
  const headerPresence = transcript?.presence || openChat?.presence || null;
  const headerStatus = presenceText(headerPresence, ru);
  const profileChat = listed.find((chat) => (chat.identifier || chat.issueId) === profileRef);
  const profileName = profile.data?.name || profileChat?.label || (profileRef === issueRef ? label : uiText("Telegram"));
  const profilePhoto = safePhoto(profile.data?.photo) || safePhoto(profileChat?.photo) || (profileRef === issueRef ? headerPhoto : null);
  const profilePresence = profile.data?.presence || profileChat?.presence || (profileRef === issueRef ? headerPresence : null);
  const profileStatus = presenceText(profilePresence, ru);
  const profilePhone = (profile.data?.phone ?? "").trim();
  const profileUser = (profile.data?.username ?? "").trim();
  const profileAbout = (profile.data?.about ?? "").trim();
  const profileChannel = (profile.data?.channel ?? "").trim();
  const sharedChats = profile.data?.sharedChats ?? 0;
  const days = groupThread(visibleMessages, now, ru);
  const taskHref = `/${prefix}/issues/${encodeURIComponent(openChat?.identifier || transcript?.identifier || issueRef)}`;
  const menuBox = menu?.page === "forward" ? 300 : menu?.page === "reactions" ? 430 : menu?.page === "delete" ? 160 : 340;
  const menuPos = menu
    ? menuPosition(
      { x: menu.x, y: menu.y },
      { width: shellWidth || shell?.clientWidth || 360, height: shell?.clientHeight || 640 },
      { width: 220, height: menuBox },
    )
    : null;
  const menuMutable = Boolean(menu && menu.ids.length > 0 && menu.ids.every(isTelegramMessageId));
  const menuPinned = Boolean(menu?.ids[0] && pinned.includes(menu.ids[0]));

  return (
    <>
      <style>{TG_CSS}</style>
      <div className={narrow ? "tg-shell is-narrow" : "tg-shell"} ref={setShell}>
      {showList ? (
        <div className="tg-list">
          <div className="tg-search">
            <div className="tg-search-field">
              <span className="tg-search-icon"><SearchIcon /></span>
              <input
                className="tg-search-input"
                type="search"
                value={query}
                placeholder={uiText("Search")}
                aria-label={uiText("Search")}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {rows.length === 0 && !chats.loading ? (
            <div className="tg-list-empty">{uiText("No chats")}</div>
          ) : (
            <div className="tg-rows">
              {rows.map((chat) => {
                const ref = chat.identifier || chat.issueId;
                const selected = !narrow && ref === issueRef;
                const badge = unreadLabel(chat.unread);
                const preview = chat.preview?.trim() ?? "";
                return (
                  <div
                    key={chat.issueId}
                    className={selected ? "tg-row is-selected" : "tg-row"}
                  >
                    <button
                      type="button"
                      className="tg-avatar-btn"
                      aria-label={uiText("User Info")}
                      onClick={() => setProfileRef(ref)}
                    >
                      <Avatar
                        id={chat.issueId}
                        name={chat.label}
                        photo={chat.photo}
                        online={chat.presence?.code === "online"}
                      />
                    </button>
                    <a
                      className="tg-row-body"
                      {...navigation.linkProps(`/${prefix}/telegram-inbox/${encodeURIComponent(ref)}`)}
                      aria-current={selected ? "page" : undefined}
                    >
                      <span className="tg-row-top">
                        <span className="tg-row-name">{chat.label}</span>
                        <span className="tg-row-time">{formatListTime(chat.updatedAt, now, ru)}</span>
                      </span>
                      {preview || badge ? (
                        <span className="tg-row-bottom">
                          <span className="tg-row-preview">{preview ? uiText(preview) : ""}</span>
                          {badge ? <span className="tg-badge">{badge}</span> : null}
                        </span>
                      ) : null}
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {showThread ? (
        <div className="tg-thread">
          {!issueRef ? (
            <div className="tg-empty">{uiText("Select a chat")}</div>
          ) : (
            <>
              <header className="tg-topbar">
                {narrow ? (
                  <a className="tg-back" {...navigation.linkProps(`/${prefix}/telegram-inbox`)} aria-label={uiText("Back")}>
                    <BackIcon />
                  </a>
                ) : null}
                <button
                  type="button"
                  className="tg-peer-btn"
                  aria-label={uiText("User Info")}
                  onClick={() => setProfileRef(issueRef)}
                >
                  <Avatar
                    id={openChat?.issueId || transcript?.issueId || issueRef}
                    name={label}
                    photo={headerPhoto}
                    topbar
                    online={headerPresence?.code === "online"}
                  />
                  <span className="tg-peer-copy">
                    <span className="tg-peer-name">{label}</span>
                    {headerStatus ? (
                      <span className={headerPresence?.code === "online" ? "tg-peer-status is-online" : "tg-peer-status"}>
                        {headerStatus}
                      </span>
                    ) : null}
                  </span>
                </button>
                <a className="tg-task" {...navigation.linkProps(taskHref)}>{uiText("Task")}</a>
              </header>
              {readyKey === cacheKey && transcript && transcript.live === false ? (
                <div className="tg-offline">
                  {uiText("The Telegram account is offline. Showing messages already saved on the task.")}
                </div>
              ) : null}
              <div className={feedIsCompact(feedWidth) ? "tg-feed is-compact" : "tg-feed"} ref={setFeed}>
                {olderBefore ? <div className="tg-history" aria-hidden="true"><i /></div> : null}
                {messages.length === 0 && readyKey === cacheKey ? (
                  <div className="tg-empty">{uiText("No messages")}</div>
                ) : days.map((day) => (
                  <div className="tg-day" key={day.key}>
                    {day.label ? <div className="tg-date">{day.label}</div> : null}
                    {day.groups.map((group) => (
                      <div className={`tg-group ${group.direction}`} key={group.key}>
                        {group.messages.map((message) => {
                          const at = parseTime(message.at);
                          return (
                            <div
                              className={`tg-bubble ${message.direction} ${message.position}${selecting && selected.includes(message.id) ? " is-picked" : ""}`}
                              key={message.id}
                              data-mid={message.id}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                if (!selecting) openMenu(event.clientX, event.clientY, message);
                              }}
                              onPointerDown={(event) => holdMessage(event, message)}
                              onClick={() => {
                                if (!selecting || !isTelegramMessageId(message.id)) return;
                                setSelected((current) => (
                                  current.includes(message.id)
                                    ? current.filter((id) => id !== message.id)
                                    : [...current, message.id]
                                ));
                              }}
                            >
                              {message.forward ? <span className="tg-forward">{forwardLine(message.forward)}</span> : null}
                              {message.text ? uiText(message.text) : null}
                              {at ? <span className="tg-bubble-time">{formatClock(at)}</span> : null}
                              {reactions[message.id] ? <span className="tg-react-badge">{reactions[message.id]}</span> : null}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {selecting ? (
                <div className="tg-selectbar">
                  <button type="button" onClick={() => { setSelecting(false); setSelected([]); }}>{uiText("Cancel")}</button>
                  <span>{selected.length}</span>
                  <button
                    type="button"
                    disabled={selected.length === 0 || acting}
                    onClick={() => {
                      const node = shell;
                      const rect = node?.getBoundingClientRect();
                      setMenu({
                        ids: selected,
                        text: "",
                        x: 16,
                        y: rect ? Math.max(16, rect.height - 280) : 16,
                        page: "forward",
                      });
                    }}
                  >{uiText("Forward")}</button>
                  <button
                    type="button"
                    className="is-danger"
                    disabled={selected.length === 0 || acting}
                    onClick={() => {
                      const node = shell;
                      const rect = node?.getBoundingClientRect();
                      setMenu({
                        ids: selected,
                        text: "",
                        x: 16,
                        y: rect ? Math.max(16, rect.height - 180) : 16,
                        page: "delete",
                      });
                    }}
                  >{uiText("Delete")}</button>
                </div>
              ) : (
              <div className="tg-composer-wrap">
                {reply ? (
                  <div className="tg-reply">
                    <span className="tg-reply-text">{reply.text || uiText("Message")}</span>
                    <button type="button" className="tg-reply-x" aria-label={uiText("Close")} onClick={() => setReply(null)}>×</button>
                  </div>
                ) : null}
                <form
                  className="tg-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <textarea
                    ref={composerRef}
                    className="tg-composer-input"
                    value={draft}
                    rows={1}
                    placeholder={uiText("Message")}
                    aria-label={uiText("Message")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="tg-send"
                    aria-label={uiText("Send")}
                    disabled={sending || draft.trim().length === 0}
                  >
                    <SendIcon />
                  </button>
                </form>
                {sendError ? <div role="alert" className="tg-send-error">{sendError}</div> : null}
              </div>
              )}
            </>
          )}
        </div>
      ) : null}
      {profileRef ? (
        <div
          className="tg-info-scrim"
          onClick={() => setProfileRef(null)}
        >
          <div
            className="tg-info"
            role="dialog"
            aria-modal="true"
            aria-label={uiText("User Info")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tg-info-bar">
              <button
                type="button"
                className="tg-info-close"
                aria-label={uiText("Close")}
                autoFocus
                onClick={() => setProfileRef(null)}
              >
                <CloseIcon />
              </button>
              <div className="tg-info-title">{uiText("User Info")}</div>
            </div>
            <div className="tg-info-hero">
              <Avatar id={profileChat?.issueId || profileRef} name={profileName} photo={profilePhoto} hero online={profilePresence?.code === "online"} />
              <div className="tg-info-name">{profileName}</div>
              {profileStatus ? (
                <div className={profileOnlineClass(profilePresence)}>{profileStatus}</div>
              ) : null}
            </div>
            {profileChannel ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profileChannel}</div>
                <div className="tg-info-label">{uiText("Channel")}</div>
              </div>
            ) : null}
            {profilePhone.startsWith("+") ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profilePhone}</div>
                <div className="tg-info-label">{uiText("Phone")}</div>
              </div>
            ) : null}
            {profileUser.startsWith("@") ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profileUser}</div>
                <div className="tg-info-label">{uiText("Username")}</div>
              </div>
            ) : null}
            {profileAbout ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profileAbout}</div>
                <div className="tg-info-label">{uiText("Bio")}</div>
              </div>
            ) : null}
            {sharedChats > 0 ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{sharedChats}</div>
                <div className="tg-info-label">{uiText("Shared groups")}</div>
              </div>
            ) : null}
            {profile.error && !profile.data ? (
              <div className="tg-info-block">
                <div className="tg-info-label">{uiText("Something went wrong.")}</div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {menu && menuPos ? (
        <div
          className="tg-menu-scrim"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="tg-menu-stack"
            style={{ left: menuPos.left, top: menuPos.top }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {menu.page === "menu" || menu.page === "reactions" ? (
              menu.page === "reactions" ? (
                <div className="tg-react-grid">
                  {[...QUICK_REACTIONS, ...MORE_REACTIONS].map((emoji) => (
                    <button key={emoji} type="button" disabled={!menuMutable || acting} onClick={() => void runMenu("react", { emoji: reactions[menu.ids[0] ?? ""] === emoji ? "" : emoji })}>{emoji}</button>
                  ))}
                </div>
              ) : (
                <div className="tg-reacts">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button key={emoji} type="button" disabled={!menuMutable || acting} onClick={() => void runMenu("react", { emoji: reactions[menu.ids[0] ?? ""] === emoji ? "" : emoji })}>{emoji}</button>
                  ))}
                  <button type="button" className="tg-react-more" aria-label={uiText("More reactions")} onClick={() => setMenu({ ...menu, page: "reactions" })}>
                    <MenuIcon d="M6 10l6 6 6-6" />
                  </button>
                </div>
              )
            ) : null}
            <div className="tg-menu">
              {menu.page === "delete" ? (
                <>
                  <button type="button" disabled={!menuMutable || acting} onClick={() => void runMenu("delete", { revoke: false })}>
                    <MenuIcon d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
                    {uiText("Delete for me")}
                  </button>
                  <button type="button" className="is-danger" disabled={!menuMutable || acting} onClick={() => void runMenu("delete", { revoke: true })}>
                    <MenuIcon d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
                    {uiText("Delete for everyone")}
                  </button>
                </>
              ) : menu.page === "forward" ? (
                <div className="tg-forward-list">
                  {(chats.data?.chats ?? []).map((chat) => (
                    <button
                      key={chat.issueId}
                      type="button"
                      disabled={!menuMutable || acting}
                      onClick={() => void runMenu("forward", { targetIssueRef: chat.identifier || chat.issueId })}
                    >
                      {chat.label}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <button type="button" disabled={menu.ids.length !== 1} onClick={() => {
                    setReply({ id: menu.ids[0] ?? "", text: menu.text.replace(/\s+/g, " ").trim().slice(0, 140) });
                    setMenu(null);
                    composerRef.current?.focus();
                  }}>
                    <MenuIcon d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1" />
                    {uiText("Reply")}
                  </button>
                  {menu.text ? (
                    <button type="button" onClick={() => void copyMessage(menu.text)}>
                      <MenuIcon d="M8 8h10v10H8zM6 6h10v2" />
                      {uiText("Copy")}
                    </button>
                  ) : null}
                  <button type="button" disabled={!menuMutable || menu.ids.length !== 1 || acting} onClick={() => void runMenu(menuPinned ? "unpin" : "pin", {})}>
                    <MenuIcon d="M9 4h6v5l2 2v2H7v-2l2-2zM12 13v7" />
                    {uiText(menuPinned ? "Unpin" : "Pin")}
                  </button>
                  <button type="button" disabled={!menuMutable || acting} onClick={() => setMenu({ ...menu, page: "forward" })}>
                    <MenuIcon d="M15 7l5 5-5 5M20 12H8a5 5 0 0 0-5 5v1" />
                    {uiText("Forward")}
                  </button>
                  <button type="button" disabled={!menuMutable || menu.ids.length !== 1} onClick={() => {
                    const id = menu.ids[0] ?? "";
                    setSelecting(true);
                    setSelected((current) => current.includes(id) ? current : [...current, id]);
                    setMenu(null);
                  }}>
                    <MenuIcon d="M12 3.5a8.5 8.5 0 1 0 .1 0zM8 12.2 10.8 15l5.2-5.4" />
                    {uiText("Select")}
                  </button>
                  <button type="button" className="is-danger" disabled={!menuMutable || acting} onClick={() => setMenu({ ...menu, page: "delete" })}>
                    <MenuIcon d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
                    {uiText("Delete")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
}

function profileOnlineClass(presence: PresenceView): string {
  return presence?.code === "online" ? "tg-info-seen is-online" : "tg-info-seen";
}
