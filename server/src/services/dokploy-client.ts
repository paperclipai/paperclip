import { logger } from "../middleware/logger.js";

export interface DokployApp {
  id: string;
  name: string;
  status: "idle" | "deploying" | "rebuilding" | "starting" | "stopped" | "error";
  currentImageId?: string;
  domain?: string;
}

export interface DokployDeployment {
  id: string;
  appId: string;
  imageId: string;
  imageTag: string;
  status: "success" | "failed" | "cancelled";
  createdAt: string;
}

export interface DokployRollbackOptions {
  appId: string;
  deploymentId: string;
  reason?: string;
}

export interface DokployClientConfig {
  baseUrl: string;
  apiKey: string;
}

export class DokployClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: DokployClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown error");
      throw new Error(`Dokploy API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async getApp(appId: string): Promise<DokployApp> {
    return this.request<DokployApp>(`/applications/${appId}`);
  }

  async listApps(): Promise<DokployApp[]> {
    return this.request<DokployApp[]>("/applications");
  }

  async getAppDeployments(appId: string): Promise<DokployDeployment[]> {
    return this.request<DokployDeployment[]>(`/applications/${appId}/deployments`);
  }

  async getDeployment(appId: string, deploymentId: string): Promise<DokployDeployment> {
    return this.request<DokployDeployment>(`/applications/${appId}/deployments/${deploymentId}`);
  }

  async rollback(options: DokployRollbackOptions): Promise<{ success: boolean; deploymentId: string }> {
    const { appId, deploymentId, reason } = options;
    logger.info({ appId, deploymentId, reason }, "Initiating Dokploy rollback");

    const result = await this.request<{ success: boolean; deploymentId: string }>(
      `/applications/${appId}/rollback/${deploymentId}`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    );

    logger.info({ appId, deploymentId, result }, "Dokploy rollback completed");
    return result;
  }

  async getAppStatus(appId: string): Promise<DokployApp["status"]> {
    const app = await this.getApp(appId);
    return app.status;
  }

  isAppInDeployState(status: DokployApp["status"]): boolean {
    return ["deploying", "rebuilding", "starting"].includes(status);
  }
}

let dokployClientInstance: DokployClient | null = null;

export function getDokployClient(): DokployClient {
  if (!dokployClientInstance) {
    const baseUrl = process.env.DOKPLOY_URL || "http://100.87.254.10:3000";
    const apiKey = process.env.DOKPLOY_API_KEY;

    if (!apiKey) {
      throw new Error("DOKPLOY_API_KEY environment variable is not set");
    }

    dokployClientInstance = new DokployClient({ baseUrl, apiKey });
  }

  return dokployClientInstance;
}

export function resetDokployClient(): void {
  dokployClientInstance = null;
}