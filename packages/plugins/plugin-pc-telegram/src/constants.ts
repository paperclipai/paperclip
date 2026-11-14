export const PLUGIN_ID = "andhash.plugin-pc-telegram";
export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_DISPLAY_NAME = "Telegram";

export const ACCOUNT_ENTITY_TYPE = "telegram-account";
export const DIALOG_ORIGIN_KIND = `plugin:${PLUGIN_ID}:dialog` as const;
export const DEFAULT_INCOMING_MODE = "dialog_task" as const;
export const TOOL_SEND_TEXT = "telegram_send_text";

export const SESSION_SECRET_NAMESPACE = "session-secrets";
export const FILE_NAMESPACE = "inbound-files";
export const COMPANY_INDEX_STATE_KEY = "connected-company-ids";

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
