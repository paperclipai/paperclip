import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { routinesApi } from "@/api/routines";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { groupCatalogByApp } from "./profile-model";

/**
 * Shared data layer for the access-profiles index and wizard. Assembles the
 * company-wide catalog (there is no aggregate endpoint, so we fan out per
 * connection) and the lookup maps both surfaces need.
 */
export function useProfilesData(companyId: string) {
  const profiles = useQuery({
    queryKey: queryKeys.tools.profiles(companyId),
    queryFn: () => toolsApi.listProfiles(companyId),
  });
  const applications = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const routines = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });

  const connectionList = connections.data?.connections ?? [];
  const catalogQueries = useQueries({
    queries: connectionList.map((c) => ({
      queryKey: queryKeys.tools.catalog(c.id),
      queryFn: () => toolsApi.listCatalog(c.id),
      staleTime: 60_000,
    })),
  });
  const catalog = useMemo(
    () => catalogQueries.flatMap((q) => q.data?.catalog ?? []),
    [catalogQueries],
  );
  const catalogLoading = connections.isLoading || catalogQueries.some((q) => q.isLoading);

  const maps = useMemo(
    () => ({
      applicationsById: new Map((applications.data?.applications ?? []).map((a) => [a.id, a.name])),
      connectionsById: new Map(connectionList.map((c) => [c.id, c.name])),
      agentsById: new Map((agents.data ?? []).map((a) => [a.id, a.name])),
      projectsById: new Map((projects.data ?? []).map((p) => [p.id, p.name])),
      routinesById: new Map((routines.data ?? []).map((r) => [r.id, r.title])),
    }),
    [applications.data, connectionList, agents.data, projects.data, routines.data],
  );

  const appGroups = useMemo(
    () => groupCatalogByApp(catalog, maps.applicationsById, maps.connectionsById),
    [catalog, maps.applicationsById, maps.connectionsById],
  );

  return {
    profiles,
    applications,
    connections,
    agents,
    projects,
    routines,
    catalog,
    catalogLoading,
    appGroups,
    maps,
  };
}
