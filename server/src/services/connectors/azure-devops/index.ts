import { z } from "zod";
import { HttpError } from "../../../errors.js";
import { AzureDevOpsResponseError, azureDevOpsAuthorization, loadAzureDevOpsRepositories } from "./repositories.js";
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_ENTRA_METHOD, AZURE_DEVOPS_PAT_METHOD, AZURE_DEVOPS_TOOLS } from "./catalog.js";

export { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_ENTRA_METHOD, AZURE_DEVOPS_PAT_METHOD, AZURE_DEVOPS_TOOLS, azureDevOpsRisk, isCurrentAzureDevOpsCatalogEntry } from "./catalog.js";
export type AzureDevOpsRequest = (url: string, init: RequestInit) => Promise<Response>;
const emptySchema = z.object({}).strict();
const organizationSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/i);
type Connection = { transport: string; authKind?: string; config?: Record<string, unknown> };
type CredentialKind = "pat" | "entra";
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function methodConfig(connection: Connection) { return record(connection.config?.methodConfig); }

export function isAzureDevOpsConnection(connection: Connection): boolean {
  const config = connection.config;
  const method = methodConfig(connection);
  const methodKey = config?.connectionMethodKey;
  const expectedAuth = methodKey === AZURE_DEVOPS_ENTRA_METHOD ? "oauth"
    : methodKey === AZURE_DEVOPS_PAT_METHOD ? "api_key" : undefined;
  return connection.transport === "rest_api" && config?.sourceTemplateKey === "azure-devops"
    && (config.url === AZURE_DEVOPS_API_URL || config.url === `${AZURE_DEVOPS_API_URL}/`)
    && expectedAuth !== undefined && connection.authKind === expectedAuth
    && organizationSchema.safeParse(method.organization).success;
}

function authHeader(headers: Record<string, string>, kind: CredentialKind): string {
  const entries = Object.entries(headers);
  if (entries.length !== 1 || entries[0][0].toLowerCase() !== "authorization") {
    throw new HttpError(422, "Reconnect Azure DevOps with a supported credential.", { code: "azure_devops_credential_invalid" });
  }
  const value = entries[0][1];
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) throw new HttpError(422, "Reconnect Azure DevOps with a supported credential.", { code: "azure_devops_credential_invalid" });
  let token: string | undefined;
  if (/^Bearer (\S{1,4096})$/.test(value)) token = value.slice(7);
  if (!token || token.length > 4096 || /[\0\r\n]/.test(token)) throw new HttpError(422, "Reconnect Azure DevOps with a supported credential.", { code: "azure_devops_credential_invalid" });
  return azureDevOpsAuthorization({ kind, token });
}

/** Credentials and request transport are supplied by the governed REST gateway. */
export function azureDevOpsClient(connection: Connection, headers: Record<string, string>, request: AzureDevOpsRequest, signal?: AbortSignal, deadlineAt?: number) {
  if (!isAzureDevOpsConnection(connection)) throw new HttpError(422, "Azure DevOps connection configuration is invalid.", { code: "azure_devops_connection_invalid" });
  const settings = methodConfig(connection);
  const organization = settings.organization as string;
  const kind: CredentialKind = connection.config?.connectionMethodKey === AZURE_DEVOPS_PAT_METHOD ? "pat" : "entra";
  const authorization = authHeader(headers, kind);
  const guardedRequest: AzureDevOpsRequest = async (url, init) => {
    const expected = `${AZURE_DEVOPS_API_URL}/${organization}/_apis/git/repositories?api-version=7.1`;
    if (url !== expected || new URL(url).origin !== AZURE_DEVOPS_API_URL || init.redirect !== "error") {
      throw new HttpError(502, "Azure DevOps request was rejected.", { code: "azure_devops_request_rejected" });
    }
    return request(url, { method: "GET", redirect: "error", signal: init.signal,
      headers: { Authorization: authorization, Accept: "application/json" } });
  };
  async function listRepositories() {
    if (signal?.aborted || (deadlineAt !== undefined && deadlineAt <= Date.now()))
      throw new HttpError(504, "Azure DevOps request was cancelled.", { code: "azure_devops_request_cancelled" });
    const deadlineSignal = deadlineAt === undefined ? undefined : AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
    const requestSignal = signal && deadlineSignal ? AbortSignal.any([signal, deadlineSignal]) : signal ?? deadlineSignal;
    const loaderRequest: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return guardedRequest(url, init ?? {});
    };
    try { return await loadAzureDevOpsRepositories(organization, { Authorization: authorization }, loaderRequest, requestSignal); }
    catch (error) {
      if (error instanceof AzureDevOpsResponseError && error.kind === "denied")
        throw new HttpError(403, "Azure DevOps denied access. Reconnect and check repository permissions.", { code: "azure_devops_access_denied" });
      if (error instanceof AzureDevOpsResponseError && error.kind === "rate_limited")
        throw new HttpError(429, "Azure DevOps rate limit reached. Try again later.", { code: "azure_devops_rate_limited" });
      throw new HttpError(502, "Azure DevOps could not complete the repository request.", { code: "azure_devops_request_failed" });
    }
  }
  return {
    probe: listRepositories,
    async invoke(name: string, parameters: unknown) {
      if (name !== AZURE_DEVOPS_TOOLS[0].name) throw new HttpError(404, "Azure DevOps action not found.", { code: "azure_devops_tool_not_found" });
      if (!emptySchema.safeParse(parameters).success) throw new HttpError(422, "Invalid Azure DevOps action arguments.", { code: "azure_devops_arguments_invalid" });
      return listRepositories();
    },
  };
}
