import type { chatEndpointResources } from "@paperclipai/db";

export function imessageResourceParticipants(resource: typeof chatEndpointResources.$inferSelect) {
  return resource.providerResourceId.startsWith("imessage-photon:") &&
    Array.isArray(resource.metadata.participants)
    ? resource.metadata.participants.flatMap((participant) => {
      const address =
        participant && typeof participant === "object"
          ? (participant as Record<string, unknown>).address
          : null;
      return typeof address === "string" ? [address] : [];
    })
    : undefined;
}
