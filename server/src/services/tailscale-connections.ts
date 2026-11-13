import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { tailscaleConnections, type Db } from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, type PaperclipCloudConnector } from "./paperclip-cloud-connector.js";
import { secretService } from "./secrets.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { tailscaleNetworks } from "./tailscale-network.js";
import { readTailscaleDevices } from "./tailscale-devices.js";
import { createTailscalePairing } from "./tailscale-pairing.js";

const hash = (state: string) => createHash("sha256").update(state).digest("hex");
const projection = (row: typeof tailscaleConnections.$inferSelect) => ({ id: row.id, name: row.name, status: row.status, companyId: row.companyId });

export function tailscaleConnectionService(db: Db, dependencies: { connector?: () => PaperclipCloudConnector | null; now?: () => Date } = {}) {
  const secrets = secretService(db);
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

  async function open(companyId: string, id: string) {
    const row = await get(companyId, id);
    if (!row.secretId || row.status === "disconnected" || row.status === "pending") {
      throw unprocessable("Connect Tailscale before using this environment.", { code: "tailscale_reauthorization_required" });
    }
    const secretId = row.secretId;
    const read = () => secrets.resolveSecretValue(companyId, secretId, "latest", { accessContext: {
      consumerType: "system", consumerId: `tailscale-connection:${id}`, actorType: "system", actorId: null,
    } });
    const credential = await read();
    const socket = await tailscaleNetworks.connect({
      identity: `${companyId}:${secretId}`, credential, reload: read,
      persist: async value => { await secrets.rotate(secretId, { value }); },
    });
    return { row, socket };
  }

  return {
    get,
    async disconnect(companyId: string, id: string) {
      const row = await get(companyId, id);
      await db.update(tailscaleConnections).set({ status: "disconnected", oauthStateHash: null, oauthExpiresAt: null, updatedAt: now() }).where(eq(tailscaleConnections.id, id));
      if (row.secretId) await tailscaleNetworks.disconnect(`${companyId}:${row.secretId}`);
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
      await db.update(tailscaleConnections).set({ oauthStateHash: hash(state), oauthExpiresAt: expires, createdByUserId: input.userId, updatedAt: now() }).where(eq(tailscaleConnections.id, row.id));
      const session = await client.startAuthorization({ subject: input.userId, companyId: input.companyId, profile: "tailscale.tailnet", returnUri: input.returnUri, returnState: state });
      return { connection: projection(row), ...session };
    },
    async complete(input: { state: string; userId: string; claimId?: string; error?: string; authorizeCompany: (companyId: string) => void }) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw badRequest("Tailscale authorization expired. Connect again.");
      const [row] = await db.update(tailscaleConnections).set({ oauthStateHash: null, oauthExpiresAt: null, updatedAt: now() }).where(and(
        eq(tailscaleConnections.oauthStateHash, hash(input.state)), eq(tailscaleConnections.createdByUserId, input.userId), gt(tailscaleConnections.oauthExpiresAt, now()),
      )).returning();
      if (!row) throw badRequest("Tailscale authorization expired. Connect again.");
      input.authorizeCompany(row.companyId);
      if (input.error || !input.claimId) throw badRequest("Tailscale authorization did not complete. Connect again.");
      const grant = await connector().claim({ subject: input.userId, companyId: row.companyId, profile: "tailscale.tailnet", claimId: input.claimId, redemptionId: input.state });
      const expires = grant.accessTokenExpiresAt ? Date.parse(grant.accessTokenExpiresAt) : NaN;
      if (grant.refreshToken || !Number.isFinite(expires) || expires <= now().getTime()) throw unprocessable("Tailscale authorization expired. Connect again.");
      const secret = await secrets.create(row.companyId, { name: `Tailscale connection ${row.id} ${randomBytes(4).toString("hex")}`,
        provider: getConfiguredSecretProvider(), value: grant.accessToken }, { userId: input.userId });
      await db.update(tailscaleConnections).set({ secretId: secret.id, status: "connecting", updatedAt: now() }).where(eq(tailscaleConnections.id, row.id));
      await open(row.companyId, row.id);
      const [ready] = await db.update(tailscaleConnections).set({ status: "connected", updatedAt: now() }).where(eq(tailscaleConnections.id, row.id)).returning();
      return projection(ready!);
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
    async environmentBinding(companyId: string, id: string, deviceId: string) {
      const { row, socket } = await open(companyId, id);
      const device = (await readTailscaleDevices(socket)).find(device => device.id === deviceId);
      if (!device) throw unprocessable("This machine is no longer available on the connected tailnet.", { code: "tailscale_machine_unavailable" });
      if (!device.online) throw unprocessable("Your machine is offline. Wake it and retry the task.", { code: "tailscale_machine_offline" });
      return { host: device.address, secretId: row.secretId!, socket };
    },
  };
}
