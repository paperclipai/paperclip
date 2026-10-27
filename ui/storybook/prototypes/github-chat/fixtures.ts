import { initialAccess, type AccessPolicy } from "./AccessEditor";
export const steps = [
  "Choose agent",
  "Connect GitHub App",
  "Install GitHub App",
  "Select repositories",
  "Verify connection & tools",
  "Connect your account",
  "Configure behavior",
  "Try it",
];
export const sections = [
  "Settings",
  "Access",
  "Reviews",
  "Conversations",
  "Activity",
] as const;
export type Section = (typeof sections)[number];
export type Scenario =
  | "ready"
  | "existing"
  | "reconnect"
  | "expired"
  | "webhook"
  | "tools"
  | "permissions"
  | "runtime"
  | "identity"
  | "linked"
  | "guest"
  | "save-error"
  | "private-url"
  | "no-account"
  | "identity-expired"
  | "repositories-empty"
  | "repositories-error";
export type ReviewState =
  "passed" | "failed" | "running" | "queued" | "incomplete" | "manual";
export const prompts = {
  "New PR":
    "Review {{repository}}#{{pr_number}} at {{head_sha}}. Read the diff and relevant repository context. Use your GitHub tools to submit a review with findings, coverage, and a 0–5 assessment. Explain any limits.",
  "Updated commits":
    "The PR head changed from {{previous_head_sha}} to {{head_sha}}. Review the current changes, revisit prior findings, and publish new findings without duplicating existing comments.",
  "Reopened or ready":
    "This PR is now {{event_action}}. Review its current head {{head_sha}} and continue this Paperclip task.",
  Mention:
    "Respond to {{sender}} in this GitHub conversation. If they request a review, inspect the current PR and use the review tools. For ordinary questions, reply without changing its rating.",
  "Follow-up comment":
    "Continue the conversation with {{sender}}. Use the existing task and review context. Do not change the review rating unless a new review is requested.",
};
export type PromptKind = keyof typeof prompts;
export interface ReviewConfig {
  audience: string;
  responsible: string;
  opened: boolean;
  reopened: boolean;
  ready: boolean;
  commits: boolean;
  drafts: boolean;
  bots: boolean;
  summary: boolean;
  inline: boolean;
  approve: boolean;
  requestChanges: boolean;
  threshold: string;
  includeAuthors: string;
  excludeAuthors: string;
  includeBranches: string;
  excludeBranches: string;
  includeLabels: string;
  excludeLabels: string;
  ignoredFiles: string;
  severity: string;
  instructions: string;
  categories: string;
  templates: Record<PromptKind, string>;
}
export const defaultConfig: ReviewConfig = {
  audience: "linked",
  responsible: "Dotta",
  opened: true,
  reopened: true,
  ready: true,
  commits: true,
  drafts: false,
  bots: false,
  summary: true,
  inline: true,
  approve: false,
  requestChanges: false,
  threshold: "5",
  includeAuthors: "",
  excludeAuthors: "",
  includeBranches: "",
  excludeBranches: "",
  includeLabels: "",
  excludeLabels: "",
  ignoredFiles: "dist/**\n**/*.generated.*",
  severity: "P2",
  instructions:
    "Focus on correctness, security, and regressions. Explain findings with concrete evidence.",
  categories: "Correctness, security, performance",
  templates: { ...prompts },
};
export interface Draft {
  step: number;
  available: number;
  agent: string;
  name: string;
  owner: string;
  organization: string;
  connected: boolean;
  installed: boolean;
  verified: boolean;
  linked: boolean;
  accountLogin: string;
  access: AccessPolicy;
  testSent: boolean;
  repositories: string[];
  repositoryInventory: string[];
  config: ReviewConfig;
  overrides: Record<string, ReviewConfig>;
}
export function initialDraft(step: number, scenario: Scenario): Draft {
  return {
    step,
    available: step,
    agent: "Code Reviewer",
    name: "acme-reviewer",
    owner: "organization",
    organization: "acme",
    connected: step >= 2,
    installed: step >= 3,
    verified: step >= 5,
    linked: step >= 6 || scenario === "linked",
    accountLogin: "dotta",
    access: initialAccess(scenario === "guest"),
    testSent: false,
    repositories: ["repositories-empty", "repositories-error"].includes(
      scenario,
    )
      ? []
      : ["acme/platform"],
    repositoryInventory: ["repositories-empty", "repositories-error"].includes(
      scenario,
    )
      ? []
      : [...repositories],
    config: {
      ...defaultConfig,
      templates: { ...prompts },
    },
    overrides: {},
  };
}
export const repositories = [
  "acme/platform",
  "acme/design-system",
  "acme/docs",
];
export const reviewLabels: Record<ReviewState, string> = {
  passed: "Passed · 5/5",
  failed: "Below threshold · 3/5",
  running: "Reviewing current head",
  queued: "Queued",
  incomplete: "Incomplete · no score",
  manual: "Manual review needed",
};
