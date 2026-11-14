import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentIdentityKeys, agents, type Db } from "@paperclipai/db";
import type { AgentPublicIdentity } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { persistActivity } from "./activity-log.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";

const publicColumns = {
  algorithm: agentIdentityKeys.algorithm,
  keyId: agentIdentityKeys.keyId,
  publicKeyPem: agentIdentityKeys.publicKeyPem,
  createdAt: agentIdentityKeys.createdAt,
};

export function agentIdentityService(db: Db) {
  const ownership = (companyId: string, agentId: string) => and(
    eq(agentIdentityKeys.companyId, companyId), eq(agentIdentityKeys.agentId, agentId),
  );
  async function resolveIdentity(row: typeof agentIdentityKeys.$inferSelect) {
    const privateKeyPem = await localEncryptedProvider.resolveVersion({ material: row.privateKeyMaterial, externalRef: null });
    const privateKey = createPrivateKey(privateKeyPem);
    const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const stored = createPublicKey(row.publicKeyPem).export({ type: "spki", format: "der" });
    if (row.algorithm !== "Ed25519" || privateKey.asymmetricKeyType !== "ed25519" ||
      !derived.equals(stored) || fingerprint(stored) !== row.keyId)
      throw new Error("Agent identity public and private keys do not match");
    return { keyId: row.keyId, publicKeyPem: row.publicKeyPem, privateKeyPem };
  }

  return {
    // Reading an identity must never provision it or decrypt private material.
    async getPublicIdentity(companyId: string, agentId: string): Promise<AgentPublicIdentity | null> {
      const [row] = await db.select(publicColumns).from(agentIdentityKeys).where(ownership(companyId, agentId));
      return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
    },
    async createExistingLogRedactor(companyId: string, agentId: string) {
      const [row] = await db.select().from(agentIdentityKeys).where(ownership(companyId, agentId));
      return createAgentIdentityRedactor(row ? (await resolveIdentity(row)).privateKeyPem : undefined);
    },

    async ensureAgentIdentity(companyId: string, agentId: string) {
      // Every managed run setup reuses the key. Read it without an agent row
      // lock: queued-run claims share-lock that row, and an exclusive waiter
      // there joins their deadlock cycles as the non-retried victim.
      const [existing] = await db.select().from(agentIdentityKeys).where(ownership(companyId, agentId));
      // Fail closed on corruption or a wrong master key; never replace a key.
      if (existing) return resolveIdentity(existing);
      return db.transaction(async (tx) => {
        // KEY SHARE is the lock the identity foreign key takes anyway. It still
        // fences deletion and works inside the agent-creation transaction.
        const [owner] = await tx.select({ id: agents.id }).from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("key share");
        if (!owner) throw notFound("Agent not found");
        const keys = generateKeyPairSync("ed25519");
        const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
        const keyId = fingerprint(keys.publicKey.export({ type: "spki", format: "der" }));
        const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const encrypted = await localEncryptedProvider.createSecret({ value: privateKeyPem });
        const [created] = await tx.insert(agentIdentityKeys).values({
          companyId, agentId, algorithm: "Ed25519", keyId, publicKeyPem,
          privateKeyMaterial: encrypted.material,
        }).onConflictDoNothing({ target: agentIdentityKeys.agentId }).returning();
        if (!created) {
          // A concurrent first run committed its key; adopt it.
          const [winner] = await tx.select().from(agentIdentityKeys).where(ownership(companyId, agentId));
          if (!winner) throw new Error("Agent identity key belongs to another owner");
          return resolveIdentity(winner);
        }
        await persistActivity(tx as unknown as Db, {
          companyId, actorType: "system", actorId: "system",
          action: "agent.identity.created", entityType: "agent", entityId: agentId,
          details: { algorithm: "Ed25519", keyId },
        });
        return resolveIdentity(created);
      });
    },
  };
}

function fingerprint(spki: Buffer): string {
  return `sha256:${createHash("sha256").update(spki).digest("base64url")}`;
}

export function supportsManagedAgentIdentity(
  adapterType: string,
  config?: { provider?: unknown },
  persistedDriver?: string | null,
): boolean {
  if (adapterType === "paperclip_runner") {
    // API-hosted providers have no process environment under our control.
    return persistedDriver
      ? ["codex", "codex_app_server", "opencode_server", "acpx_runtime"].includes(persistedDriver)
      : [undefined, "codex", "opencode", "acpx"].includes(config?.provider as string | undefined);
  }
  return new Set([
    "process", "claude_local", "codex_local", "cursor_cloud",
    "gemini_local", "grok_local", "hermes_local", "kimi_local", "opencode_local", "pi_local", "cursor",
  ]).has(adapterType);
}
