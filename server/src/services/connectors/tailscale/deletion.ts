import { and, eq } from "drizzle-orm";
import { tailscaleConnections, type Db } from "@paperclipai/db";
import type { CompanyDeletionParticipant } from "../../../lib/company-deletion.js";
import { tailscaleNetworks } from "./network.js";

export function createTailscaleCompanyDeletion(): CompanyDeletionParticipant & { stopNetworks(): Promise<void> } {
  const identities = new Set<string>();
  return {
    async deleteCompanyData(tx, companyId) {
      const rows = await tx.delete(tailscaleConnections).where(eq(tailscaleConnections.companyId, companyId))
        .returning({ secretId: tailscaleConnections.secretId });
      for (const row of rows) if (row.secretId) identities.add(`${companyId}:${row.secretId}`);
    },
    async stopNetworks() {
      const results = await Promise.allSettled([...identities].map(identity => tailscaleNetworks.disconnect(identity, { discardState: true })));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Tailscale company network cleanup failed");
    },
  };
}

export async function retireTailscaleSecret(db: Pick<Db, "update">, companyId: string, secretId: string): Promise<void> {
  const matching = and(eq(tailscaleConnections.companyId, companyId), eq(tailscaleConnections.secretId, secretId));
  const rows = await db.update(tailscaleConnections).set({ status: "disconnected", oauthStateHash: null,
    oauthExpiresAt: null, updatedAt: new Date() }).where(matching).returning({ id: tailscaleConnections.id });
  if (!rows.length) return;
  await tailscaleNetworks.disconnect(`${companyId}:${secretId}`, { discardState: true });
  await db.update(tailscaleConnections).set({ secretId: null, credentialVersion: null, credentialHash: null,
    updatedAt: new Date() }).where(matching);
}
