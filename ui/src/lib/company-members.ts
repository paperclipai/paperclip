import type { CompanyMember, CompanyUserDirectoryEntry } from "@/api/access";
import type { InlineEntityOption } from "@/components/InlineEntitySelector";
import type { MentionOption } from "@/components/MarkdownEditor";
import type { Agent, Issue, Project } from "@paperclipai/shared";
import { t } from "@/i18n";

export interface CompanyUserProfile {
  label: string;
  image: string | null;
}

type CompanyUserRecord = Pick<CompanyMember, "principalId" | "status" | "user">
  | CompanyUserDirectoryEntry;

// Provenance stays outside canonical maps/profiles: stored chat metadata,
// mentions, enumerable shapes and serialized values must remain language-free.
const fallbackLabelMaps = new WeakMap<ReadonlyMap<string, string>, Set<string>>();
const fallbackProfiles = new WeakSet<CompanyUserProfile>();

function hasGeneratedBoardLabel(member: Pick<CompanyUserRecord, "principalId" | "user">): boolean {
  return member.principalId === "local-board"
    && !member.user?.name?.trim()
    && !member.user?.email?.trim();
}

export function isGeneratedCompanyUserLabel(
  userId: string | null | undefined,
  labels: ReadonlyMap<string, string> | Record<string, string> | null | undefined,
): boolean {
  return Boolean(userId && labels instanceof Map
    && fallbackLabelMaps.get(labels)?.has(userId)
    && labels.get(userId) === "Board");
}

/** UI-only accessor; never use this value when constructing messages or payloads. */
export function companyUserLabelDisplayLabel(
  userId: string | null | undefined,
  labels: ReadonlyMap<string, string> | Record<string, string> | null | undefined,
): string | undefined {
  if (!userId || !labels) return undefined;
  if (isGeneratedCompanyUserLabel(userId, labels)) return t("localizationAssigneeChrome.board");
  return labels instanceof Map ? labels.get(userId) : (labels as Record<string, string>)[userId];
}

/** UI-only accessor; an explicit profile name, including "Board", stays raw. */
export function companyUserProfileDisplayLabel(profile: CompanyUserProfile | null | undefined): string | undefined {
  if (!profile) return undefined;
  return fallbackProfiles.has(profile) && profile.label === "Board"
    ? t("localizationAssigneeChrome.board")
    : profile.label;
}

function fallbackUserLabel(userId: string): string {
  if (userId === "local-board") return "Board";
  return userId.slice(0, 5);
}

function baseMemberLabel(member: Pick<CompanyUserRecord, "principalId" | "user">): string {
  const name = member.user?.name?.trim();
  if (name) return name;
  const email = member.user?.email?.trim();
  if (email) return email;
  return fallbackUserLabel(member.principalId);
}

function activeUniqueMembers(members: CompanyUserRecord[] | null | undefined) {
  const byId = new Map<string, CompanyUserRecord>();
  for (const member of members ?? []) {
    if (member.status !== "active") continue;
    if (!byId.has(member.principalId)) {
      byId.set(member.principalId, member);
    }
  }
  return [...byId.values()].sort((left, right) => baseMemberLabel(left).localeCompare(baseMemberLabel(right)));
}

export function buildCompanyUserLabelMap(members: CompanyUserRecord[] | null | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  const generated = new Set<string>();
  for (const member of members ?? []) {
    labels.set(member.principalId, baseMemberLabel(member));
    if (hasGeneratedBoardLabel(member)) generated.add(member.principalId);
    else generated.delete(member.principalId);
  }
  fallbackLabelMaps.set(labels, generated);
  return labels;
}

export function buildCompanyUserProfileMap(
  members: CompanyUserRecord[] | null | undefined,
): Map<string, CompanyUserProfile> {
  const profiles = new Map<string, CompanyUserProfile>();
  for (const member of members ?? []) {
    const profile = {
      label: baseMemberLabel(member),
      image: member.user?.image ?? null,
    };
    if (hasGeneratedBoardLabel(member)) fallbackProfiles.add(profile);
    profiles.set(member.principalId, profile);
  }
  return profiles;
}

export function buildCompanyUserInlineOptions(
  members: CompanyUserRecord[] | null | undefined,
  options?: { excludeUserIds?: Iterable<string | null | undefined> },
): InlineEntityOption[] {
  const exclude = new Set(
    [...(options?.excludeUserIds ?? [])].filter((value): value is string => Boolean(value)),
  );

  return activeUniqueMembers(members)
    .filter((member) => !exclude.has(member.principalId))
    .map((member) => ({
      id: `user:${member.principalId}`,
      label: baseMemberLabel(member),
      searchText: [member.user?.name, member.user?.email, member.principalId].filter(Boolean).join(" "),
    }));
}

export function buildCompanyUserMentionOptions(
  members: CompanyUserRecord[] | null | undefined,
): MentionOption[] {
  return activeUniqueMembers(members).map((member) => ({
    id: `user:${member.principalId}`,
    name: baseMemberLabel(member),
    kind: "user",
    userId: member.principalId,
  }));
}

export function isAgentTaskTarget(
  agent: Pick<Agent, "status"> & Partial<Pick<Agent, "orgChainHealth">>,
): boolean {
  return (
    agent.status !== "terminated" &&
    agent.status !== "pending_approval" &&
    agent.orgChainHealth?.status !== "invalid_org_chain"
  );
}

export function buildIssueMentionOptions(
  issues?: Array<Pick<Issue, "id" | "identifier" | "title">> | null | undefined,
): MentionOption[] {
  const options: MentionOption[] = [];
  for (const issue of issues ?? []) {
    const identifier = issue.identifier?.trim();
    if (!identifier) continue;
    const title = issue.title?.trim() ?? "";
    options.push({
      id: `issue:${issue.id}`,
      // `name` carries identifier + title so the picker matches either when
      // filtering; the dropdown renders the identifier and title separately.
      name: title ? `${identifier} ${title}` : identifier,
      kind: "issue",
      issueId: issue.id,
      issueIdentifier: identifier,
    });
  }
  return options;
}

export function buildMarkdownMentionOptions(args: {
  agents?: Array<Pick<Agent, "id" | "name" | "status" | "icon"> & Partial<Pick<Agent, "orgChainHealth">>> | null | undefined;
  projects?: Array<Pick<Project, "id" | "name" | "color">> | null | undefined;
  members?: CompanyUserRecord[] | null | undefined;
  issues?: Array<Pick<Issue, "id" | "identifier" | "title">> | null | undefined;
}): MentionOption[] {
  const options: MentionOption[] = [
    ...buildCompanyUserMentionOptions(args.members),
    ...[...(args.agents ?? [])]
      .filter(isAgentTaskTarget)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((agent) => ({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent" as const,
        agentId: agent.id,
        agentIcon: agent.icon,
      })),
    ...[...(args.projects ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((project) => ({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project" as const,
        projectId: project.id,
        projectColor: project.color,
      })),
    // Issues keep their incoming order (callers pass most-recently-updated first)
    // so the picker surfaces the freshest tasks before any query is typed.
    ...buildIssueMentionOptions(args.issues),
  ];

  return options;
}
