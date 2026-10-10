import { and, eq, like } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, toolOauthStates, type Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import type { CredentialMutationLeaseGuard } from "./chat-credential-mutation-lease.js";

// Keep generic connection removal independent of the registration service's
// authorization graph; access routes already load tool-access through the barrel.
export async function removeSlackRegistration(db: Db, endpointId: string, lease: CredentialMutationLeaseGuard) {
  const vault = secretService(db);
  const [row] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId));
  if (!row) return;
  await lease.assertOwned();
  await db.update(chatSlackRegistrations).set({ status: "removed", updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
  const [current] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
  if (current) await db.delete(toolOauthStates).where(and(eq(toolOauthStates.connectionId, current.connectionId), like(toolOauthStates.state, "slack-install.%")));
  for (const id of Object.values(row.secretIds)) { await lease.assertOwned(); await vault.remove(id); }
  await lease.assertOwned();
  await db.update(chatSlackRegistrations).set({ secretIds: {} }).where(eq(chatSlackRegistrations.endpointId, endpointId));
  }
