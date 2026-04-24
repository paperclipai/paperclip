import { unprocessable } from "../errors.js";

export async function assertEnvironmentSelectionForCompany(
  environmentsSvc: {
    getById(environmentId: string): Promise<{
      id: string;
      companyId: string;
      driver: string;
      status?: string | null;
      config: Record<string, unknown> | null;
    } | null>;
  },
  companyId: string,
  environmentId: string | null | undefined,
  options?: {
    allowedDrivers?: string[];
  },
) {
  if (environmentId === undefined || environmentId === null) return;
  const environment = await environmentsSvc.getById(environmentId);
  if (!environment || environment.companyId !== companyId) {
    throw unprocessable("Environment not found.");
  }
  if (environment.status === "archived") {
    throw unprocessable("Environment is archived.");
  }
  if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
    throw unprocessable(
      `Environment driver "${environment.driver}" is not allowed here. Allowed drivers: ${options.allowedDrivers.join(", ")}`,
    );
  }
}
