import { api } from "./client";

export interface HealthCheck {
  id: string;
  deploymentId: string;
  companyId: string;
  status: string;
  responseTimeMs: number | null;
  statusCode: number | null;
  message: string | null;
  checkedAt: string;
}

export interface DeploymentRecipe {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  cloudProvider: string;
  cloudRegion: string;
  resourceType: string;
  configTemplate: Record<string, unknown>;
  envTemplate: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudDeployInput {
  cloudProvider: string;
  cloudRegion?: string;
  cloudResourceType?: string;
  cloudConfig?: Record<string, unknown>;
  version?: string;
  commitSha?: string;
  dockerImage?: string;
  domain?: string;
  sslEnabled?: boolean;
}

export interface RecipeInput {
  name: string;
  description?: string | null;
  cloudProvider: string;
  cloudRegion?: string;
  resourceType: string;
  configTemplate?: Record<string, unknown>;
  envTemplate?: Record<string, string>;
}

export const cloudDeploymentsApi = {
  listHealthChecks: (companyId: string, deploymentId: string) =>
    api.get<HealthCheck[]>(`/companies/${companyId}/deployments/${deploymentId}/health-checks`),

  runHealthCheck: (companyId: string, deploymentId: string) =>
    api.post<HealthCheck>(`/companies/${companyId}/deployments/${deploymentId}/health-check`, {}),

  listRecipes: (companyId: string) =>
    api.get<DeploymentRecipe[]>(`/companies/${companyId}/deployment-recipes`),

  createRecipe: (companyId: string, data: RecipeInput) =>
    api.post<DeploymentRecipe>(`/companies/${companyId}/deployment-recipes`, data),

  updateRecipe: (companyId: string, recipeId: string, data: Partial<RecipeInput>) =>
    api.patch<DeploymentRecipe>(`/companies/${companyId}/deployment-recipes/${recipeId}`, data),

  deleteRecipe: (companyId: string, recipeId: string) =>
    api.delete<void>(`/companies/${companyId}/deployment-recipes/${recipeId}`),

  deployToCloud: (companyId: string, deploymentId: string, data: CloudDeployInput) =>
    api.post(`/companies/${companyId}/deployments/${deploymentId}/deploy-cloud`, data),

  rollback: (companyId: string, deploymentId: string) =>
    api.post(`/companies/${companyId}/deployments/${deploymentId}/rollback`, {}),
};
