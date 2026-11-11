export const RECENT_TASKS_LIMIT_SETTING = {
  key: "limit",
  label: "Tasks to show",
  type: "number",
  min: 3,
  max: 20,
  default: 10,
} as const;

export const LIVE_LIST_LIMIT_SETTING = {
  key: "limit",
  label: "Rows to show",
  type: "number",
  min: 3,
  max: 30,
  default: 8,
} as const;
