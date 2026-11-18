import type {
  ProposeResponsibilityBarInteraction,
  ResponsibilityBarConversation,
  ResponsibilityWithRollup,
} from "@paperclipai/shared";
import { api } from "./client";

/** Setting a responsibility's bar by talking to an agent (experimental `enableResponsibilities`). */
export const responsibilityBarsApi = {
  /** Where the responsibility's bar conversation stands, and which agent a new one would be with. */
  conversation: (responsibilityId: string) =>
    api.get<ResponsibilityBarConversation>(`/responsibilities/${encodeURIComponent(responsibilityId)}/bar-conversation`),
  /** Opens the conversation, or returns the one already open. */
  start: (responsibilityId: string, agentId?: string) =>
    api.post<ResponsibilityBarConversation>(
      `/responsibilities/${encodeURIComponent(responsibilityId)}/bar-conversation`,
      agentId ? { agentId } : {},
    ),
  /** `keepMetrics`: indexes of the proposal's supporting metrics to apply; leave it out to apply them all. */
  accept: (issueId: string, interactionId: string, options: { keepMetrics?: number[] } = {}) =>
    api.post<{ interaction: ProposeResponsibilityBarInteraction; responsibility: ResponsibilityWithRollup }>(
      `/issues/${encodeURIComponent(issueId)}/bar-proposals/${encodeURIComponent(interactionId)}/accept`,
      options.keepMetrics ? { keepMetrics: options.keepMetrics } : {},
    ),
  decline: (issueId: string, interactionId: string) =>
    api.post<ProposeResponsibilityBarInteraction>(
      `/issues/${encodeURIComponent(issueId)}/bar-proposals/${encodeURIComponent(interactionId)}/decline`,
      {},
    ),
};
