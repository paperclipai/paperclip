import type {
  Agent,
  ProposeDashboardChangesInteraction,
  ProposeDashboardChangesPayload,
  ResponsibilityDashboardChange,
  ResponsibilityDashboardState,
  ResponsibilityDashboardVersionList,
  ResponsibilityDashboardVersionSummary,
} from "@paperclipai/shared";
import { RESPONSIBILITY_FIXTURE_COMPANY_ID, RESPONSIBILITY_FIXTURE_OWNER_ID } from "./responsibilities";

/** Synthetic dashboard conversations, proposals and versions, for stories and UI tests. */
export const DASHBOARD_FIXTURE_AGENT_ID = "agent-dashboard-guide";
export const DASHBOARD_FIXTURE_ISSUE_ID = "issue-dashboard-conversation";
const NOW = new Date("2026-11-16T10:00:00.000Z");

export const dashboardFixtureAgent = {
  id: DASHBOARD_FIXTURE_AGENT_ID,
  companyId: RESPONSIBILITY_FIXTURE_COMPANY_ID,
  name: "Chief",
  urlKey: "chief",
  status: "idle",
  createdAt: new Date("2026-10-01T00:00:00Z"),
} as Agent;

export const dashboardFixtureAgents: ReadonlyMap<string, Agent> = new Map([[DASHBOARD_FIXTURE_AGENT_ID, dashboardFixtureAgent]]);

function change(index: number, values: Partial<ResponsibilityDashboardChange> & Pick<ResponsibilityDashboardChange, "op" | "groupName">): ResponsibilityDashboardChange {
  return {
    index,
    reason: null,
    dependsOn: [],
    groupAreaId: null,
    groupRef: null,
    name: null,
    fromName: null,
    responsibilityId: null,
    sentence: null,
    fromSentence: null,
    fromAreaId: null,
    fromAreaName: null,
    lettingGo: [],
    sharedWith: 0,
    ...values,
  };
}

/** A first dashboard: four new areas and a few responsibilities under each, from the interview. */
export const createSizedChanges: ResponsibilityDashboardChange[] = [
  change(0, { op: "add_area", groupRef: "fund", groupName: "Fundraising", name: "Fundraising" }),
  change(1, { op: "add_responsibility", groupRef: "fund", groupName: "Fundraising", dependsOn: [0], sentence: "Every prospective LP hears from us at least every two weeks.", reason: "You run the weekly fundraising sync and have 14 open LP threads." }),
  change(2, { op: "add_responsibility", groupRef: "fund", groupName: "Fundraising", dependsOn: [0], sentence: "The data room always has this quarter's numbers." }),
  change(3, { op: "add_area", groupRef: "portfolio", groupName: "Portfolio", name: "Portfolio" }),
  change(4, { op: "add_responsibility", groupRef: "portfolio", groupName: "Portfolio", dependsOn: [3], sentence: "Every portfolio company gets its quarterly update on time." }),
  change(5, { op: "add_responsibility", groupRef: "portfolio", groupName: "Portfolio", dependsOn: [3], sentence: "Founders hear back within a day when they ask for help.", reason: "You said replies to founders are where you are most behind." }),
  change(6, { op: "add_area", groupRef: "team", groupName: "Team", name: "Team" }),
  change(7, { op: "add_responsibility", groupRef: "team", groupName: "Team", dependsOn: [6], sentence: "Every open role has a hiring plan and an owner." }),
  change(8, { op: "add_area", groupRef: "board", groupName: "Board", name: "Board" }),
  change(9, { op: "add_responsibility", groupRef: "board", groupName: "Board", dependsOn: [8], sentence: "Directors get the board pack a week before each meeting." }),
];

/** A small edit: a reword, a move, a removal with its reason, and a rename seen by others too. */
export const smallEditChanges: ResponsibilityDashboardChange[] = [
  change(0, { op: "reword_responsibility", groupAreaId: "area-fundraising", groupName: "Fundraising", responsibilityId: "resp-lps", fromSentence: "LPs hear from us often.", sentence: "Every prospective LP hears from us at least every two weeks.", reason: "You said two weeks is the promise." }),
  change(1, { op: "move_responsibility", groupAreaId: "area-portfolio", groupName: "Portfolio", responsibilityId: "resp-updates", fromSentence: "LP updates go out by the 5th of each month.", fromAreaId: "area-fundraising", fromAreaName: "Fundraising" }),
  change(2, { op: "remove_responsibility", groupAreaId: "area-team", groupName: "Team", responsibilityId: "resp-designer", fromSentence: "Hire a second designer.", reason: "That is a task that finishes, not something you keep true." }),
  change(3, { op: "rename_area", groupAreaId: "area-team", groupName: "Team", fromName: "Team", name: "People", sharedWith: 2 }),
];

