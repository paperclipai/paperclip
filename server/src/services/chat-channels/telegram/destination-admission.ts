import type { Thread } from "chat";
import { and, eq, ne, sql } from "drizzle-orm";
import { chatEndpointResources } from "@paperclipai/db";
import type { EndpointRow, DbTransaction, DbOrTransaction } from "../runtime-types.js";
import { nonDirectDestinationAllowed } from "../inbound/surfaces.js";

type DestinationAdmissionInput = {
  endpoint: EndpointRow;
  currentEndpoint: Pick<EndpointRow, "status" | "allowGroupChats">;
  thread: Thread;
  addressed: boolean;
};
type DestinationAdmissionOptions = {
  ensureResource: (endpoint: EndpointRow, thread: Thread, enableForSetup: boolean, database?: DbOrTransaction) => Promise<typeof chatEndpointResources.$inferSelect>;
};
export function createTelegramDestinationAdmission(options: DestinationAdmissionOptions) {
  const { ensureResource } = options;
  async function admitTelegramDestination(input: DestinationAdmissionInput, tx: DbTransaction) {
    const { endpoint, currentEndpoint, thread, addressed } = input;
    let destinationAccepting = true;

    let resource = await ensureResource(endpoint, thread, false, tx);
    const enabledResourceCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, endpoint.id),
          eq(chatEndpointResources.enabled, true),
          eq(chatEndpointResources.availability, "available"),
          ne(chatEndpointResources.type, "direct_message"),
          ne(chatEndpointResources.type, "group_chat"),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    const canActivateFirstSetupGroup =
      currentEndpoint.status === "verifying" &&
      resource.availability === "available" &&
      enabledResourceCount === 0 &&
      addressed;
    if (canActivateFirstSetupGroup && !resource.enabled) {
      resource = await tx
        .update(chatEndpointResources)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(chatEndpointResources.id, resource.id))
        .returning()
        .then((rows) => rows[0] ?? resource);
    }
    // Telegram's privacy-mode contract is explicit: in a group or forum
    // topic, every admitted turn must address the bot. A direct reply to a
    // bot message is normalized as a mention by the pinned adapter, while
    // unrelated subscribed traffic remains unaddressed and is filtered.
    destinationAccepting =
      addressed &&
      nonDirectDestinationAllowed(
        { ...endpoint, allowGroupChats: currentEndpoint.allowGroupChats },
        resource,
      );
    return destinationAccepting;
  }
  return { admitTelegramDestination };
}
