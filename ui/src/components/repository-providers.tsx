import { GitBranch } from "lucide-react";
import { GithubIcon } from "./icons/github-icon";

export const repositoryProviders = [
  { id: "github", label: "GitHub", serviceSlug: "github", icon: GithubIcon },
  { id: "azure-devops", label: "Azure DevOps", serviceSlug: "azure-devops", icon: GitBranch },
] as const;

export type RepositoryProvider = (typeof repositoryProviders)[number];

export function repositoryProviderLabel(id: string): string {
  return repositoryProviders.find((provider) => provider.id === id)?.label ?? id;
}
