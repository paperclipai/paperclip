import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { mcpOauthGrants as grants, mcpOauthTokens as tokens, type Db } from "@paperclipai/db";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../paperclip-cloud-connector.js";
import { deriveLocalEncryptedInstanceSecret } from "../../secrets/local-encrypted-provider.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { mcpRevocationAuthorityId, mcpRevocationFingerprint, mcpRevocationKeyId, parseMcpRevocationIndexReceipt,
  type McpRevocationIndexIdentity, type McpRevocationIndexRequest, type McpRevocationIndexResponse } from "./revocation-index-contract.js";

function response(value: unknown): McpRevocationIndexResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP index response");
  const row = value as Record<string, unknown>;
  if (row.complete === true && Object.keys(row).sort().join() === "complete,receipt") return { complete: true, receipt: parseMcpRevocationIndexReceipt(row.receipt) };
  if (row.complete === false && Object.keys(row).sort().join() === "baseRevision,complete" && Number.isSafeInteger(row.baseRevision) && Number(row.baseRevision) >= -1) return { complete: false, baseRevision: Number(row.baseRevision) };
  throw new Error("Invalid MCP index response");
}
export function startMcpRevocationIndexSync(db: Db, coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  input: { client?: { publish: (request: McpRevocationIndexRequest) => Promise<unknown> }; key?: string } = {}) {
  const config = paperclipCloudConnectorConfigFromEnv();
  const connector = config ? createPaperclipCloudConnector({ config }) : undefined;
  const client = input.client ?? (connector ? { publish: (request: McpRevocationIndexRequest) => connector.syncMcpRevocationIndex({
    subject: request.operatorId, companyId: request.companyId, serialized: JSON.stringify(request) }) } : undefined);
  const requested = new Set<string>(["*"]);
  return coordinator.register(DELIVERY_QUEUES.mcpRevocationIndex, {
    retryMs: 5_000, pausePassiveMaintenance: true,
    onSettled: hints => { for (const hint of hints ?? ["*"]) requested.add(hint); },
    async run(signal) {


      const managed = getCloudRuntimeIdentity();
      if (!client || !managed) { requested.clear(); return; }
      const resources = [managed.canonicalOrigin + "/mcp/paperclip", managed.canonicalOrigin + "/mcp/runner"];
      const assertCurrentAuthority = () => {
        const current = getCloudRuntimeIdentity(), currentConfig = paperclipCloudConnectorConfigFromEnv();
        if (!current || current.stackId !== managed.stackId || current.canonicalOrigin !== managed.canonicalOrigin
          || config && (!currentConfig || currentConfig.instanceId !== config.instanceId || currentConfig.baseUrl !== config.baseUrl
            || currentConfig.environment !== config.environment || currentConfig.signPrivateKey !== config.signPrivateKey
            || currentConfig.sealPrivateKey !== config.sealPrivateKey)) throw new Error("MCP revocation index current authority changed");
      };
      const publish = (request: McpRevocationIndexRequest) => { assertCurrentAuthority(); return client.publish(request); };
      const hints = [...requested]; requested.clear();
      try {
        const [configured] = await db.select({ id: grants.id }).from(grants)
          .where(and(isNull(grants.revokedAt), inArray(grants.resource, resources))).limit(1);
        if (!configured) return;
        const key = input.key ?? deriveLocalEncryptedInstanceSecret(`mcp-revocation-index:v1:${config!.instanceId}`);
        const keyId = mcpRevocationKeyId(key);
        const pending = await db.select({ grant: grants }).from(grants)
          .where(and(isNull(grants.revokedAt), inArray(grants.resource, resources),
            sql`(COALESCE(${grants.revocationIndexReceipt}->'revision', 'null'::jsonb) <> to_jsonb(${grants.revocationRevision}) OR COALESCE(${grants.revocationIndexReceipt}->>'keyId', '') <> ${keyId})`))
          .orderBy(asc(grants.id)).limit(20);
        if (!pending.length) return;
        for (const { grant } of pending) {
          signal.throwIfAborted();
          if (grant.revocationIndexReceipt && grant.revocationIndexReceipt.keyId !== keyId) {


            await db.update(grants).set({ revocationIndexReceipt: null }).where(and(eq(grants.id, grant.id), eq(grants.revocationRevision, grant.revocationRevision)));
          }
          const identity: McpRevocationIndexIdentity = { authorityId: mcpRevocationAuthorityId(grant.id, keyId), companyId: grant.companyId, operatorId: grant.userId,
            clientId: grant.clientId, resource: grant.resource, revision: grant.revocationRevision, keyId };
          let result = response(await publish({ ...identity, operation: "begin", key }));
          if (!result.complete) {
            const baseRevision = result.baseRevision;
            if (baseRevision > grant.revocationRevision) throw new Error("MCP index base revision is in the future");
            let cursor: { revision: number; id: string } | undefined;
            while (!signal.aborted) {
              const page = await db.select({ id: tokens.id, tokenHash: tokens.tokenHash, kind: tokens.kind, revision: tokens.revocationRevision }).from(tokens)
                .where(and(eq(tokens.grantId, grant.id), gt(tokens.revocationRevision, baseRevision), lte(tokens.revocationRevision, grant.revocationRevision),
                  cursor ? or(gt(tokens.revocationRevision, cursor.revision), and(eq(tokens.revocationRevision, cursor.revision), gt(tokens.id, cursor.id))) : undefined))
                .orderBy(asc(tokens.revocationRevision), asc(tokens.id)).limit(200);
              if (page.some(token => token.kind !== "access" && token.kind !== "refresh")) throw new Error("Unknown MCP token kind cannot be indexed");
              if (page.length) result = response(await publish({ ...identity, operation: "append", entries: page.map(token => ({
                tokenKind: token.kind, fingerprint: mcpRevocationFingerprint(key, token.tokenHash, grant.clientId, grant.resource),
              })) }));
              if (page.length < 200) break;
              const last = page.at(-1)!; cursor = { revision: last.revision, id: last.id };
            }
            signal.throwIfAborted();
            result = response(await publish({ ...identity, operation: "complete" }));
          }
          if (!result.complete || result.receipt.authorityId !== identity.authorityId || result.receipt.keyId !== keyId || result.receipt.revision !== grant.revocationRevision) throw new Error("MCP revocation publication was not acknowledged");


          assertCurrentAuthority();
          await db.update(grants).set({ revocationIndexReceipt: result.receipt }).where(and(eq(grants.id, grant.id), eq(grants.revocationRevision, grant.revocationRevision), isNull(grants.revokedAt)));
        }
        if (pending.length === 20) requested.add("*");
      } catch (error) { for (const hint of hints) requested.add(hint); throw error; }
    },
    hasPending: async () => false,
    nextRunAt: () => requested.size ? Date.now() + 5_000 : null,
  });
}
