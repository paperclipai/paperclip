/**
 * MCP Skills extension (SEP-2640): skills that a connected MCP server
 * publishes alongside its tools. Paperclip is the host. It lists each server's
 * skills, asks the board to approve each one against its exact file manifest,
 * and delivers approved skills to agents that can use the connection.
 *
 * https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx
 */

import { z } from "zod";

export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/** Client capability Paperclip declares in each request's `_meta`. */
export const MCP_SKILLS_CLIENT_CAPABILITY = { [MCP_SKILLS_EXTENSION_ID]: {} } as const;

/** Per-skill limits every conforming host accepts (spec: Limits). */
export const MCP_SKILL_MAX_RESOURCES = 512;
export const MCP_SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export interface McpSkillResource {
  uri: string;
  /** `sha256:` followed by 64 lowercase hex characters. */
  digest: string;
  size: number;
}

export interface McpSkillEntry {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: McpSkillResource[] | "dynamic";
}

export const MCP_SKILL_STATUSES = ["pending_review", "approved", "declined", "unavailable"] as const;
export type McpSkillStatus = (typeof MCP_SKILL_STATUSES)[number];

export const MCP_SKILL_STATUS_REASONS = [
  "new",
  "changed",
  "dynamic",
  "too_large",
  "invalid",
  "verification_failed",
  "removed",
] as const;
export type McpSkillStatusReason = (typeof MCP_SKILL_STATUS_REASONS)[number];

/** A connected app's skill as the board sees it. */
export interface CompanyMcpSkill {
  id: string;
  connectionId: string;
  appName: string;
  name: string;
  description: string;
  skillUri: string;
  status: McpSkillStatus;
  statusReason: McpSkillStatusReason | null;
  /** The digest the board approves; the server rejects an approval for any other. */
  manifestDigest: string | null;
  fileCount: number | null;
  totalBytes: number | null;
  /** The tools the skill asks to use (`allowed-tools`). Never granted without approval. */
  requestedTools: string[];
  allowedToolsApproved: boolean;
  /** Other skills, from this or another source, with the same name. */
  nameCollision: boolean;
  reviewedAt: string | null;
  lastSeenAt: string;
}

export const approveCompanyMcpSkillSchema = z.object({
  /** The manifest digest the board reviewed. */
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Also honor the skill's `allowed-tools`. */
  allowTools: z.boolean().optional(),
}).strict();
export type ApproveCompanyMcpSkillRequest = z.infer<typeof approveCompanyMcpSkillSchema>;

export const mcpSkillFileQuerySchema = z.object({ path: z.string().min(1).max(1024) });

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
// Agent Skills spec: 1-64 chars, lowercase letters, digits and single hyphens.
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,63}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The skill root (the SKILL.md URI without `/SKILL.md`), or null when the URI is not a skill URI. */
export function mcpSkillRoot(skillUri: string): string | null {
  return skillUri.endsWith("/SKILL.md") ? skillUri.slice(0, -"/SKILL.md".length) : null;
}

/** The skill's name as recoverable from its URI: the last segment of the skill path. */
export function mcpSkillNameFromUri(skillUri: string): string | null {
  const root = mcpSkillRoot(skillUri);
  if (!root) return null;
  const segment = root.slice(root.lastIndexOf("/") + 1);
  return segment || null;
}

/** A file path relative to the skill root, or null when the URI is outside the skill. */
export function mcpSkillRelativePath(skillUri: string, fileUri: string): string | null {
  const root = mcpSkillRoot(skillUri);
  if (!root || !fileUri.startsWith(`${root}/`)) return null;
  const relative = fileUri.slice(root.length + 1);
  const segments = relative.split("/");
  if (!relative || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return relative;
}

export type McpSkillEntryCheck =
  | { ok: true; entry: McpSkillEntry; totalBytes: number | null }
  | { ok: false; uri: string | null; reason: "invalid" | "too_large"; message: string };

/**
 * Validate one `skills/list` or `skills/get` entry against the spec's
 * structural rules. An invalid entry is never loaded; one over the limits is
 * declined with a reason the board can see.
 */
export function checkMcpSkillEntry(value: unknown): McpSkillEntryCheck {
  const entry = record(value);
  const uri = typeof entry?.uri === "string" ? entry.uri : null;
  const invalid = (message: string): McpSkillEntryCheck => ({ ok: false, uri, reason: "invalid", message });
  if (!entry || !uri || uri.length > 2048) return invalid("The skill has no valid URI.");
  const frontmatter = record(entry.frontmatter);
  if (!frontmatter || typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    return invalid("The skill's frontmatter must include a name and a description.");
  }
  if (!SKILL_NAME_RE.test(frontmatter.name)) return invalid("The skill's name is not a valid skill name.");
  if (mcpSkillNameFromUri(uri) !== frontmatter.name) return invalid("The skill's URI does not end in its name.");
  const resources = entry.resources;
  if (resources === "dynamic") {
    return { ok: true, entry: { uri, frontmatter: frontmatter as McpSkillEntry["frontmatter"], resources }, totalBytes: null };
  }
  if (!Array.isArray(resources)) return invalid("The skill has no file manifest.");
  if (resources.length > MCP_SKILL_MAX_RESOURCES) {
    return { ok: false, uri, reason: "too_large", message: `The skill has more than ${MCP_SKILL_MAX_RESOURCES} files.` };
  }
  const seen = new Set<string>();
  const files: McpSkillResource[] = [];
  let totalBytes = 0;
  for (const item of resources) {
    const resource = record(item);
    const fileUri = typeof resource?.uri === "string" ? resource.uri : null;
    const digest = typeof resource?.digest === "string" ? resource.digest : null;
    const size = resource?.size;
    if (!fileUri || !digest || !DIGEST_RE.test(digest) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return invalid("A file in the skill's manifest has no valid URI, digest or size.");
    }
    if (fileUri !== uri && !mcpSkillRelativePath(uri, fileUri)) return invalid("The skill's manifest lists a file outside the skill.");
    if (seen.has(fileUri)) return invalid("The skill's manifest lists a file twice.");
    seen.add(fileUri);
    totalBytes += size;
    files.push({ uri: fileUri, digest, size });
  }
  if (!seen.has(uri)) return invalid("The skill's manifest does not include its SKILL.md.");
  if (totalBytes > MCP_SKILL_MAX_TOTAL_BYTES) {
    return { ok: false, uri, reason: "too_large", message: "The skill's files are larger than 16 MiB in total." };
  }
  files.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return { ok: true, entry: { uri, frontmatter: frontmatter as McpSkillEntry["frontmatter"], resources: files }, totalBytes };
}

/** The `allowed-tools` a skill requests, in either the list or the space-separated form. */
export function mcpSkillRequestedTools(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter["allowed-tools"];
  const tools = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  return tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0).map((tool) => tool.trim());
}
