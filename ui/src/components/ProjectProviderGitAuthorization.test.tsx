// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { projectsApi } from "@/api/projects";
import { getAzureDevOpsOrganizations, ProjectProviderGitAuthorization } from "./ProjectProviderGitAuthorization";

vi.mock("@/api/projects", () => ({
  projectsApi: {
    azureDevOpsGitAuthorization: vi.fn(),
    setAzureDevOpsGitAuthorization: vi.fn(),
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function workspace(provider: string, repoUrl: string): ProjectWorkspace {
  return { metadata: { repositoryProvider: provider }, repoUrl } as unknown as ProjectWorkspace;
}

describe("ProjectProviderGitAuthorization", () => {
  it("derives unique scopes only from marked Azure DevOps HTTPS repository URLs", () => {
    expect(getAzureDevOpsOrganizations([
      workspace("azure-devops", "https://dev.azure.com/Team-A/App/_git/Api"),
      workspace("azure-devops", "https://dev.azure.com/team-a/Other/_git/Web"),
      workspace("github", "https://dev.azure.com/ignored/App/_git/Repo"),
      workspace("azure-devops", "http://dev.azure.com/insecure/App/_git/Repo"),
      workspace("azure-devops", "https://dev.azure.com.evil.test/org/App/_git/Repo"),
      workspace("azure-devops", "https://dev.azure.com/org/App/not-git/Repo"),
    ])).toEqual([{ scopeKey: "team-a", organization: "Team-A" }]);
  });

  it("shows the authorization for each selected organization and supports revoke", async () => {
    const authorization = {
      provider: "azure-devops" as const,
      scopeKey: "org-a",
      grantId: "grant-a",
      authorizedByUserId: "user-a",
      options: [{ grantId: "grant-a", connectionName: "Engineering Azure", organization: "org-a" }],
    };
    vi.mocked(projectsApi.azureDevOpsGitAuthorization).mockResolvedValue(authorization);
    vi.mocked(projectsApi.setAzureDevOpsGitAuthorization).mockResolvedValue({ ...authorization, grantId: null, authorizedByUserId: null });
    const project = {
      id: "project-a", companyId: "company-a",
      workspaces: [workspace("azure-devops", "https://dev.azure.com/org-a/App/_git/Repo")],
    } as Project;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const key = ["project-azure-devops-git-authorization", "company-a", "project-a", "org-a"];
    client.setQueryData(key, authorization);
    const container = document.createElement("div"), root = createRoot(container);
    document.body.appendChild(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><ProjectProviderGitAuthorization project={project} /></QueryClientProvider>));
      expect(container.textContent).toContain("Azure DevOps organization access");
      expect(container.textContent).toContain("Authorized with Engineering Azure");
      expect(container.textContent).toContain("Select a connection");
      const revoke = [...container.querySelectorAll("button")].find((button) => button.textContent === "Revoke authorization")!;
      await act(async () => {
        revoke.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(projectsApi.setAzureDevOpsGitAuthorization).toHaveBeenCalledWith("project-a", "org-a", null);
      expect(client.getQueryData(key)).toMatchObject({ grantId: null });
      expect(container.textContent).not.toContain("Revoke authorization");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    }
  });
});
