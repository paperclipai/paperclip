import { unprocessable } from "../../../errors.js";

export class AzureDevOpsResponseError extends Error {
  constructor(readonly kind: "denied" | "rate_limited") { super(`Azure DevOps ${kind}`); }
}

const MAX_REPOSITORY_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readRepositoryResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw unprocessable("Azure DevOps returned invalid repository metadata");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REPOSITORY_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw unprocessable("Azure DevOps repository response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
  catch { throw unprocessable("Azure DevOps returned invalid repository metadata"); }
}

type AzureRepository = {
  provider: "azure-devops";
  id: string;
  fullName: string;
  url: string;
  private: true;
};

export function azureDevOpsAuthorization(credential: { kind: "pat" | "entra"; token: string }): string {
  if (!credential.token || credential.token.length > 4096 || /[\0\r\n]/.test(credential.token))
    throw unprocessable("Azure DevOps credential unavailable");
  return credential.kind === "pat"
    ? `Basic ${Buffer.from(`:${credential.token}`, "utf8").toString("base64")}`
    : `Bearer ${credential.token}`;
}

function safeName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

/** Discover repositories only on the configured Azure DevOps Services organization. */
export async function loadAzureDevOpsRepositories(
  organization: string,
  headers: Record<string, string>,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AzureRepository[]> {
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/i.test(organization))
    throw unprocessable("Invalid Azure DevOps organization");
  const endpoint = `https://dev.azure.com/${organization}/_apis/git/repositories?api-version=7.1`;
  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  const response = await request(endpoint, { headers: { ...headers, Accept: "application/json" }, redirect: "error", signal: requestSignal });
  if (response.status === 401 || response.status === 403) throw new AzureDevOpsResponseError("denied");
  if (response.status === 429) throw new AzureDevOpsResponseError("rate_limited");
  if (!response.ok) throw unprocessable("Could not load Azure DevOps repositories. Try again later.");
  const payload = await readRepositoryResponse(response);
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { value?: unknown }).value))
    throw unprocessable("Azure DevOps returned invalid repository metadata");
  const result: AzureRepository[] = [];
  for (const item of (payload as { value: unknown[] }).value) {
    if (!item || typeof item !== "object") throw unprocessable("Azure DevOps returned invalid repository metadata");
    const row = item as { id?: unknown; name?: unknown; project?: { name?: unknown }; isDisabled?: unknown };
    if (row.isDisabled === true) continue;
    if (typeof row.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(row.id) ||
        !safeName(row.name) || !safeName(row.project?.name))
      throw unprocessable("Azure DevOps returned invalid repository metadata");
    result.push({ provider: "azure-devops", id: `${organization.toLowerCase()}:${row.id.toLowerCase()}`, fullName: `${organization}/${row.project.name}/${row.name}`,
      url: `https://dev.azure.com/${organization}/${encodeURIComponent(row.project.name)}/_git/${encodeURIComponent(row.name)}`, private: true });
  }
  return result;
}
