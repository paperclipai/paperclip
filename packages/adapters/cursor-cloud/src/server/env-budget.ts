const MAX_ENV_KEYS = 50;
const MAX_ENV_VALUE_BYTES = 4096;
const TRUNCATION_SUFFIX = "[truncated: cursor_cloud envVars limit]";

const PRIORITY_KEYS = new Set([
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_WAKE_COMMENT_ID",
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateValue(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let truncated = value;
  while (byteLength(truncated + TRUNCATION_SUFFIX) > maxBytes && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + TRUNCATION_SUFFIX;
}

export type EnvBudgetResult = {
  env: Record<string, string>;
  droppedKeys: string[];
  truncatedKeys: string[];
};

export function allocateEnvVarsBudget(
  raw: Record<string, string>,
  options: { maxKeys?: number; maxValueBytes?: number } = {},
): EnvBudgetResult {
  const maxKeys = options.maxKeys ?? MAX_ENV_KEYS;
  const maxValueBytes = options.maxValueBytes ?? MAX_ENV_VALUE_BYTES;
  const droppedKeys: string[] = [];
  const truncatedKeys: string[] = [];

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "PAPERCLIP_WAKE_PAYLOAD_JSON") continue;
    filtered[key] = value;
  }

  const entries = Object.entries(filtered).sort(([a], [b]) => {
    const aPri = PRIORITY_KEYS.has(a) ? 0 : 1;
    const bPri = PRIORITY_KEYS.has(b) ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    return a.localeCompare(b);
  });

  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (Object.keys(env).length >= maxKeys) {
      if (!PRIORITY_KEYS.has(key)) {
        droppedKeys.push(key);
        continue;
      }
    }
    let next = value;
    if (byteLength(next) > maxValueBytes) {
      next = truncateValue(next, maxValueBytes);
      truncatedKeys.push(key);
    }
    if (Object.keys(env).length < maxKeys || PRIORITY_KEYS.has(key)) {
      env[key] = next;
    } else {
      droppedKeys.push(key);
    }
  }

  return { env, droppedKeys, truncatedKeys };
}
