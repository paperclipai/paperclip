import type { Message, Thread } from "chat";
import { and, eq, sql } from "drizzle-orm";
import { chatEndpointResources } from "@paperclipai/db";
import type { EndpointRow, DbTransaction, DbOrTransaction } from "../runtime-types.js";
import { nonDirectDestinationAllowed, teamsThreadRootMessageId } from "../inbound/surfaces.js";

type DestinationAdmissionInput = {
  endpoint: EndpointRow;
  currentEndpoint: Pick<EndpointRow, "status" | "allowGroupChats">;
  thread: Thread;
  message: Message;
  addressed: boolean;
};
type DestinationAdmissionOptions = {
  ensureResource: (endpoint: EndpointRow, thread: Thread, enableForSetup: boolean, database?: DbOrTransaction) => Promise<typeof chatEndpointResources.$inferSelect>;
};
export function createTeamsDestinationAdmission(options: DestinationAdmissionOptions) {
  const { ensureResource } = options;
  async function admitTeamsDestination(input: DestinationAdmissionInput, tx: DbTransaction) {
    const { endpoint, currentEndpoint, thread, message, addressed } = input;
    let destinationAccepting = true;
    let provisionalTeamsSetupReply = false;

    let resource = await ensureResource(endpoint, thread, false, tx);
    const enabledChannelCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, endpoint.id),
          eq(chatEndpointResources.enabled, true),
          eq(chatEndpointResources.availability, "available"),
          eq(chatEndpointResources.type, "channel"),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    const canActivateFirstSetupChannel =
      currentEndpoint.status === "verifying" &&
      resource.type === "channel" &&
      resource.availability === "available" &&
      enabledChannelCount === 0 &&
      addressed;
    if (canActivateFirstSetupChannel && !resource.enabled) {
      resource = await tx
        .update(chatEndpointResources)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(chatEndpointResources.id, resource.id))
        .returning()
        .then((rows) => rows[0] ?? resource);
    }
    const teamsRootMessageId = teamsThreadRootMessageId(thread.id);
    provisionalTeamsSetupReply =
      currentEndpoint.status === "verifying" &&
      resource.type === "channel" &&
      resource.availability === "available" &&
      enabledChannelCount === 0 &&
      !addressed &&
      Boolean(teamsRootMessageId) &&
      teamsRootMessageId !== message.id;
    destinationAccepting =
      nonDirectDestinationAllowed(
        { ...endpoint, allowGroupChats: currentEndpoint.allowGroupChats },
        resource,
      ) || provisionalTeamsSetupReply;
    return { destinationAccepting, provisionalTeamsSetupReply };
  }
  return { admitTeamsDestination };
}
