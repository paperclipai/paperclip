import type {
  ConnectionIntentInteraction,
  ConnectionIntentSetupOptions,
} from "@paperclipai/shared";
import { api } from "./client";

export const connectionIntentsApi = {
  setupOptions: (interactionId: string) =>
    api.get<ConnectionIntentSetupOptions>(
      `/connection-intents/${interactionId}/setup-options`,
    ),
  setPhase: (
    interactionId: string,
    phase: ConnectionIntentInteraction["payload"]["phase"],
  ) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/phase`,
      { phase },
    ),
  complete: (interactionId: string, connectionId: string) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/complete`,
      { connectionId },
    ),
  decline: (interactionId: string, reason?: string) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/decline`,
      reason ? { reason } : {},
    ),
};
