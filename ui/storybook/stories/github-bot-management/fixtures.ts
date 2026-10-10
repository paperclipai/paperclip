import {
  defaultGitHubReviewPolicy,
  type GitHubChatConfiguration,
  type GitHubTaskReview,
} from "@paperclipai/shared";
import type {
  ChatEndpoint,
  ChatEndpointResource,
  ChatConversation,
  ChatIdentityLink,
} from "@/api/chatEndpoints";
import { STORYBOOK_COMPANY_ID } from "../../fixtures/onboardingDraft";
import { storybookAgents } from "../../fixtures/paperclipData";

export const agent = { ...storybookAgents[0], name: "Maya" };
export const endpoint: ChatEndpoint = {
  id: "story-github-bot",
  companyId: STORYBOOK_COMPANY_ID,
  provider: "github",
  status: "active",
  assignedAgentId: agent.id,
  assignedAgentName: agent.name,
  connectionId: "story-github-tools",
  botLabel: "Maya Reviews",
  botUsername: "maya-reviews[bot]",
  providerAccountLabel: "acme",
  allowUnlinkedPeople: false,
  setup: {
    step: "complete",
    github: {
      stage: "verify",
      appSlug: "maya-reviews",
      ownerType: "organization",
      ownerLogin: "acme",
    },
  },
};
export const configuration: GitHubChatConfiguration = {
  version: 1,
  toolsEnabled: true,
  responsibleUserId: "user-board",
  memberAccess: "selected",
  people: [
    {
      kind: "member",
      userId: "user-board",
      githubUserId: "42",
      login: "mayacoder",
      automaticReviews: true,
    },
  ],
  defaults: {
    ...defaultGitHubReviewPolicy(),
    invocation: "allowed_authors",
    events: ["opened", "synchronize"],
    issueOpened: true,
    instructions:
      "Review for correctness and security. Explain important findings clearly, and suggest a focused fix. For issues, help the author understand the next step.",
  },
  repositories: {},
};
export const resources: ChatEndpointResource[] = [
  {
    id: "web",
    type: "repository",
    providerResourceId: "acme/web",
    label: "acme/web",
    availability: "available",
    enabled: true,
    metadata: { providerRepositoryId: "100" },
  },
  {
    id: "api",
    type: "repository",
    providerResourceId: "acme/api",
    label: "acme/api",
    availability: "available",
    enabled: false,
    metadata: { providerRepositoryId: "101" },
  },
];
export const links: ChatIdentityLink[] = [
  {
    id: "maya",
    principalId: "maya",
    githubUserId: "42",
    githubLogin: "mayacoder",
    externalLabel: "mayacoder",
    paperclipUserId: "user-board",
    paperclipUserLabel: "Maya Chen",
    status: "linked",
  },
  {
    id: "vin",
    principalId: "vin",
    githubUserId: "43",
    githubLogin: "vin-dev",
    externalLabel: "vin-dev",
    paperclipUserId: "vin-member",
    paperclipUserLabel: "Vin Patel",
    status: "linked",
  },
];
export const members = {
  members: [
    {
      principalId: "user-board",
      status: "active",
      membershipRole: "owner",
      user: { name: "Maya Chen" },
    },
    {
      principalId: "vin-member",
      status: "active",
      membershipRole: "operator",
      user: { name: "Vin Patel" },
    },
  ],
};
export function review(
  id: string,
  headSha: string,
  createdAt: string,
): GitHubTaskReview {
  return {
    id,
    companyId: endpoint.companyId,
    endpointId: endpoint.id,
    issueId: `task-${id}`,
    runId: null,
    repositoryId: "100",
    repository: "acme/web",
    pullNumber: 24,
    headSha,
    configurationRevision: 2,
    event: {
      event: "opened",
      deliveryId: `delivery-${id}`,
      repositoryId: "100",
      repository: "acme/web",
      pullNumber: 24,
      title: "Fix keyboard focus in the account picker",
      body: "",
      baseSha: "0000000",
      headSha,
      baseBranch: "main",
      author: { id: "42", login: "mayacoder", isBot: false },
      sender: { id: "42", login: "mayacoder" },
      draft: false,
      labels: [],
    },
    state: "completed",
    assessment: {
      reviewedCommit: headSha,
      score: 5,
      complete: true,
      summary:
        "**5/5** — Focus returns to the trigger after dismissal. Keyboard navigation and the loading state are covered.\n\n```text\n /\\_/\\\n( o.o )\n > ^ <\n```",
      rationale:
        "The change preserves the picker’s existing access rules and handles dismissal without losing focus.",
      coverage: {
        reviewedPaths: ["ui/AccountPicker.tsx", "ui/AccountPicker.test.tsx"],
        omittedPaths: [],
        limitations: [],
      },
      findings: [],
    },
    conclusion: "success",
    checkUrl: "https://github.com/acme/web/pull/24/checks",
    summaryUrl: "https://github.com/acme/web/pull/24#issuecomment-123",
    createdAt,
    updatedAt: createdAt,
  };
}
export const reviews = [
  review(
    "latest",
    "b046e7e18bdda6208515088540aee438091ab120",
    "2026-10-07T12:43:00Z",
  ),
  review(
    "previous",
    "c1525d7a904142590babb421971e7590d0a03b26",
    "2026-10-07T12:33:00Z",
  ),
];
export const conversations: ChatConversation[] = [
  {
    id: "pr",
    externalLabel: "acme/web",
    externalUrl: "https://github.com/acme/web/pull/24",
    issueId: "task-latest",
    issueIdentifier: "PAP-24",
    issueTitle: "Fix keyboard focus in the account picker",
    state: "completed",
    updatedAt: "2026-10-07T12:43:00Z",
  },
  {
    id: "issue",
    externalLabel: "acme/web",
    externalUrl: "https://github.com/acme/web/issues/25",
    issueId: "task-issue",
    issueIdentifier: "PAP-25",
    issueTitle: "Investigate the sign-in error after an invitation",
    state: "active",
    updatedAt: "2026-10-07T12:50:00Z",
  },
];
