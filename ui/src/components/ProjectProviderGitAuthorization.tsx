import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

interface AzureOrganization {
  scopeKey: string;
  organization: string;
}

function organizationFromWorkspace(workspace: ProjectWorkspace): AzureOrganization | null {
  if (workspace.metadata?.repositoryProvider !== "azure-devops" || !workspace.repoUrl) return null;
  try {
    const url = new URL(workspace.repoUrl);
    if (url.protocol !== "https:" || url.hostname !== "dev.azure.com" || url.username || url.password || url.port || url.search || url.hash) return null;
    const segments = url.pathname.split("/").map((segment) => decodeURIComponent(segment));
    if (segments.length !== 5 || segments[0] !== "" || segments[3] !== "_git" || !segments[1] || !segments[2] || !segments[4]) return null;
    const organization = segments[1];
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/i.test(organization)) return null;
    return { scopeKey: organization.toLowerCase(), organization };
  } catch {
    return null;
  }
}

export function getAzureDevOpsOrganizations(workspaces: ProjectWorkspace[]): AzureOrganization[] {
  const organizations = new Map<string, AzureOrganization>();
  for (const workspace of workspaces) {
    const organization = organizationFromWorkspace(workspace);
    if (organization && !organizations.has(organization.scopeKey)) organizations.set(organization.scopeKey, organization);
  }
  return [...organizations.values()];
}

export function ProjectProviderGitAuthorization({ project }: { project: Project }) {
  const organizations = getAzureDevOpsOrganizations(project.workspaces ?? []);
  if (!organizations.length) return null;
  return (
    <section aria-label="Azure DevOps project authorizations" className="flex flex-col gap-3 py-4">
      <h3 className="text-sm font-medium">Azure DevOps organization access</h3>
      <p className="text-sm text-muted-foreground">
        Choose a connection for each Azure DevOps organization used by this project. Paperclip uses it when preparing additional project workspaces in the background.
      </p>
      {organizations.map((organization) => (
        <AzureOrganizationAuthorization key={organization.scopeKey} project={project} organization={organization} />
      ))}
    </section>
  );
}

function AzureOrganizationAuthorization({ project, organization }: { project: Project; organization: AzureOrganization }) {
  const client = useQueryClient();
  const key = ["project-azure-devops-git-authorization", project.companyId, project.id, organization.scopeKey];
  const authorization = useQuery({
    queryKey: key,
    queryFn: () => projectsApi.azureDevOpsGitAuthorization(project.id, organization.scopeKey),
  });
  const [selected, setSelected] = useState("");
  const save = useMutation({
    mutationFn: (grantId: string | null) => projectsApi.setAzureDevOpsGitAuthorization(project.id, organization.scopeKey, grantId),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      setSelected("");
    },
  });
  const data = authorization.data;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
      <h4 className="text-sm font-medium">{organization.organization}</h4>
      {data?.grantId ? (
        <p role="status" className="text-sm">
          Authorized with {data.options.find((option) => option.grantId === data.grantId)?.connectionName ?? "a connection that is unavailable or belongs to another member"}.
        </p>
      ) : null}
      {data ? (
        <div className="flex flex-wrap gap-2">
          <Select value={selected} onValueChange={setSelected} disabled={save.isPending}>
            <SelectTrigger aria-label={`Azure DevOps connection for ${organization.organization}`}>
              <SelectValue placeholder="Select a connection" />
            </SelectTrigger>
            <SelectContent>
              {data.options.map((option) => (
                <SelectItem key={option.grantId} value={option.grantId}>{option.connectionName} · {option.organization}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!selected || save.isPending} onClick={() => save.mutate(selected)}>Save authorization</Button>
          {data.grantId ? <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>Revoke authorization</Button> : null}
        </div>
      ) : authorization.isLoading ? <p className="text-sm text-muted-foreground">Loading connections…</p> : null}
      {data && !data.options.length ? <p className="text-sm text-muted-foreground">Connect an Azure DevOps account and install its Connector for this company to authorize this organization.</p> : null}
      {(authorization.error || save.error) ? <p role="alert" className="text-sm text-destructive">{(authorization.error || save.error)?.message}</p> : null}
    </div>
  );
}
