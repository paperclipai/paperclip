import type { McpServerConfig, McpServersConfig } from "@paperclipai/shared";

/**
 * Diff two MCP server records (as edited by McpServersEditor) into catalog
 * operations for the company MCP server API: `added` names are created,
 * `changed` names are PATCHed by id, and `removed` names are deleted.
 *
 * `enabledOnly` marks entries whose config is unchanged apart from the
 * `enabled` flag (the row-level toggle). Those must be PATCHed as
 * `{ enabled }` without a config payload: the sanitized config from the list
 * response contains redacted plain values and a GET-only `connected` marker
 * that the strict shared schema refuses on write.
 */
export interface McpServerRecordDiff {
  added: { name: string; config: McpServerConfig }[];
  changed: { name: string; config: McpServerConfig; enabledOnly: boolean }[];
  removed: string[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutEnabled(config: McpServerConfig): McpServerConfig {
  const { enabled: _enabled, ...rest } = config;
  return rest;
}

export function isEnabledInConfig(config: McpServerConfig): boolean {
  return config.enabled !== false;
}

export function diffMcpServerRecords(
  prev: McpServersConfig,
  next: McpServersConfig,
): McpServerRecordDiff {
  const added: McpServerRecordDiff["added"] = [];
  const changed: McpServerRecordDiff["changed"] = [];
  const removed: string[] = [];

  for (const [name, config] of Object.entries(next)) {
    const before = prev[name];
    if (!before) {
      added.push({ name, config });
      continue;
    }
    // Untouched entries pass through the editor by reference.
    if (before === config) continue;
    const sameConfig = stableStringify(withoutEnabled(before)) === stableStringify(withoutEnabled(config));
    const sameEnabled = isEnabledInConfig(before) === isEnabledInConfig(config);
    if (sameConfig && sameEnabled) continue;
    changed.push({ name, config, enabledOnly: sameConfig });
  }

  for (const name of Object.keys(prev)) {
    if (!(name in next)) removed.push(name);
  }

  return { added, changed, removed };
}

/**
 * Prepare a catalog write payload from an editor config. The row-level
 * `enabled` column carries enablement (so `enabled` is stripped from the
 * config), and the sanitized `connected` marker the API adds to OAuth auth on
 * read is dropped so the strict shared schema accepts the write. Sending
 * `secretId: null` is safe: the server preserves a connected secretId.
 */
export function toCatalogServerWrite(config: McpServerConfig): {
  config: McpServerConfig;
  enabled: boolean;
} {
  const enabled = isEnabledInConfig(config);
  const base = withoutEnabled(config);
  if (base.transport !== "stdio" && base.auth?.type === "oauth") {
    return {
      config: {
        ...base,
        auth: {
          type: "oauth",
          secretId: base.auth.secretId,
          ...(base.auth.version !== undefined ? { version: base.auth.version } : {}),
        },
      },
      enabled,
    };
  }
  return { config: base, enabled };
}
