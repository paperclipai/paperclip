export const PLUGIN_ID = "paperclip.chat";
export const PLUGIN_VERSION = "0.1.0";

export const SLOT_IDS = {
  sidebar: "chat-sidebar-link",
  sidebarPanel: "chat-sidebar-panel",
  page: "chat-page",
  settingsPage: "chat-settings-page",
} as const;

export const EXPORT_NAMES = {
  sidebar: "ChatSidebarLink",
  sidebarPanel: "ChatSidebarPanel",
  page: "ChatPage",
  settingsPage: "ChatSettingsPage",
} as const;

export const STREAM_CHANNELS = {
  chat: "chat",
} as const;

export const ACTION_KEYS = {
  sendMessage: "send-message",
  newSession: "new-session",
  saveConfig: "save-config",
} as const;

export const DATA_KEYS = {
  sessionHistory: "session-history",
  config: "plugin-config",
} as const;

export const DEFAULT_CONFIG = {
  gatewayUrl: "ws://127.0.0.1:21007",
  defaultAgentId: "",
  gatewayToken: "",
} as const;
