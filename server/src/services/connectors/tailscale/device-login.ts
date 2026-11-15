import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { tailscaleConnections, type Db } from "@paperclipai/db";
import type { TailscaleDeviceLogin } from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { secretService } from "../../secrets.js";
import { getConfiguredSecretProvider } from "../../../secrets/configured-provider.js";
import { tailscaleNetworks } from "./network.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyState = "paperclip-tailscale-state-v1:" + Buffer.from("{}").toString("base64");
const projection = (row: typeof tailscaleConnections.$inferSelect) => ({ id: row.id, companyId: row.companyId, name: row.name, status: row.status });

export function tailscaleDeviceLoginService(db: Db, dependencies: {
  networks?: Pick<typeof tailscaleNetworks, "connect" | "disconnect" | "loginStatus">;
  secrets?: Pick<ReturnType<typeof secretService>, "createSystemSecret" | "resolveSystemSecretValue" | "rotate" | "remove">;
  now?: () => Date;
} = {}) {
  const networks = dependencies.networks ?? tailscaleNetworks;
  const secrets = dependencies.secrets ?? secretService(db);
  const now = dependencies.now ?? (() => new Date());
  const cancelled = () => unprocessable("Tailscale sign-in expired or was cancelled. Connect again.", { code: "tailscale_authorization_cancelled" });
  async function get(companyId: string, id: string) {
    const [row] = await db.select().from(tailscaleConnections).where(and(eq(tailscaleConnections.companyId, companyId), eq(tailscaleConnections.id, id)));
    if (!row) throw notFound("Tailscale connection not found");
    return row;
  }

  async function resume(companyId: string, id: string, userId: string): Promise<TailscaleDeviceLogin> {
    const row = await get(companyId, id);
    if (row.createdByUserId !== userId) throw forbidden("Only the person who started this sign-in can continue it.");
    if (row.status !== "authorizing") return { connection: projection(row), expiresAt: null };
    if (!row.secretId || !row.oauthStateHash?.startsWith("device:")) throw cancelled();
    const secretId = row.secretId;
    const identity = `${companyId}:${secretId}`;
    const owned = and(eq(tailscaleConnections.companyId, companyId), eq(tailscaleConnections.id, id),
      eq(tailscaleConnections.secretId, secretId), eq(tailscaleConnections.oauthStateHash, row.oauthStateHash));
    if (!row.oauthExpiresAt || row.oauthExpiresAt <= now()) {
      const expired = await db.update(tailscaleConnections).set({ status: "expired", oauthExpiresAt: null, updatedAt: now() })
        .where(and(owned, eq(tailscaleConnections.status, "authorizing"))).returning();
      if (expired.length) await networks.disconnect(identity);
      return { connection: projection(await get(companyId, id)), expiresAt: null };
    }
    async function current() {
      const latest = await get(companyId, id);
      if (latest.secretId !== secretId || latest.oauthStateHash !== row.oauthStateHash
        || !["authorizing", "connected"].includes(latest.status)) throw cancelled();
      if (!latest.credentialVersion || !latest.credentialHash) throw cancelled();
      return latest;
    }
    const read = async () => {
      const latest = await current();
      const value = await secrets.resolveSystemSecretValue(companyId, secretId, latest.credentialVersion!, "tailscale_network", `tailscale-connection:${id}`);
      if (digest(value) !== latest.credentialHash) throw cancelled();
      return value;
    };
    try {
      await networks.connect({ identity, credential: await read(), reload: read,
        persist: async value => {
          const latest = await get(companyId, id);
          if (latest.secretId !== secretId || latest.oauthStateHash !== row.oauthStateHash
            || !["authorizing", "connected"].includes(latest.status)) return;
          const saved = await secrets.rotate(secretId, { value });
          const [updated] = await db.update(tailscaleConnections).set({ credentialVersion: saved.latestVersion, credentialHash: digest(value), updatedAt: now() })
            .where(and(owned, eq(tailscaleConnections.credentialVersion, latest.credentialVersion!), eq(tailscaleConnections.credentialHash, latest.credentialHash!))).returning();
          if (!updated) throw cancelled();
        },
        login: { expiresAt: row.oauthExpiresAt.getTime(),
          onAuthorized: async () => {
            await db.transaction(async tx => {
              const [ready] = await tx.update(tailscaleConnections).set({ status: "connected", oauthExpiresAt: null, updatedAt: now() })
                .where(and(owned, eq(tailscaleConnections.status, "authorizing"), gt(tailscaleConnections.oauthExpiresAt, now()))).returning();
              if (!ready) throw cancelled();
              await logActivity(tx as unknown as Db, { companyId, actorType: "user", actorId: userId, action: "tailscale.connected", entityType: "tailscale_connection", entityId: id });
            });
          },
          onFailure: async () => {
            await db.update(tailscaleConnections).set({ status: row.oauthExpiresAt! <= now() ? "expired" : "error", oauthExpiresAt: null, updatedAt: now() })
              .where(and(owned, eq(tailscaleConnections.status, "authorizing")));
          },
        },
      });
      const status = await networks.loginStatus(identity);
      const latest = await current();
      return { connection: projection(latest), expiresAt: latest.oauthExpiresAt?.toISOString() ?? null,
        ...(latest.status === "authorizing" && status ? { authorizationUrl: status.authorizationUrl, needsApproval: status.status === "needs_approval" } : {}) };
    } catch {
      const failed = await db.update(tailscaleConnections).set({ status: "error", oauthExpiresAt: null, updatedAt: now() })
        .where(and(owned, eq(tailscaleConnections.status, "authorizing"))).returning();
      if (failed.length) await networks.disconnect(identity);
      throw unprocessable("Tailscale sign-in could not start. Check that Tailscale is installed, then try again.", { code: "tailscale_device_login_failed" });
    }
  }

  return {
    resume,
    async start(input: { companyId: string; userId: string; name: string; connectionId?: string }): Promise<TailscaleDeviceLogin> {
      const row = input.connectionId ? await get(input.companyId, input.connectionId)
        : (await db.insert(tailscaleConnections).values({ companyId: input.companyId, name: input.name, createdByUserId: input.userId }).returning())[0]!;
      if (row.status === "connected") throw unprocessable("Disconnect this network before replacing its connection.");
      if (row.status === "authorizing" && row.oauthExpiresAt && row.oauthExpiresAt > now()) return resume(input.companyId, row.id, input.userId);
      const state = `device:${randomBytes(32).toString("hex")}`;
      const expiresAt = new Date(now().getTime() + 10 * 60_000);
      const secret = await secrets.createSystemSecret(input.companyId, { name: `Tailscale connection ${row.id} ${randomBytes(4).toString("hex")}`,
        provider: getConfiguredSecretProvider(), value: emptyState }, "tailscale_network", { userId: input.userId });
      try {
        const [started] = await db.update(tailscaleConnections).set({ status: "authorizing", secretId: secret.id,
          credentialVersion: secret.latestVersion, credentialHash: digest(emptyState), oauthStateHash: state, oauthExpiresAt: expiresAt,
          createdByUserId: input.userId, updatedAt: now() }).where(and(eq(tailscaleConnections.id, row.id), eq(tailscaleConnections.companyId, input.companyId), eq(tailscaleConnections.status, row.status),
            row.oauthStateHash === null ? isNull(tailscaleConnections.oauthStateHash) : eq(tailscaleConnections.oauthStateHash, row.oauthStateHash))).returning();
        if (!started) throw cancelled();
      } catch (error) {
        await secrets.remove(secret.id);
        throw error;
      }
      if (row.secretId) await networks.disconnect(`${input.companyId}:${row.secretId}`);
      return resume(input.companyId, row.id, input.userId);
    },
  };
}
