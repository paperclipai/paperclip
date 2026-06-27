import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";

type MarkdownMentionInputs = Parameters<typeof buildMarkdownMentionOptions>[0];

type StandardMarkdownMentionOptionsArgs = {
  companyId?: string | null;
  enabled?: boolean;
} & Partial<MarkdownMentionInputs>;

export function useStandardMarkdownMentionOptions(args: StandardMarkdownMentionOptionsArgs = {}) {
  const { selectedCompanyId } = useCompany();
  const companyId = args.companyId ?? selectedCompanyId;
  const enabled = (args.enabled ?? true) && Boolean(companyId);

  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "standard-mentions", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: enabled && args.agents === undefined,
  });
  const projectsQuery = useQuery({
    queryKey: companyId ? queryKeys.projects.list(companyId) : ["projects", "standard-mentions", "none"],
    queryFn: () => projectsApi.list(companyId!),
    enabled: enabled && args.projects === undefined,
  });
  const usersQuery = useQuery({
    queryKey: companyId ? queryKeys.access.companyUserDirectory(companyId) : ["access", "standard-mentions", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: enabled && args.members === undefined,
  });

  const agents = args.agents ?? agentsQuery.data;
  const projects = args.projects ?? projectsQuery.data;
  const members = args.members ?? usersQuery.data?.users;

  return useMemo(
    () => buildMarkdownMentionOptions({ agents, projects, members }),
    [agents, members, projects],
  );
}
