import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, CompanySecret, Project } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { responsibilitiesApi } from "@/api/responsibilities";
import { secretsApi } from "@/api/secrets";
import type { MentionOption } from "@/components/MarkdownEditor";
import { useQueryView } from "@/components/QueryView";
import { useResolvedViewerId } from "@/hooks/useResolvedViewerId";
import { useResponsibilitiesEnabled } from "@/hooks/useResponsibilitiesEnabled";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { buildCompanyUserProfileMap, buildMarkdownMentionOptions } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import type { RoutineResponsibilityOption } from "./RoutineEditDialog";
import type { RoutinePerson } from "./RoutinePage";

// Stable empty lists, so memoized consumers do not rebuild while reads are pending.
const NO_AGENTS: Agent[] = [];
const NO_PROJECTS: Project[] = [];
const NO_SECRETS: CompanySecret[] = [];

/**
 * Everything the routine page and the edit/create form choose from: agents,
 * projects, people, secrets, mention options and (only while the experimental
 * flag is on) responsibilities. Shared by the routine page and the routines
 * list so both open the same form with the same choices.
 */
export function useRoutineFormOptions(
  companyId: string | null | undefined,
  { active = true }: { active?: boolean } = {},
) {
  const queryClient = useQueryClient();
  // Nothing is fetched until the form (or page) that needs these choices is shown.
  const enabled = Boolean(companyId) && active;
  const { enabled: responsibilitiesOn } = useResponsibilitiesEnabled();

  const { userId } = useResolvedViewerId({ enabled: enabled && responsibilitiesOn });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled,
  });
  const projectsQuery = useQuery({ ...companyProjectsQuery(companyId ?? "", { includeArchived: true }), enabled });
  const directoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled,
  });
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId ?? ""),
    queryFn: () => secretsApi.list(companyId!),
    enabled,
  });
  const responsibilitiesQuery = useQuery({
    queryKey: queryKeys.responsibilities.overview(companyId ?? "", { ownerUserId: userId }),
    queryFn: () => responsibilitiesApi.overview(companyId!),
    enabled: enabled && responsibilitiesOn && !!userId,
  });

  // Failed reads are reported, never shown as empty choices.
  const agentsView = useQueryView(agentsQuery);
  const projectsView = useQueryView(projectsQuery);
  const peopleView = useQueryView(directoryQuery);
  const secretsView = useQueryView(secretsQuery);
  const responsibilitiesView = useQueryView(responsibilitiesQuery);
  const loadErrors = [
    { action: "load agents", view: agentsView },
    { action: "load projects", view: projectsView },
    { action: "load people", view: peopleView },
    { action: "load secrets", view: secretsView },
    { action: "load responsibilities", view: responsibilitiesView },
  ]
    .filter(({ view }) => view.kind === "error")
    .map(({ action, view }) => ({ action, error: view.error, retry: view.retry, retrying: view.isFetching }));

  const allAgents = agentsQuery.data;
  const agents = useMemo(
    () => (allAgents ?? []).filter((agent) => agent.status !== "terminated"),
    [allAgents],
  );
  const allProjects = projectsQuery.data;
  const projects = useMemo(
    () => (allProjects ?? []).filter((project) => !project.archivedAt),
    [allProjects],
  );
  const members = directoryQuery.data?.users;
  const people = useMemo<RoutinePerson[]>(() => {
    const profiles = buildCompanyUserProfileMap(members);
    const seen = new Set<string>();
    const result: RoutinePerson[] = [];
    for (const member of members ?? []) {
      if (member.status !== "active" || seen.has(member.principalId)) continue;
      seen.add(member.principalId);
      const profile = profiles.get(member.principalId);
      result.push({ id: member.principalId, name: profile?.label ?? "Unnamed person", avatarUrl: profile?.image ?? null });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }, [members]);
  const mentions = useMemo<MentionOption[]>(
    () => buildMarkdownMentionOptions({ agents: allAgents, projects, members }),
    [allAgents, members, projects],
  );
  const overview = responsibilitiesQuery.data;
  const responsibilities = useMemo<RoutineResponsibilityOption[] | undefined>(() => {
    if (!responsibilitiesOn) return undefined;
    const areaTitles = new Map((overview?.areas ?? []).map((area) => [area.id, area.title]));
    return [...(overview?.responsibilities ?? []), ...(overview?.proposed ?? [])].map((responsibility) => ({
      id: responsibility.id,
      title: responsibility.title,
      areaTitle: responsibility.areaId ? areaTitles.get(responsibility.areaId) ?? null : null,
    }));
  }, [overview, responsibilitiesOn]);

  const areaTitles = useMemo(() => new Map((overview?.areas ?? []).map((area) => [area.id, area.title])), [overview]);

  const createSecretMutation = useMutation({
    mutationFn: (input: { name: string; value: string }) => secretsApi.create(companyId!, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId!) }),
  });
  const { mutateAsync: createSecretAsync } = createSecretMutation;
  const createSecret = useCallback(
    (name: string, value: string): Promise<CompanySecret> => createSecretAsync({ name, value }),
    [createSecretAsync],
  );

  return {
    agents,
    /** Includes terminated agents, so a routine's saved agent still shows by name. */
    allAgents: allAgents ?? NO_AGENTS,
    projects,
    /** Includes archived projects, so a routine's saved project still shows by name. */
    allProjects: allProjects ?? NO_PROJECTS,
    people,
    secrets: secretsQuery.data ?? NO_SECRETS,
    mentions,
    responsibilitiesOn,
    responsibilities,
    areaTitles,
    createSecret,
    /** Reads that failed, each with a retry. */
    loadErrors,
    /** People could not be loaded, so a saved responsible user cannot be named. */
    peopleFailed: peopleView.kind === "error" && !members,
  };
}
