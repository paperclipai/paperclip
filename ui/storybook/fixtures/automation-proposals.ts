import type {
  AcceptedAutomationProposal,
  ProposeAutomationInteraction,
  ProposeAutomationPayload,
} from "@paperclipai/shared";
import { RESPONSIBILITY_FIXTURE_COMPANY_ID } from "./responsibilities";

/** Synthetic automation proposals, one per way an automation starts, for stories and UI tests. */
export const AUTOMATION_FIXTURE_AGENT_ID = "agent-codex";
export const AUTOMATION_FIXTURE_ISSUE_ID = "issue-automation-conversation";
export const AUTOMATION_FIXTURE_WEBHOOK_URL = "https://paperclip.example/api/routine-triggers/public/7f3a9c21d4e5b6a8c0d1e2f3/fire";
export const AUTOMATION_FIXTURE_WEBHOOK_SECRET = "3c9d0f6a1b2e4d5c8a7f9e0b1c2d3e4f5a6b7c8d9e0f1a2b";

export type AutomationProposalTriggerKind = ProposeAutomationPayload["trigger"]["kind"];

const FILED = [{ id: "resp-fundraising", title: "Seed extension" }, { id: "resp-lp-updates", title: "LP updates" }];

const PAYLOADS: Record<AutomationProposalTriggerKind, ProposeAutomationPayload> = {
  schedule: {
    version: 1,
    sourceIssueId: "task-done",
    sourceIdentifier: "PAP-30",
    sourceTitle: "Send the October update",
    title: "Send the monthly investor update",
    instructions: "Collect the month's pipeline changes, closed commitments and next steps, draft the update in the usual format, and send it to the investor list.",
    message: "You send this at the start of every month, so I can draft and send it then.",
    trigger: {
      kind: "schedule",
      cadence: { frequency: "monthly", dayOfWeek: null, dayOfMonth: 1, time: "09:00" },
      cadenceLabel: "On the 1st of every month at 9 AM",
      cronExpression: "0 9 1 * *",
    },
    startLabel: "On the 1st of every month at 9 AM",
    assigneeAgentId: AUTOMATION_FIXTURE_AGENT_ID,
    agentName: "CodexCoder",
    projectId: null,
    filedUnder: FILED,
  },
  webhook: {
    version: 1,
    sourceIssueId: "task-inbound",
    sourceIdentifier: "PAP-42",
    sourceTitle: "Reply to inbound investor emails",
    title: "Answer a new investor email",
    instructions: "Read the email, draft a reply in your voice with the deck link when they ask for materials, and file it for you to send.",
    message: "Your inbox tool can call this each time an investor writes in.",
    trigger: { kind: "webhook", caller: "The shared inbox, each time an email from an investor arrives" },
    startLabel: "When another system calls it",
    assigneeAgentId: AUTOMATION_FIXTURE_AGENT_ID,
    agentName: "CodexCoder",
    projectId: null,
    filedUnder: FILED.slice(0, 1),
  },
  standing_check: {
    version: 1,
    sourceIssueId: "task-chase",
    sourceIdentifier: "PAP-44",
    sourceTitle: "Chase LPs who have waited more than a week",
    title: "Chase LPs waiting on us",
    instructions: "Look through the open LP threads.",
    message: null,
    trigger: {
      kind: "standing_check",
      lookFor: "An LP who has waited more than a week for a reply",
      whenFound: "Draft the reply and create a task for you to send it",
    },
    startLabel: "Each time CodexCoder wakes up",
    assigneeAgentId: AUTOMATION_FIXTURE_AGENT_ID,
    agentName: "CodexCoder",
    projectId: null,
    filedUnder: [],
  },
};

export function automationProposalFixture(
  kind: AutomationProposalTriggerKind,
  overrides: Partial<ProposeAutomationInteraction> = {},
): ProposeAutomationInteraction {
  return {
    id: `automation-proposal-${kind}`,
    companyId: RESPONSIBILITY_FIXTURE_COMPANY_ID,
    issueId: AUTOMATION_FIXTURE_ISSUE_ID,
    kind: "propose_automation",
    status: "pending",
    continuationPolicy: "none",
    createdByAgentId: AUTOMATION_FIXTURE_AGENT_ID,
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    title: "Proposed automation",
    summary: `${PAYLOADS[kind].title} · ${PAYLOADS[kind].startLabel}`,
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_only", effective: "board_only" },
    createdAt: new Date("2026-11-13T10:00:00.000Z"),
    updatedAt: new Date("2026-11-13T10:00:00.000Z"),
    payload: PAYLOADS[kind],
    result: null,
    ...overrides,
  } as ProposeAutomationInteraction;
}

/** The card after a person set it up. */
export function acceptedAutomationProposalFixture(kind: AutomationProposalTriggerKind): ProposeAutomationInteraction {
  return automationProposalFixture(kind, {
    status: "accepted",
    result: {
      version: 1,
      outcome: "accepted",
      routineId: `routine-from-${kind}`,
      routineTitle: PAYLOADS[kind].title,
      cadenceLabel: kind === "schedule" ? "On the 1st of every month at 9 AM" : null,
      timezone: kind === "schedule" ? "America/Chicago" : null,
      webhookUrl: kind === "webhook" ? AUTOMATION_FIXTURE_WEBHOOK_URL : null,
      signingMode: kind === "webhook" ? "bearer" : null,
      responsibilityIds: PAYLOADS[kind].filedUnder.map((entry) => entry.id),
    },
  });
}

/** What accepting returns: for a webhook, the address and the secret, once. */
export function acceptedAutomationResponseFixture(kind: AutomationProposalTriggerKind): AcceptedAutomationProposal {
  return {
    interaction: acceptedAutomationProposalFixture(kind),
    routine: { id: `routine-from-${kind}`, title: PAYLOADS[kind].title, assigneeAgentId: AUTOMATION_FIXTURE_AGENT_ID, projectId: null, status: "active" },
    webhook: kind === "webhook" ? { url: AUTOMATION_FIXTURE_WEBHOOK_URL, secret: AUTOMATION_FIXTURE_WEBHOOK_SECRET, signingMode: "bearer" } : null,
  };
}
