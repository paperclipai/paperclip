export const RECENT_TASKS_LIMIT_SETTING = {
  key: "limit",
  label: "Tasks to show",
  type: "number",
  min: 3,
  max: 20,
  default: 10,
} as const;
