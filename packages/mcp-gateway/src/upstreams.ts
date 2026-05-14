/**
 * Upstream routing config: path-prefix → upstream URL.
 *
 * Loaded from a JSON env var `PAPERCLIP_MCP_UPSTREAMS` or a JSON file
 * pointed at by `PAPERCLIP_MCP_UPSTREAMS_FILE`. Either form, the shape
 * is `Record<prefix, upstreamUrl>`. An incoming request to
 * `/<prefix>/mcp` proxies to `<upstreamUrl>` (preserving the rest of
 * the path).
 *
 * Example:
 *   {
 *     "figma": "http://figma-mcp-server.paperclip.svc:8000/mcp",
 *     "linear": "http://linear-mcp-server.paperclip.svc:8000/mcp",
 *     "k8s-admin": "http://kubernetes-mcp-server-admin.paperclip.svc:8080/mcp"
 *   }
 *
 * The mapping is loaded once at startup and not hot-reloaded — a
 * routing change requires a pod restart, which is fine since the
 * gateway is stateless across restarts (in-memory session map is
 * lost, clients re-initialize).
 */

import fs from "node:fs";

export type UpstreamMap = Record<string, string>;

export function loadUpstreams(env: NodeJS.ProcessEnv = process.env): UpstreamMap {
  const filePath = env.PAPERCLIP_MCP_UPSTREAMS_FILE?.trim();
  if (filePath && filePath.length > 0) {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseUpstreamMap(raw, `file ${filePath}`);
  }
  const inline = env.PAPERCLIP_MCP_UPSTREAMS?.trim();
  if (inline && inline.length > 0) {
    return parseUpstreamMap(inline, "PAPERCLIP_MCP_UPSTREAMS");
  }
  throw new Error(
    "No upstreams configured. Set PAPERCLIP_MCP_UPSTREAMS_FILE (path to JSON) or PAPERCLIP_MCP_UPSTREAMS (inline JSON).",
  );
}

export function parseUpstreamMap(raw: string, source: string): UpstreamMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`upstreams: failed to parse ${source} as JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`upstreams: ${source} must be a JSON object`);
  }
  const result: UpstreamMap = {};
  for (const [prefix, url] of Object.entries(parsed)) {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error(`upstreams: prefix "${prefix}" must map to a non-empty URL string`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
      throw new Error(`upstreams: prefix "${prefix}" must match /^[a-zA-Z0-9_-]+$/`);
    }
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`upstreams: prefix "${prefix}" URL must start with http:// or https://`);
    }
    result[prefix] = url;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(`upstreams: ${source} contained no prefix→URL mappings`);
  }
  return result;
}

/**
 * Match an incoming path against the upstream table.
 * Input: "/figma/mcp", table: { figma: "http://...:8000/mcp" }
 * Returns: the upstream URL, plus the remainder of the path beyond the
 * prefix (so a request to "/figma/mcp/extra" forwards to
 * "<upstream>/extra").
 */
export function matchUpstream(
  path: string,
  upstreams: UpstreamMap,
): { upstreamUrl: string; remainder: string } | null {
  // Strip leading "/"
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const slashIdx = trimmed.indexOf("/");
  const prefix = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const remainder = slashIdx === -1 ? "" : trimmed.slice(slashIdx);
  const upstreamUrl = upstreams[prefix];
  if (!upstreamUrl) return null;
  // Default: the upstream URL points at /mcp; the remainder is what's
  // after the prefix in the inbound path. If remainder is "/mcp" we
  // forward to upstream as-is. Anything else we append.
  const finalUrl = remainder === "/mcp" || remainder === "" ? upstreamUrl : `${upstreamUrl}${remainder.replace(/^\/mcp/, "")}`;
  return { upstreamUrl: finalUrl, remainder };
}
