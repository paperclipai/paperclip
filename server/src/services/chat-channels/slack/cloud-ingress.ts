import type { Db } from "@paperclipai/db";
import { chatEndpoints, toolConnections } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import type { createChatCredentials } from "../credentials.js";
import type { EndpointRow, InternalSetupState } from "../runtime-types.js";
import { receiveSlackCloudEvent, type CurrentSlackCloudBinding, type SlackCloudEvent } from "./cloud-event.js";

type Handler = (event: SlackCloudEvent) => Promise<void>;
const handlers = new WeakMap<Db, Handler>();

/** The chat owner installs a handler that holds its existing credential mutation
 * lease, reads the current endpoint/enrollment and calls receiveSlackCloudEvent.
 * Connector queue dispatch remains protocol-independent. */
export function registerSlackCloudEventIngress(db: Db, handler: Handler) {
  handlers.set(db, handler);
  return () => { if (handlers.get(db) === handler) handlers.delete(db); };
}

/** Called only for an event authenticated by the sealed connector event lane.
 * An absent runtime owner must retain the Cloud lease, never acknowledge it. */
export async function dispatchSlackCloudEvent(db: Db, event: SlackCloudEvent): Promise<void> {
  const handler = handlers.get(db);
  if (!handler) throw new Error("Slack Cloud ingress is not ready");
  await handler(event);
}

/** Installs the actual chat owner. Arrival is the only trigger: merely retaining
 * an enrollment adds no scan or SQL. Existing mutation leases fence current
 * credentials/configuration snapshot. The normal runtime generation fence then
 * owns durable admission; lifecycle callbacks can acquire their own leases. */
export function createSlackCloudEventIngress(db: Db, options: {
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  runtimeGeneration(endpoint: EndpointRow): number;
  handleWebhook(publicId: string, provider: "slack", request: Request, expectedGeneration: number): Promise<Response>;
}) {
  return registerSlackCloudEventIngress(db, async event => {
    const value = event.payload.slackEvent;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Slack Cloud receipt");
    const packet = value as Record<string, unknown>;
    if (typeof packet.endpointId !== "string" || !/^[a-f0-9-]{36}$/i.test(packet.endpointId))
      throw new Error("Invalid Slack Cloud endpoint");
    const [initial] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, packet.endpointId)).limit(1);
    if (!initial || initial.provider !== "slack" || ["archived", "paused", "revoked"].includes(initial.status)) return;
    const binding = await options.withCredentialMutationLease(initial, async (lease): Promise<CurrentSlackCloudBinding | null> => {
      const [current] = await db.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints)
        .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
        .where(eq(chatEndpoints.id, initial.id)).limit(1);
      if (!current || current.endpoint.provider !== "slack" || ["archived", "paused", "revoked"].includes(current.endpoint.status)
        || current.connection.status !== "active" || !current.connection.enabled) return null;
      const endpoint = current.endpoint;
      if (packet.companyId !== endpoint.companyId || packet.publicId !== endpoint.publicId
        || packet.connectionId !== endpoint.connectionId || packet.runtimeGeneration !== options.runtimeGeneration(endpoint)) return null;
      const enrolled = (endpoint.setup as InternalSetupState).slackCloudEvents;
      // Enrollment can have committed at Cloud before its response/local save.
      // Absence on an otherwise-current active endpoint cannot authorize ACK.
      if (!enrolled) throw new Error("Slack Cloud enrollment is not locally committed");
      if (enrolled.version !== 1 || enrolled.runtimeGeneration !== options.runtimeGeneration(endpoint)
        || enrolled.teamId !== endpoint.providerAccountId) throw new Error("Slack Cloud enrollment is unsettled");
      const credentials = await options.resolveCredentials(endpoint, db, ["signingSecret"]);
      await lease.assertOwned();
      return { companyId: endpoint.companyId, endpointId: endpoint.id,
        publicId: endpoint.publicId, connectionId: endpoint.connectionId, runtimeGeneration: options.runtimeGeneration(endpoint),
        bindingId: enrolled.bindingId, teamId: enrolled.teamId, appId: enrolled.appId, signingSecret: credentials.signingSecret };
    });
    if (!binding) return;
    await receiveSlackCloudEvent(event, binding,
      request => options.handleWebhook(binding.publicId, "slack", request, binding.runtimeGeneration));
  });
}
