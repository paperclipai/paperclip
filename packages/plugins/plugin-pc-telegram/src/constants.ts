export const PLUGIN_ID = "andhash.plugin-pc-telegram";
export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_DISPLAY_NAME = "Telegram";

export const ACCOUNT_ENTITY_TYPE = "telegram-account";
export const DIALOG_ORIGIN_KIND = `plugin:${PLUGIN_ID}:dialog` as const;
export const DEFAULT_INCOMING_MODE = "dialog_task" as const;
export const TOOL_SEND_TEXT = "telegram_send_text";

export const SESSION_SECRET_NAMESPACE = "session-secrets";
export const FILE_NAMESPACE = "inbound-files";
export const MAX_INBOUND_MEDIA_BYTES = 4 * 1024 * 1024;
export const MAX_INBOUND_MEDIA_PER_PEER = 8;
export const INBOUND_MEDIA_WINDOW_MS = 60_000;
export const MAX_INBOUND_MEDIA_PER_PEER_DAY = 40;
export const INBOUND_QUOTA_DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_INBOUND_MESSAGES_PER_PEER = 20;
export const INBOUND_MESSAGE_WINDOW_MS = 60_000;
export const MAX_INBOUND_MESSAGES_PER_PEER_DAY = 200;
export const MAX_NEW_INBOUND_PEERS_PER_HOUR = 30;
export const INBOUND_NEW_PEER_WINDOW_MS = 60 * 60 * 1000;
export const INBOUND_QUOTA_NAMESPACE = "inbound-quota";
export const INBOUND_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COMPANY_WINDOW_MESSAGES = 2000;
export const COMPANY_WINDOW_ATTACHMENTS = 2000;
export const COMPANY_WINDOW_BYTES = 64 * 1024 * 1024;
export const CONNECTION_WINDOW_MESSAGES = 500;
export const CONNECTION_WINDOW_ATTACHMENTS = 500;
export const CONNECTION_WINDOW_BYTES = 32 * 1024 * 1024;
export const COMPANY_LIFETIME_MESSAGES = 20_000;
export const COMPANY_LIFETIME_ATTACHMENTS = 20_000;
export const COMPANY_LIFETIME_BYTES = 1024 * 1024 * 1024;
export const CONNECTION_LIFETIME_MESSAGES = 5000;
export const CONNECTION_LIFETIME_ATTACHMENTS = 5000;
export const CONNECTION_LIFETIME_BYTES = 256 * 1024 * 1024;
export const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
export const START_LOGIN_WINDOW_MS = 60_000;
export const MAX_START_LOGINS_PER_WINDOW = 5;

export const LOGIN_STREAM_CHANNEL = "telegram-login";

export const ACTION_START_LOGIN = "start-login";
export const ACTION_SUBMIT_PASSWORD = "submit-password";
export const ACTION_CANCEL_LOGIN = "cancel-login";
export const ACTION_UPDATE_CONNECTION = "update-connection";
export const ACTION_SET_PAUSED = "set-paused";
export const ACTION_DISCONNECT = "disconnect-account";

export const DATA_OVERVIEW = "overview";
export const DATA_LOGIN_STATUS = "login-status";

export const COMPANY_SETTINGS_SLOT_ID = "telegram-connect-page";
export const COMPANY_SETTINGS_EXPORT = "TelegramConnectPage";
export const COMPANY_SETTINGS_ROUTE = "telegram";