function payload(changes: ResponsibilityDashboardChange[], mode: ProposeDashboardChangesPayload["mode"], message: string | null): ProposeDashboardChangesPayload {
  return { version: 1, ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, mode, message, changes };
}

export function dashboardChangesFixture(
  kind: "create" | "edit" = "create",
  overrides: Partial<ProposeDashboardChangesInteraction> = {},
): ProposeDashboardChangesInteraction {
  return {
    id: `dashboard-changes-${kind}`,
    companyId: RESPONSIBILITY_FIXTURE_COMPANY_ID,
    issueId: DASHBOARD_FIXTURE_ISSUE_ID,
    kind: "propose_dashboard_changes",
    status: "pending",
    continuationPolicy: "none",
    createdByAgentId: DASHBOARD_FIXTURE_AGENT_ID,
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    title: "Proposed dashboard changes",
    summary: null,
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_only", effective: "board_only" },
    createdAt: NOW,
    updatedAt: NOW,
    payload: kind === "create"
      ? payload(createSizedChanges, "create", "A first dashboard from your answers and your calendar.")
      : payload(smallEditChanges, "edit", "Four small changes from what you asked."),
    result: null,
    ...overrides,
  } as ProposeDashboardChangesInteraction;
}

function version(id: string, values: Partial<ResponsibilityDashboardVersionSummary>): ResponsibilityDashboardVersionSummary {
  return {
    id,
    cause: "person",
    summary: "No changes",
    actorUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    actorAgentId: null,
    previousVersionId: null,
    restoredFromVersionId: null,
    createdAt: NOW,
    ...values,
  };
}

export const dashboardVersionsFixture: ResponsibilityDashboardVersionList = {
  ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
  versions: [
    version("version-5", { cause: "person", summary: "Added 1 responsibility", previousVersionId: "version-4", createdAt: new Date("2026-11-16T09:40:00Z") }),
    version("version-4", { cause: "restore", summary: "Let go of 1 responsibility", previousVersionId: "version-3", restoredFromVersionId: "version-2", createdAt: new Date("2026-11-15T16:05:00Z") }),
    version("version-3", { cause: "change_set", summary: "Reworded 1 responsibility, moved 1 responsibility and let go of 1 responsibility", actorAgentId: DASHBOARD_FIXTURE_AGENT_ID, previousVersionId: "version-2", createdAt: new Date("2026-11-15T15:58:00Z") }),
    version("version-2", { cause: "change_set", summary: "Added 4 areas and 6 responsibilities", actorAgentId: DASHBOARD_FIXTURE_AGENT_ID, previousVersionId: "version-1", createdAt: new Date("2026-11-12T11:20:00Z") }),
    version("version-1", { cause: "person", summary: "Empty", actorUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, createdAt: new Date("2026-11-12T11:19:00Z") }),
  ],
};

/** The latest applied change, for the Undo line. */
export const latestChangeFixture = version("version-change", {
  cause: "change_set",
  summary: "Added 4 areas and 6 responsibilities",
  actorAgentId: DASHBOARD_FIXTURE_AGENT_ID,
  previousVersionId: "version-before",
  createdAt: NOW,
});

const conversation = (mode: "create" | "edit") => ({
  issueId: DASHBOARD_FIXTURE_ISSUE_ID,
  identifier: "PAP-120",
  title: mode === "create" ? "Create my dashboard" : "Edit my dashboard",
  status: "in_progress",
  agentId: DASHBOARD_FIXTURE_AGENT_ID,
  mode,
  createdAt: NOW,
});

/** The edit module's read in each state. */
export function dashboardStateFixture(
  kind: "empty" | "populated" | "empty_talking" | "talking" | "create_proposal" | "edit_proposal" | "applied" | "no_agent",
): ResponsibilityDashboardState {
  const base: ResponsibilityDashboardState = {
    ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    empty: kind === "empty" || kind === "empty_talking" || kind === "create_proposal" || kind === "no_agent",
    state: "none",
    defaultAgentId: kind === "no_agent" ? null : DASHBOARD_FIXTURE_AGENT_ID,
    conversation: null,
    proposal: null,
    latestChange: null,
  };
  switch (kind) {
    case "empty_talking":
      return { ...base, state: "discussing", conversation: conversation("create") };
    case "talking":
      return { ...base, state: "discussing", conversation: conversation("edit") };
    case "create_proposal":
      return { ...base, state: "proposal_waiting", conversation: conversation("create"), proposal: dashboardChangesFixture("create") };
    case "edit_proposal":
      return { ...base, state: "proposal_waiting", conversation: conversation("edit"), proposal: dashboardChangesFixture("edit") };
    case "applied":
      return { ...base, state: "settled", conversation: { ...conversation("create"), status: "done" }, latestChange: latestChangeFixture };
    default:
      return base;
  }
}
