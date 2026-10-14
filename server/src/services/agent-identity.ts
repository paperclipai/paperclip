import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentIdentityKeys, agents, type Db } from "@paperclipai/db";
import type { AgentPublicIdentity } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { persistActivity } from "./activity-log.js";

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

  return {
    // Reading an identity must never provision it or decrypt private material.
    async getPublicIdentity(companyId: string, agentId: string): Promise<AgentPublicIdentity | null> {
      const [row] = await db.select(publicColumns).from(agentIdentityKeys).where(ownership(companyId, agentId));
      return row ? { ...row, createdAt: row.createdAt.toISOString() } : null;
    },

    async ensureAgentIdentity(companyId: string, agentId: string) {
      return db.transaction(async (tx) => {
        // Lock the parent even when there is no identity row yet. This also
        // serializes deletion and works inside the agent-creation transaction.
        const [owner] = await tx.select({ id: agents.id }).from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
        if (!owner) throw notFound("Agent not found");
        let [row] = await tx.select().from(agentIdentityKeys).where(ownership(companyId, agentId));
        if (!row) {
          const keys = generateKeyPairSync("ed25519");
          const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
          const keyId = fingerprint(keys.publicKey.export({ type: "spki", format: "der" }));
          const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
          const encrypted = await localEncryptedProvider.createSecret({ value: privateKeyPem });
          [row] = await tx.insert(agentIdentityKeys).values({
            companyId, agentId, algorithm: "Ed25519", keyId, publicKeyPem,
            privateKeyMaterial: encrypted.material,
          }).returning();
          await persistActivity(tx as unknown as Db, {
            companyId, actorType: "system", actorId: "system",
            action: "agent.identity.created", entityType: "agent", entityId: agentId,
            details: { algorithm: "Ed25519", keyId },
          });
        }
        const privateKeyPem = await localEncryptedProvider.resolveVersion({
          material: row.privateKeyMaterial, externalRef: null,
        });
        // Fail closed on corruption or a wrong master key; never replace a key.
        const privateKey = createPrivateKey(privateKeyPem);
        const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
        const stored = createPublicKey(row.publicKeyPem).export({ type: "spki", format: "der" });
        if (row.algorithm !== "Ed25519" || privateKey.asymmetricKeyType !== "ed25519" ||
            !derived.equals(stored) || fingerprint(stored) !== row.keyId) {
          throw new Error("Agent identity public and private keys do not match");
        }
        return { keyId: row.keyId, publicKeyPem: row.publicKeyPem, privateKeyPem };
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
