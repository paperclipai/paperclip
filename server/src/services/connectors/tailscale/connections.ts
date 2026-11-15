import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { tailscaleConnections, type Db } from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../../../errors.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { secretService } from "../../secrets.js";
import { getConfiguredSecretProvider } from "../../../secrets/configured-provider.js";
import { tailscaleNetworks } from "./network.js";
import { readTailscaleDevices } from "./devices.js";
import { createTailscalePairing } from "./pairing.js";

const hash = (state: string) => createHash("sha256").update(state).digest("hex");
const projection = (row: typeof tailscaleConnections.$inferSelect) => ({ id: row.id, name: row.name, status: row.status, companyId: row.companyId });

export function tailscaleConnectionService(db: Db, dependencies: {
  connector?: () => PaperclipCloudConnector | null;
  now?: () => Date;
  secrets?: Pick<ReturnType<typeof secretService>, "create" | "createSystemSecret" | "resolveSystemSecretValue" | "rotate" | "remove">;
  networks?: Pick<typeof tailscaleNetworks, "connect" | "disconnect">;
} = {}) {
  const secrets = dependencies.secrets ?? secretService(db);
  const networks = dependencies.networks ?? tailscaleNetworks;
  const now = dependencies.now ?? (() => new Date());
  const connector = () => {
    const config = dependencies.connector ? null : paperclipCloudConnectorConfigFromEnv();
    const result = dependencies.connector?.() ?? (config ? createPaperclipCloudConnector({ config }) : null);
    if (!result) throw unprocessable("Connect this Paperclip instance to Paperclip Cloud before connecting Tailscale.", { code: "tailscale_oauth_unavailable" });
    return result;
  };

  async function get(companyId: string, id: string) {
    const [row] = await db.select().from(tailscaleConnections).where(and(eq(tailscaleConnections.id, id), eq(tailscaleConnections.companyId, companyId)));
    if (!row) throw notFound("Tailscale connection not found");
    return row;
  }

  const cancelled = () => unprocessable("Tailscale authorization was cancelled or replaced. Connect again.", { code: "tailscale_authorization_cancelled" });

  async function open(companyId: string, id: string, attempt?: { secretId: string; stateHash: string }, expectedSecretId?: string) {
    const assertExpected = (row: typeof tailscaleConnections.$inferSelect) => {
      if (expectedSecretId !== undefined && (row.secretId !== expectedSecretId || row.status !== "connected")) {
        throw unprocessable("Reconnect Tailscale and save this environment again.", { code: "tailscale_reauthorization_required" });
      }
    };
    const row = await get(companyId, id);
    assertExpected(row);
    if (!row.secretId || (row.status !== "connected" && row.status !== "connecting")) {
      if (attempt) throw cancelled();
      throw unprocessable("Connect Tailscale before using this environment.", { code: "tailscale_reauthorization_required" });
    }
    const secretId = row.secretId;
    const current = async () => {
      const latest = await get(companyId, id);
      assertExpected(latest);
      if (latest.secretId !== secretId || (latest.status !== "connected" && latest.status !== "connecting")
        || (attempt && (attempt.secretId !== secretId || latest.oauthStateHash !== attempt.stateHash || latest.oauthExpiresAt !== null))) throw cancelled();
      return latest;
    };
    const untrusted = () => unprocessable("Reconnect Tailscale to verify this network credential.", { code: "tailscale_credential_untrusted" });
    const trusted = (saved: typeof tailscaleConnections.$inferSelect) => {
      if (typeof saved.credentialVersion !== "number" || !Number.isInteger(saved.credentialVersion) || saved.credentialVersion < 1
        || typeof saved.credentialHash !== "string" || !/^[a-f0-9]{64}$/.test(saved.credentialHash)) throw untrusted();
      return { version: saved.credentialVersion, hash: saved.credentialHash };
    };
    const read = async () => {
      const pinned = trusted(await current());
      const value = await secrets.resolveSystemSecretValue(companyId, secretId, pinned.version, "tailscale_network", `tailscale-connection:${id}`);
      if (hash(value) !== pinned.hash) throw untrusted();
      return value;
    };
    const credential = await read();
    const socket = await networks.connect({
      identity: `${companyId}:${secretId}`, credential, reload: read,
      persist: async value => {
        const [latest] = await db.select().from(tailscaleConnections).where(and(eq(tailscaleConnections.id, id), eq(tailscaleConnections.companyId, companyId)));
        if (!latest || latest.secretId !== secretId || (latest.status !== "connected" && latest.status !== "connecting")) return;
        const pinned = trusted(latest);
        const saved = await secrets.rotate(secretId, { value });
        await db.update(tailscaleConnections).set({ credentialVersion: saved.latestVersion, credentialHash: hash(value), updatedAt: now() })
          .where(and(eq(tailscaleConnections.id, id), eq(tailscaleConnections.companyId, companyId), eq(tailscaleConnections.secretId, secretId),
            eq(tailscaleConnections.credentialVersion, pinned.version), eq(tailscaleConnections.credentialHash, pinned.hash)));
      },
    });
    return { row: await current(), socket, assertCurrent: current };
  }

  return {
    get,
    async disconnect(companyId: string, id: string) {
      const [row] = await db.update(tailscaleConnections).set({ status: "disconnected", oauthStateHash: randomBytes(32).toString("hex"), oauthExpiresAt: null, updatedAt: now() })
        .where(and(eq(tailscaleConnections.id, id), eq(tailscaleConnections.companyId, companyId))).returning();
      if (!row) throw notFound("Tailscale connection not found");
      if (row.secretId) await networks.disconnect(`${companyId}:${row.secretId}`);
      return { ...projection(row), status: "disconnected" };
    },
    async list(companyId: string) {
      return (await db.select().from(tailscaleConnections).where(eq(tailscaleConnections.companyId, companyId))).map(projection);
    },
    async start(input: { companyId: string; userId: string; name: string; returnUri: string; connectionId?: string }) {
      const client = connector();
      const state = randomBytes(32).toString("base64url");
      const expires = new Date(now().getTime() + 10 * 60_000);
      const row = input.connectionId ? await get(input.companyId, input.connectionId)
        : (await db.insert(tailscaleConnections).values({ companyId: input.companyId, name: input.name, createdByUserId: input.userId }).returning())[0]!;
      const [started] = await db.update(tailscaleConnections).set({ oauthStateHash: hash(state), oauthExpiresAt: expires, createdByUserId: input.userId,
        status: row.status === "connected" ? "connected" : "pending", updatedAt: now() }).where(and(eq(tailscaleConnections.id, row.id), eq(tailscaleConnections.companyId, input.companyId),
          row.oauthStateHash === null ? isNull(tailscaleConnections.oauthStateHash) : eq(tailscaleConnections.oauthStateHash, row.oauthStateHash))).returning();
      if (!started) throw cancelled();
      if (started.status === "pending" && started.secretId) await networks.disconnect(`${input.companyId}:${started.secretId}`);
      const session = await client.startAuthorization({ subject: input.userId, companyId: input.companyId, profile: "tailscale.tailnet", returnUri: input.returnUri, returnState: state });
      return { connection: projection(started), ...session };
    },
    async complete(input: { state: string; userId: string; claimId?: string; error?: string; authorizeCompany: (companyId: string, connectionId: string) => void }) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw badRequest("Tailscale authorization expired. Connect again.");
      const stateHash = hash(input.state);
      const [row] = await db.update(tailscaleConnections).set({ oauthExpiresAt: null, updatedAt: now() }).where(and(
        eq(tailscaleConnections.oauthStateHash, stateHash), eq(tailscaleConnections.createdByUserId, input.userId), gt(tailscaleConnections.oauthExpiresAt, now()),
      )).returning();
      if (!row) throw badRequest("Tailscale authorization expired. Connect again.");
      const owned = and(eq(tailscaleConnections.id, row.id), eq(tailscaleConnections.companyId, row.companyId),
        eq(tailscaleConnections.oauthStateHash, stateHash), isNull(tailscaleConnections.oauthExpiresAt));
      let secretId: string | null = null;
      try {
        input.authorizeCompany(row.companyId, row.id);
        if (input.error || !input.claimId) throw badRequest("Tailscale authorization did not complete. Connect again.");
        const grant = await connector().claim({ subject: input.userId, companyId: row.companyId, profile: "tailscale.tailnet", claimId: input.claimId, redemptionId: input.state });
        const expires = grant.accessTokenExpiresAt ? Date.parse(grant.accessTokenExpiresAt) : NaN;
        if (grant.refreshToken || !Number.isFinite(expires) || expires <= now().getTime()) throw unprocessable("Tailscale authorization expired. Connect again.");
        const [active] = await db.select({ id: tailscaleConnections.id }).from(tailscaleConnections).where(owned);
        if (!active) throw cancelled();
        const secret = await secrets.createSystemSecret(row.companyId, { name: `Tailscale connection ${row.id} ${randomBytes(4).toString("hex")}`,
          provider: getConfiguredSecretProvider(), value: grant.accessToken }, "tailscale_network", { userId: input.userId });
        secretId = secret.id;
        const [installed] = await db.update(tailscaleConnections).set({ secretId, credentialVersion: secret.latestVersion, credentialHash: hash(grant.accessToken), status: "connecting", updatedAt: now() }).where(owned).returning();
        if (!installed) throw cancelled();
        if (row.secretId && row.secretId !== secretId) await networks.disconnect(`${row.companyId}:${row.secretId}`);
        await open(row.companyId, row.id, { secretId, stateHash });
        const [ready] = await db.update(tailscaleConnections).set({ status: "connected", updatedAt: now() })
          .where(and(owned, eq(tailscaleConnections.secretId, secretId), eq(tailscaleConnections.status, "connecting"))).returning();
        if (!ready) throw cancelled();
        return projection(ready);
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (secretId) {
          for (const clean of [
            () => networks.disconnect(`${row.companyId}:${secretId}`),
            () => db.update(tailscaleConnections).set({ secretId: null, credentialVersion: null, credentialHash: null, updatedAt: now() }).where(and(
              eq(tailscaleConnections.id, row.id), eq(tailscaleConnections.companyId, row.companyId), eq(tailscaleConnections.secretId, secretId!),
            )),
            () => secrets.remove(secretId!),
          ]) { try { await clean(); } catch (failure) { cleanupErrors.push(failure); } }
        }
        try {
          await db.update(tailscaleConnections).set({ oauthStateHash: randomBytes(32).toString("hex"), oauthExpiresAt: null, ...(secretId ? { status: "disconnected" } : {}), updatedAt: now() }).where(owned);
        } catch (failure) { cleanupErrors.push(failure); }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Tailscale authorization cleanup failed");
        throw error;
      }
    },
    async devices(companyId: string, id: string) {
      return readTailscaleDevices((await open(companyId, id)).socket);
    },
    async pairing(companyId: string, id: string, deviceId: string, port: number, userId: string) {
      const { socket } = await open(companyId, id);
      const device = (await readTailscaleDevices(socket)).find(device => device.id === deviceId);
      if (!device) throw unprocessable("Choose a machine on this tailnet before pairing.");
      return createTailscalePairing({ vault: secrets, provider: getConfiguredSecretProvider(), companyId, connectionId: id, deviceId, address: device.address, port, userId });
    },
    async environmentBinding(companyId: string, id: string, deviceId: string, expectedSecretId?: string) {
      const { row, socket, assertCurrent } = await open(companyId, id, undefined, expectedSecretId);
      const device = (await readTailscaleDevices(socket)).find(device => device.id === deviceId);
      await assertCurrent();
      if (!device) throw unprocessable("This machine is no longer available on the connected tailnet.", { code: "tailscale_machine_unavailable" });
      if (!device.online) throw unprocessable("Your machine is offline. Wake it and retry the task.", { code: "tailscale_machine_offline" });
      return { host: device.address, secretId: row.secretId!, socket };
    },
  };
}
