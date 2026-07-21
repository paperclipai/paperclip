import {
  ConnectProtocolError,
  relayEnvelopeSchema,
  verifyRelaySignature,
  type RelayEnvelope,
} from "@paperclip/connect-protocol";

export type RelayTrigger = {
  id: string;
  destinationType: "routine" | "issue_wake" | "plugin_worker";
  destinationId: string;
};

export type ConnectionRelayStore = {
  findConnectionByPublicRef(publicRef: string): Promise<{ id: string; companyId: string; enabled: boolean } | null>;
  createDeliveryIfAbsent(input: { companyId: string; connectionId: string; envelope: RelayEnvelope }): Promise<boolean>;
  listEnabledTriggers(connectionId: string): Promise<RelayTrigger[]>;
};

export async function processConnectionRelay(
  store: ConnectionRelayStore,
  input: {
    rawBody: Buffer;
    signature: string | null | undefined;
    timestamp: string | null | undefined;
    relaySecret: Buffer | string;
    now?: Date;
  },
) {
  if (!input.signature || !input.timestamp || !verifyRelaySignature({
    body: input.rawBody,
    relaySecret: input.relaySecret,
    signature: input.signature,
    timestamp: input.timestamp,
    now: input.now,
  })) {
    throw new ConnectProtocolError("invalid_relay_signature", 401);
  }

  let envelope: RelayEnvelope;
  try {
    envelope = relayEnvelopeSchema.parse(JSON.parse(input.rawBody.toString("utf8")));
  } catch {
    throw new ConnectProtocolError("invalid_relay_envelope", 400);
  }

  const connection = await store.findConnectionByPublicRef(envelope.connectionPublicRef);
  if (!connection || !connection.enabled) {
    throw new ConnectProtocolError("connection_not_found", 404);
  }

  const inserted = await store.createDeliveryIfAbsent({ companyId: connection.companyId, connectionId: connection.id, envelope });
  if (!inserted) return { status: "duplicate" as const, envelope, triggers: [] as RelayTrigger[] };

  return { status: "accepted" as const, envelope, triggers: await store.listEnabledTriggers(connection.id) };
}
