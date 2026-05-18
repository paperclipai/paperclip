type CompanyRow = {
  id: string;
  name: string;
  status: string;
  issuePrefix: string | null;
};

type ProjectRow = {
  id: string;
  companyId: string;
  name: string;
  status: string;
};

type IssueRow = {
  id: string;
  companyId: string;
  projectId: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
};

export function buildListSummary(input: {
  databaseSource: string;
  companies: CompanyRow[];
  projects: ProjectRow[];
  issues: IssueRow[];
}) {
  return {
    databaseSource: input.databaseSource,
    companies: input.companies.map((company) => ({
      id: company.id,
      name: company.name,
      status: company.status,
      issuePrefix: company.issuePrefix,
      projects: input.projects
        .filter((project) => project.companyId === company.id)
        .map((project) => ({
          id: project.id,
          name: project.name,
          status: project.status,
          issues: input.issues
            .filter((issue) => issue.companyId === company.id && issue.projectId === project.id)
            .map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
            })),
        })),
    })),
  };
}

export function buildExistingIssueUpdatePatch(
  existing: { status: string; priority: string; description?: string | null },
  requested: { status: string; priority: string; description?: string | null },
) {
  const patch: { status?: string; priority?: string; description?: string | null } = {};

  if (existing.status !== requested.status) patch.status = requested.status;
  if (existing.priority !== requested.priority) patch.priority = requested.priority;
  if ((existing.description ?? null) !== (requested.description ?? null)) {
    patch.description = requested.description ?? null;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
