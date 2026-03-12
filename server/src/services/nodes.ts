import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { nodes, nodeApiKeys } from "@paperclipai/db";
import type { NodeStatus } from "@paperclipai/shared";

/** How long a node can be unseen before we consider it offline (90 seconds). */
const NODE_ONLINE_THRESHOLD_MS = 90_000;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function nodeService(db: Db) {
  async function create(input: {
    companyId: string;
    name: string;
    capabilities?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    actorType?: string;
    actorId?: string;
  }) {
    const [row] = await db
      .insert(nodes)
      .values({
        companyId: input.companyId,
        name: input.name,
        capabilities: input.capabilities ?? {},
        metadata: input.metadata ?? {},
        registeredByActorType: input.actorType ?? null,
        registeredByActorId: input.actorId ?? null,
      })
      .returning();
    return row;
  }

  async function list(companyId: string) {
    return db
      .select()
      .from(nodes)
      .where(eq(nodes.companyId, companyId))
      .orderBy(desc(nodes.createdAt));
  }

  async function getById(nodeId: string) {
    const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
    return row ?? null;
  }

  async function update(
    nodeId: string,
    patch: {
      name?: string;
      status?: NodeStatus;
      capabilities?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ) {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;

    const [row] = await db
      .update(nodes)
      .set(set)
      .where(eq(nodes.id, nodeId))
      .returning();
    return row ?? null;
  }

  async function remove(nodeId: string) {
    // Revoke all API keys first
    await db
      .update(nodeApiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(nodeApiKeys.nodeId, nodeId), isNull(nodeApiKeys.revokedAt)));

    const [row] = await db.delete(nodes).where(eq(nodes.id, nodeId)).returning();
    return row ?? null;
  }

  async function recordHeartbeat(nodeId: string) {
    const now = new Date();
    const [row] = await db
      .update(nodes)
      .set({ lastSeenAt: now, status: "online", updatedAt: now })
      .where(eq(nodes.id, nodeId))
      .returning();
    return row ?? null;
  }

  function isOnline(node: { lastSeenAt: Date | string | null; status: string }) {
    if (node.status !== "online") return false;
    if (!node.lastSeenAt) return false;
    const lastSeen = typeof node.lastSeenAt === "string" ? new Date(node.lastSeenAt).getTime() : node.lastSeenAt.getTime();
    return Date.now() - lastSeen < NODE_ONLINE_THRESHOLD_MS;
  }

  // ---- Node API key management ----

  async function createApiKey(input: { nodeId: string; companyId: string; name: string }) {
    const rawKey = `pnk_${randomUUID().replace(/-/g, "")}`;
    const keyHash = hashToken(rawKey);
    const [row] = await db
      .insert(nodeApiKeys)
      .values({
        nodeId: input.nodeId,
        companyId: input.companyId,
        name: input.name,
        keyHash,
      })
      .returning();
    return { ...row, key: rawKey };
  }

  async function validateApiKey(token: string) {
    const tokenHash = hashToken(token);
    const [key] = await db
      .select()
      .from(nodeApiKeys)
      .where(and(eq(nodeApiKeys.keyHash, tokenHash), isNull(nodeApiKeys.revokedAt)));
    if (!key) return null;

    // Update lastUsedAt
    await db
      .update(nodeApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(nodeApiKeys.id, key.id));

    return key;
  }

  async function revokeApiKey(keyId: string) {
    const [row] = await db
      .update(nodeApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(nodeApiKeys.id, keyId))
      .returning();
    return row ?? null;
  }

  return {
    create,
    list,
    getById,
    update,
    remove,
    recordHeartbeat,
    isOnline,
    createApiKey,
    validateApiKey,
    revokeApiKey,
  };
}
