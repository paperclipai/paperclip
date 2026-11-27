/**
 * MCP Skills extension (SEP-2640), host side. Connected MCP servers publish
 * skills; this module keeps Paperclip's record of them, binds board approval to
 * each skill's exact file manifest, and verifies every file before use.
 *
 * Protocol traffic stays with its owners: listings come from catalog discovery
 * and file reads go through the tool gateway with the agent's own grant. This
 * module only decides what may be used.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills, toolApplications, toolConnections, toolMcpSkillFiles, toolMcpSkills } from "@paperclipai/db";
import {
  checkMcpSkillEntry,
  parseFrontmatterMarkdown,
  mcpSkillRequestedTools,
  mcpSkillRelativePath,
  type CompanyMcpSkill,
  type McpSkillEntry,
  type McpSkillResource,
  type McpSkillStatus,
  type McpSkillStatusReason,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

export type McpSkillRow = typeof toolMcpSkills.$inferSelect;
type Actor = { actorType: "agent" | "user" | "system" | "plugin"; actorId: string; agentId?: string | null; runId?: string | null };

const SYSTEM_ACTOR: Actor = { actorType: "system", actorId: "mcp-skills" };

/**
 * The digest a board approval binds to: every `{uri, digest, size}` of the
 * manifest, sorted, so a server that only reorders its list changes nothing.
 */
