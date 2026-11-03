import { forbidden, unprocessable } from "../errors.js";

export async function assertEnvironmentCompanyBinding(
  environmentsSvc: { listBoundCompanyIds(environmentId: string): Promise<string[]> },
  companyId: string,
  environmentId: string,
) {
  const boundCompanyIds = await environmentsSvc.listBoundCompanyIds(environmentId);
  if (boundCompanyIds.length > 0 && !boundCompanyIds.includes(companyId)) {
    throw forbidden("The selected environment belongs to another company.", { code: "environment_company_mismatch" });
  }
}

export async function assertEnvironmentSelectionForCompany(
  environmentsSvc: {
    listBoundCompanyIds?(environmentId: string): Promise<string[]>;
    getById(environmentId: string): Promise<{
      id: string;
      driver: string;
      status?: string | null;
      config: Record<string, unknown> | null;
    } | null>;
  },
  companyId: string,
  environmentId: string | null | undefined,
  options?: {
    allowedDrivers?: string[];
    allowedSandboxProviders?: string[];
    requireCompanyBinding?: boolean;
  },
) {
  if (environmentId === undefined || environmentId === null) return;
  const environment = await environmentsSvc.getById(environmentId);
  if (!environment) {
    throw unprocessable("Environment not found.");
  }
  if (environment.status === "archived") {
    throw unprocessable("Environment is archived.");
  }
  if (options?.requireCompanyBinding) {
    const listBoundCompanyIds = environmentsSvc.listBoundCompanyIds?.bind(environmentsSvc);
    if (!listBoundCompanyIds) throw unprocessable("Environment company access cannot be checked.");
    await assertEnvironmentCompanyBinding({ listBoundCompanyIds }, companyId, environmentId);
  }
  if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
    throw unprocessable(
      `Environment driver "${environment.driver}" is not allowed here. Allowed drivers: ${options.allowedDrivers.join(", ")}`,
    );
  }
  if (environment.driver === "sandbox") {
    const config = environment.config && typeof environment.config === "object"
      ? environment.config as Record<string, unknown>
      : {};
    const provider = typeof config.provider === "string" ? config.provider : "";
    if (provider === "fake") {
      throw unprocessable(
        `Environment sandbox provider "${provider}" is not allowed here. The built-in fake provider is probe-only and cannot execute runs.`,
      );
    }
    if (
      options?.allowedSandboxProviders
      && options.allowedSandboxProviders.length > 0
      && !options.allowedSandboxProviders.includes(provider)
    ) {
      throw unprocessable(
        `Environment sandbox provider "${provider || "unknown"}" is not allowed here. Allowed providers: ${options.allowedSandboxProviders.join(", ")}`,
      );
    }
  }
}
