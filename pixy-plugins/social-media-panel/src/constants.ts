export const PLUGIN_ID = "@pixy/social-media-panel";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "sosyal-medya";
export const SLOT_IDS = {
  page: "sosyal-medya-page",
  sidebar: "sosyal-medya-sidebar",
} as const;
export const DATA_KEYS = {
  durum: "sosyal-medya-durum",
  config: "plugin-config",
} as const;
export const DEFAULT_DOCUMENT_KEY = "sosyal-medya-durum";
export const DEFAULT_SCAN_LIMIT = 30;
export const MAX_SCAN_LIMIT = 100;