export function mcpSkillManifestDigest(resources: McpSkillResource[]): string {
  const canonical = [...resources]
    .map(({ uri, digest, size }) => [uri, digest, size] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export class McpSkillVerificationError extends Error {
  constructor(message: string, readonly fileUri: string) {
    super(message);
    this.name = "McpSkillVerificationError";
  }
}

/** Size, then SHA-256, of a file's raw bytes against its manifest entry. */
export function verifyMcpSkillFileBytes(bytes: Buffer, resource: McpSkillResource) {
  if (bytes.byteLength !== resource.size) {
    throw new McpSkillVerificationError(`The app served ${bytes.byteLength} bytes for a file it listed as ${resource.size} bytes.`, resource.uri);
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== resource.digest) throw new McpSkillVerificationError("The app served a file that does not match its listed digest.", resource.uri);
}

/**
 * The SKILL.md frontmatter, parsed with the skills system's own parser, must
 * equal the entry's frontmatter field by field. A YAML form that parser does
 * not read faithfully fails closed: the skill is not loaded.
 */
export function verifyMcpSkillFrontmatter(markdown: string, frontmatter: Record<string, unknown>, skillUri: string) {
  let parsed: ReturnType<typeof parseFrontmatterMarkdown> | null = null;
  try {
    parsed = parseFrontmatterMarkdown(markdown.replace(/^\uFEFF/, ""));
  } catch {
    parsed = null;
  }
  if (!parsed?.hasFrontmatter || !isDeepStrictEqual(JSON.parse(JSON.stringify(parsed.frontmatter)), frontmatter)) {
    throw new McpSkillVerificationError("The skill's instructions do not match the description the app listed.", skillUri);
  }
}

/** Raw bytes of one `resources/read` content item for `fileUri`. */
export function mcpSkillContentBytes(result: unknown, fileUri: string): Buffer | null {
  const contents = (result as { contents?: unknown })?.contents;
  if (!Array.isArray(contents)) return null;
  const item = contents.find((content) => content && typeof content === "object" && (content as { uri?: unknown }).uri === fileUri)
    ?? (contents.length === 1 ? contents[0] : null);
  if (!item || typeof item !== "object") return null;
  const { text, blob } = item as { text?: unknown; blob?: unknown };
  if (typeof text === "string") return Buffer.from(text, "utf8");
  if (typeof blob === "string") return Buffer.from(blob, "base64");
  return null;
}

function now() {
  return new Date();
}

export function mcpSkillsService(db: Db) {
  async function audit(row: Pick<McpSkillRow, "id" | "companyId" | "connectionId" | "name" | "skillUri">, action: string, actor: Actor, details: Record<string, unknown> = {}) {
    await logActivity(db, {
      companyId: row.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action,
      entityType: "tool_mcp_skill",
      entityId: row.id,
      details: { connectionId: row.connectionId, skillName: row.name, skillUri: row.skillUri, ...details },
    });
  }

  /**
   * Apply one entry from `skills/list` or `skills/get`. A new skill waits for
   * review. An approved skill stays approved only while its frontmatter and
   * manifest are unchanged; anything else revokes the approval. Dynamic and
   * oversized skills are declined with a reason the board can see.
   */
  async function applyEntry(
    connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId">,
    rawEntry: unknown,
    actor: Actor = SYSTEM_ACTOR,
    seenAt = now(),
  ): Promise<McpSkillRow | null> {
    const checked = checkMcpSkillEntry(rawEntry);
    if (!checked.ok && !checked.uri) return null;
    const skillUri = checked.ok ? checked.entry.uri : checked.uri!;
    const [existing] = await db.select().from(toolMcpSkills).where(and(
      eq(toolMcpSkills.companyId, connection.companyId),
      eq(toolMcpSkills.connectionId, connection.id),
      eq(toolMcpSkills.skillUri, skillUri),
    ));
    let next: Omit<typeof toolMcpSkills.$inferInsert, "companyId" | "connectionId" | "skillUri">;
    if (!checked.ok) {
      const frontmatter = (rawEntry as { frontmatter?: unknown })?.frontmatter;
      const record = frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter) ? frontmatter as Record<string, unknown> : {};
      next = {
        name: typeof record.name === "string" ? record.name.slice(0, 64) : skillUri.slice(0, 64),
        description: typeof record.description === "string" ? record.description.slice(0, 1024) : "",
        frontmatter: record,
        manifest: null,
        manifestDigest: null,
        status: "unavailable",
        statusReason: checked.reason,
        approvedManifestDigest: null,
        allowedToolsApproved: false,
      };
    } else {
      const { entry } = checked;
      const base = { name: entry.frontmatter.name, description: entry.frontmatter.description, frontmatter: entry.frontmatter };
      if (entry.resources === "dynamic") {
        // Generated content has no digests to bind an approval to.
        next = { ...base, manifest: null, manifestDigest: null, status: "unavailable", statusReason: "dynamic", approvedManifestDigest: null, allowedToolsApproved: false };
      } else {
        const manifestDigest = mcpSkillManifestDigest(entry.resources);
        const unchanged = existing?.manifestDigest === manifestDigest && isDeepStrictEqual(existing.frontmatter, entry.frontmatter);
        if (existing && unchanged && existing.status !== "unavailable") {
          await db.update(toolMcpSkills).set({ lastSeenAt: seenAt }).where(eq(toolMcpSkills.id, existing.id));
          return { ...existing, lastSeenAt: seenAt };
        }
        const wasReviewed = existing && (existing.status === "approved" || existing.status === "declined" || existing.reviewedAt !== null);
        next = {
          ...base,
          manifest: entry.resources,
          manifestDigest,
          status: "pending_review",
          statusReason: wasReviewed || existing ? "changed" : "new",
          approvedManifestDigest: null,
          allowedToolsApproved: false,
        };
        if (existing && unchanged && existing.status === "unavailable" && existing.statusReason === "verification_failed") {
          // Still the manifest whose content failed verification: keep it out of use.
          await db.update(toolMcpSkills).set({ lastSeenAt: seenAt }).where(eq(toolMcpSkills.id, existing.id));
          return { ...existing, lastSeenAt: seenAt };
        }
      }
    }
    if (!existing) {
      const [inserted] = await db.insert(toolMcpSkills).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        skillUri,
        ...next,
        lastSeenAt: seenAt,
      }).onConflictDoNothing().returning();
      if (inserted) await audit(inserted, "tool_mcp_skill.discovered", actor, { status: inserted.status, reason: inserted.statusReason });
      return inserted ?? null;
    }
    const [updated] = await db.update(toolMcpSkills).set({ ...next, lastSeenAt: seenAt, updatedAt: seenAt })
      .where(eq(toolMcpSkills.id, existing.id)).returning();
    if (updated && existing.status === "approved") {
      await audit(updated, "tool_mcp_skill.approval_revoked", actor, { reason: updated.statusReason });
    } else if (updated) {
      await audit(updated, "tool_mcp_skill.changed", actor, { status: updated.status, reason: updated.statusReason });
    }
    return updated ?? null;
  }

  return {
    applyEntry,

    /** Reconcile a full `skills/list` result for one connection. */
    async reconcileListing(connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId">, entries: unknown[], actor?: Actor) {
      const seenAt = now();
      const rows: McpSkillRow[] = [];
      for (const entry of entries) {
        const row = await applyEntry(connection, entry, actor, seenAt);
        if (row) rows.push(row);
      }
      // A listing may be partial (spec: Listing Skills), so an unlisted skill is
      // not proof of removal. A read that fails later refreshes it with skills/get.
      return rows;
    },

    /** A skill whose content failed verification is never used and needs review again. */
    async markVerificationFailed(row: McpSkillRow, actor: Actor, detail: string) {
      const [updated] = await db.update(toolMcpSkills).set({
        status: "unavailable", statusReason: "verification_failed",
        approvedManifestDigest: null, allowedToolsApproved: false, updatedAt: now(),
      }).where(eq(toolMcpSkills.id, row.id)).returning();
      if (updated) await audit(updated, row.status === "approved" ? "tool_mcp_skill.approval_revoked" : "tool_mcp_skill.changed", actor, { reason: "verification_failed", detail });
      return updated ?? null;
    },

    async markRemoved(row: McpSkillRow, actor: Actor) {
      const [updated] = await db.update(toolMcpSkills).set({
        status: "unavailable", statusReason: "removed", approvedManifestDigest: null, allowedToolsApproved: false, updatedAt: now(),
      }).where(eq(toolMcpSkills.id, row.id)).returning();
      if (updated) await audit(updated, row.status === "approved" ? "tool_mcp_skill.approval_revoked" : "tool_mcp_skill.changed", actor, { reason: "removed" });
      return updated ?? null;
    },

    async list(companyId: string): Promise<CompanyMcpSkill[]> {
      const rows = await db.select({ skill: toolMcpSkills, appName: toolConnections.name, applicationName: toolApplications.name })
        .from(toolMcpSkills)
        .innerJoin(toolConnections, and(eq(toolConnections.id, toolMcpSkills.connectionId), eq(toolConnections.companyId, companyId)))
        .innerJoin(toolApplications, and(eq(toolApplications.id, toolConnections.applicationId), eq(toolApplications.companyId, companyId)))
        .where(eq(toolMcpSkills.companyId, companyId))
        .orderBy(toolConnections.name, toolMcpSkills.name, toolMcpSkills.skillUri);
      const names = rows.map((row) => row.skill.name);
      const companySkillNames = names.length
        ? new Set((await db.select({ slug: companySkills.slug }).from(companySkills)
          .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.slug, [...new Set(names)])))).map((row) => row.slug))
        : new Set<string>();
      const counts = new Map<string, number>();
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      return rows.map(({ skill, appName, applicationName }) => toCompanyMcpSkill(skill, appName || applicationName,
        (counts.get(skill.name) ?? 0) > 1 || companySkillNames.has(skill.name)));
    },

    async get(companyId: string, id: string) {
      const [row] = await db.select().from(toolMcpSkills).where(and(eq(toolMcpSkills.companyId, companyId), eq(toolMcpSkills.id, id)));
      if (!row) throw notFound("Skill not found");
      return row;
    },

    /**
     * Approve a skill for agents. The approval binds to the manifest the board
     * reviewed: a request carrying any other digest is refused, so a skill that
     * changed while the page was open is never approved unseen.
     */
    async approve(companyId: string, id: string, input: { manifestDigest: string; allowTools?: boolean }, userId: string) {
      const [row] = await db.select().from(toolMcpSkills).where(and(eq(toolMcpSkills.companyId, companyId), eq(toolMcpSkills.id, id)));
      if (!row) throw notFound("Skill not found");
      if (!row.manifest || !row.manifestDigest || row.status === "unavailable") {
        throw unprocessable("This skill can't be approved.", { code: "mcp_skill_not_approvable" });
      }
      if (row.manifestDigest !== input.manifestDigest) {
        throw conflict("This skill changed since you opened it. Review it again.", { code: "mcp_skill_manifest_changed" });
      }
      const allowTools = input.allowTools === true && mcpSkillRequestedTools(row.frontmatter).length > 0;
      const reviewedAt = now();
      const [updated] = await db.update(toolMcpSkills).set({
        status: "approved", statusReason: null, approvedManifestDigest: row.manifestDigest,
        allowedToolsApproved: allowTools, reviewedAt, reviewedByUserId: userId, updatedAt: reviewedAt,
        // Only the skill the board reviewed: a failed verification or removal
        // since then changes `status`; a refresh changes the digest or frontmatter.
      }).where(and(
        eq(toolMcpSkills.id, row.id),
        eq(toolMcpSkills.manifestDigest, input.manifestDigest),
        inArray(toolMcpSkills.status, ["pending_review", "declined", "approved"]),
        sql`${toolMcpSkills.frontmatter} = ${JSON.stringify(row.frontmatter)}::jsonb`,
      )).returning();
      if (!updated) throw conflict("This skill changed since you opened it. Review it again.", { code: "mcp_skill_manifest_changed" });
      await audit(updated, "tool_mcp_skill.approved", { actorType: "user", actorId: userId }, { manifestDigest: updated.approvedManifestDigest, allowedToolsApproved: allowTools });
      return updated;
    },

    async decline(companyId: string, id: string, userId: string) {
      const reviewedAt = now();
      const [updated] = await db.update(toolMcpSkills).set({
        status: "declined", statusReason: null, approvedManifestDigest: null, allowedToolsApproved: false,
        reviewedAt, reviewedByUserId: userId, updatedAt: reviewedAt,
      }).where(and(eq(toolMcpSkills.companyId, companyId), eq(toolMcpSkills.id, id), ne(toolMcpSkills.status, "unavailable"))).returning();
      if (!updated) throw notFound("Skill not found");
      await audit(updated, "tool_mcp_skill.declined", { actorType: "user", actorId: userId });
      return updated;
    },

    /** Approved skills whose approval still matches their manifest, on the given connections. */
    async approvedForConnections(companyId: string, connectionIds: string[]) {
      if (!connectionIds.length) return [];
      return db.select().from(toolMcpSkills).where(and(
        eq(toolMcpSkills.companyId, companyId),
        inArray(toolMcpSkills.connectionId, connectionIds),
        eq(toolMcpSkills.status, "approved"),
        sql`${toolMcpSkills.approvedManifestDigest} = ${toolMcpSkills.manifestDigest}`,
      )).orderBy(toolMcpSkills.connectionId, toolMcpSkills.skillUri);
    },

    /** Any approved skill in the company, so runs without one pay a single indexed read. */
    async hasApproved(companyId: string) {
      const [row] = await db.select({ id: toolMcpSkills.id }).from(toolMcpSkills)
        .where(and(eq(toolMcpSkills.companyId, companyId), eq(toolMcpSkills.status, "approved"))).limit(1);
      return Boolean(row);
    },

    /** Verified bytes cached for this connection and digest, re-hashed on every read. */
    async cachedFile(row: Pick<McpSkillRow, "companyId" | "connectionId">, resource: McpSkillResource): Promise<Buffer | null> {
      const [cached] = await db.select({ contentBase64: toolMcpSkillFiles.contentBase64 }).from(toolMcpSkillFiles).where(and(
        eq(toolMcpSkillFiles.companyId, row.companyId),
        eq(toolMcpSkillFiles.connectionId, row.connectionId),
        eq(toolMcpSkillFiles.fileUri, resource.uri),
        eq(toolMcpSkillFiles.digest, resource.digest),
      ));
      if (!cached) return null;
      const bytes = Buffer.from(cached.contentBase64, "base64");
      try {
        verifyMcpSkillFileBytes(bytes, resource);
        return bytes;
      } catch {
        return null;
      }
    },

    async cacheFile(row: Pick<McpSkillRow, "companyId" | "connectionId">, resource: McpSkillResource, bytes: Buffer) {
      verifyMcpSkillFileBytes(bytes, resource);
      await db.insert(toolMcpSkillFiles).values({
        companyId: row.companyId, connectionId: row.connectionId, fileUri: resource.uri,
        digest: resource.digest, size: resource.size, contentBase64: bytes.toString("base64"),
      }).onConflictDoNothing();
    },
  };
}

