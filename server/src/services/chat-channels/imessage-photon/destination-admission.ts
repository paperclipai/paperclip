import type { Thread } from "chat";

import { chatEndpointResources } from "@paperclipai/db";
import type { EndpointRow, DbTransaction, DbOrTransaction } from "../runtime-types.js";

type DestinationAdmissionInput = {
  endpoint: EndpointRow;
  currentEndpoint: Pick<EndpointRow, "status" | "allowGroupChats">;
  thread: Thread;

};
type DestinationAdmissionOptions = {
  ensureResource: (endpoint: EndpointRow, thread: Thread, enableForSetup: boolean, database?: DbOrTransaction) => Promise<typeof chatEndpointResources.$inferSelect>;
};
export function createPhotonDestinationAdmission(options: DestinationAdmissionOptions) {
  const { ensureResource } = options;
  async function admitPhotonDestination(input: DestinationAdmissionInput, tx: DbTransaction) {
    const { endpoint, currentEndpoint, thread } = input;
    let destinationAccepting = true;

    const resource = await ensureResource(endpoint, thread, false, tx);
    destinationAccepting =
      resource.enabled &&
      resource.availability === "available" &&
      currentEndpoint.allowGroupChats;
    return destinationAccepting;
  }
  return { admitPhotonDestination };
}
