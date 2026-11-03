/**
 * Codex builds the first turn's tool catalog after a shared grace of one second
 * (`mcp_optional_startup_grace_ms`). A Paperclip gateway that lists hundreds of
 * governed tools regularly needs longer, so its tools reached the model only
 * after the turn had started and task-bound tools such as the GitHub review
 * bot looked absent. Setting the grace to `0` makes Codex wait for each server's
 * own `startup_timeout_sec` instead.
 */
export const CODEX_MANAGED_MCP_STARTUP_TIMEOUT_SEC = 120;

const GRACE_KEY = "mcp_optional_startup_grace_ms";
const MANAGED_MARKER = "# paperclip-managed";
const MANAGED_GRACE_LINE = `${GRACE_KEY} = 0 ${MANAGED_MARKER}: the first turn waits for governed MCP gateways`;
const MANAGED_GRACE_LINE_RE = new RegExp(`^[ \\t]*${GRACE_KEY}[ \\t]*=.*${MANAGED_MARKER}.*(?:\\r?\\n|$)`, "gm");
const GRACE_KEY_RE = new RegExp(`^[ \\t]*${GRACE_KEY}[ \\t]*=`, "m");
const TABLE_HEADER_RE = /^[ \t]*\[/m;

/**
 * Returns `config` with the Paperclip-managed `mcp_optional_startup_grace_ms`
 * line present (`enabled`) or removed. The line is placed in the top-level key
 * region, before the first table header, because a bare key after a table
 * header would belong to that table. An operator-set value is left alone.
 */
export function withCodexMcpStartupWait(config: string, enabled: boolean): string {
  const stripped = config.replace(MANAGED_GRACE_LINE_RE, "");
  if (!enabled) return stripped;
  const firstTable = stripped.search(TABLE_HEADER_RE);
  const topLevel = firstTable < 0 ? stripped : stripped.slice(0, firstTable);
  if (GRACE_KEY_RE.test(topLevel)) return stripped;
  const rest = firstTable < 0 ? "" : stripped.slice(firstTable);
  const head = topLevel.trimEnd();
  return `${head}${head ? "\n" : ""}${MANAGED_GRACE_LINE}\n${rest ? `\n${rest}` : ""}`;
}

/** Object form for callers that rewrite config.toml through a TOML parser. */
export function withCodexMcpStartupWaitConfig<T extends Record<string, unknown>>(config: T): T {
  if (GRACE_KEY in config) return config;
  return { ...config, [GRACE_KEY]: 0 };
}