export type McpSkillsService = ReturnType<typeof mcpSkillsService>;

export function toCompanyMcpSkill(row: McpSkillRow, appName: string, nameCollision: boolean): CompanyMcpSkill {
  const manifest = row.manifest;
  return {
    id: row.id,
    connectionId: row.connectionId,
    appName,
    name: row.name,
    description: row.description,
    skillUri: row.skillUri,
    status: row.status as McpSkillStatus,
    statusReason: (row.statusReason as McpSkillStatusReason | null) ?? null,
    manifestDigest: row.manifestDigest,
    fileCount: manifest ? manifest.length : null,
    totalBytes: manifest ? manifest.reduce((sum, file) => sum + file.size, 0) : null,
    requestedTools: mcpSkillRequestedTools(row.frontmatter),
    allowedToolsApproved: row.allowedToolsApproved,
    nameCollision,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/** The manifest entry for a path relative to the skill root, or null when it is not listed. */
export function mcpSkillManifestFile(row: Pick<McpSkillRow, "skillUri" | "manifest">, relativePath: string): McpSkillResource | null {
  if (!row.manifest) return null;
  const normalized = relativePath.replace(/^\.\//, "");
  return row.manifest.find((file) => mcpSkillRelativePath(row.skillUri, file.uri) === normalized) ?? null;
}

export type { McpSkillEntry };
