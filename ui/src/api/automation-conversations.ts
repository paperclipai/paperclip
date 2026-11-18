import type {
  AcceptedAutomationProposal,
  AutomationConversation,
  ProposeAutomationInteraction,
} from "@paperclipai/shared";
import { api } from "./client";

/** Turning a manual task into an automation by talking to an agent (experimental `enableResponsibilities`). */
export const automationConversationsApi = {
  /** Where the task's automation conversation stands, and which agent a new one would be with. */
  conversation: (issueId: string) =>
    api.get<AutomationConversation>(`/issues/${encodeURIComponent(issueId)}/automation-conversation`),
  /** Opens the conversation with `agentId` (default: the responsible agent), or returns the one already open. */
  start: (issueId: string, body: { agentId?: string; responsibilityId?: string } = {}) =>
    api.post<AutomationConversation>(`/issues/${encodeURIComponent(issueId)}/automation-conversation`, body),
  accept: (issueId: string, interactionId: string, timezone: string) =>
    api.post<AcceptedAutomationProposal>(
      `/issues/${encodeURIComponent(issueId)}/automation-proposals/${encodeURIComponent(interactionId)}/accept`,
      { timezone },
    ),
  decline: (issueId: string, interactionId: string) =>
    api.post<ProposeAutomationInteraction>(
      `/issues/${encodeURIComponent(issueId)}/automation-proposals/${encodeURIComponent(interactionId)}/decline`,
      {},
    ),
};
