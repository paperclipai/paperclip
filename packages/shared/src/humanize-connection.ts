/**
 * Humanize engineering connection / tool identifiers for the prosumer Apps
 * surfaces (PAP-10897).
 *
 * `connection.name` (and tool ids) can carry raw IPs, `Plugin:` prefixes with
 * dotted package paths, and `vendor:tool` ids. None of that vocabulary may leak
 * into `/apps`, `/apps/attention`, or the App-detail header — only `/apps/advanced`
 * is allowed to show the raw identifiers. This module turns those identifiers
 * into recognizable, plain-language labels.
 */

export interface HumanizableConnection {
  name: string;
}

type ConnectionLike = HumanizableConnection | string | null | undefined;

function rawNameOf(input: ConnectionLike): string {
  return (typeof input === "string" ? input : (input?.name ?? "")).trim();
}

/** IP / URL / host:port / localhost — anything that reads as a network address. */
function looksLikeNetworkAddress(raw: string): boolean {
  const v = raw.toLowerCase();
  if (v.includes("://")) return true; // any URL
  if (v === "localhost" || v.startsWith("localhost:")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(v)) return true; // IPv4 (optional :port)
  if (/^[a-z0-9.-]+:\d+$/.test(v)) return true; // host:port
  return false;
}

/** Title-case a snake/kebab/dotted identifier: `update_note` → `Update Note`. */
function titleCaseIdentifier(value: string): string {
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** `Plugin: paperclipai.plugin-briefs` → `Briefs`; null when not a plugin label. */
function pluginPackageLabel(raw: string): string | null {
  const match = /^plugin:\s*(.+)$/i.exec(raw);
  if (!match) return null;
  let leaf = match[1].trim();
  // Keep the package leaf only: `paperclipai.plugin-briefs` → `plugin-briefs`.
  leaf = leaf.slice(leaf.lastIndexOf(".") + 1);
  // Drop the `plugin-` scaffolding leftover: `plugin-briefs` → `briefs`.
  leaf = leaf.replace(/^plugin[-_]/i, "");
  return titleCaseIdentifier(leaf) || "Custom app";
}

/**
 * Turn an app/connection identifier (or a tool id) into a prosumer-friendly
 * label. Pass `options.title` (e.g. a catalog entry's `title`) to prefer a
 * known human title over any derivation.
 *
 *   `127.0.0.1`                       → `Custom app`
 *   `Plugin: paperclipai.plugin-briefs` → `Briefs`
 *   `mcp-remote-fixture:update_note`  → `Update Note`
 *   `Zapier` / `Notion`               → unchanged
 */
export function humanizeConnectionDisplayName(
  input: ConnectionLike,
  options: { title?: string | null } = {},
): string {
  const title = options.title?.trim();
  if (title) return title; // a real, human title always wins

  const raw = rawNameOf(input);
  if (!raw) return "Custom app";

  if (looksLikeNetworkAddress(raw)) return "Custom app";

  const pluginLabel = pluginPackageLabel(raw);
  if (pluginLabel) return pluginLabel;

  // `vendor:tool` id (e.g. `mcp-remote-fixture:update_note`) → tool segment.
  if (raw.includes(":") && !raw.includes("://")) {
    const tool = raw.slice(raw.lastIndexOf(":") + 1).trim();
    if (tool) return titleCaseIdentifier(tool);
  }

  // Already human (a space or any capital) → pass through untouched.
  if (/\s/.test(raw) || /[A-Z]/.test(raw)) return raw;

  // Bare snake/kebab/dotted identifier → Title Case With Spaces.
  if (/[._-]/.test(raw)) return titleCaseIdentifier(raw);

  return raw;
}

/**
 * Optional secondary line for the App-detail page only: when the raw name is a
 * network address we hide it from the header but may still show `hosted at …`
 * underneath as a small trust/clarity hint. Returns null when there's nothing
 * worth surfacing.
 */
export function connectionDisplaySecondaryHint(input: ConnectionLike): string | null {
  const raw = rawNameOf(input);
  if (raw && looksLikeNetworkAddress(raw)) return `hosted at ${raw}`;
  return null;
}
