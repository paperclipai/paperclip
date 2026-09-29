import { createPrivateKey, createSign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { conflict, forbidden, unprocessable } from "../errors.js";

export function githubAppJwt(
  appId: string,
  privateKey: string,
  now = new Date(),
): string {
  const epoch = Math.floor(now.getTime() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: epoch - 60, exp: epoch + 540, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

/** Fixed origin, no redirects, bounded responses, no credential-bearing errors. */
export async function githubBotRequest<T>(
  fetchImpl: typeof fetch,
  token: string | null,
  path: string,
  options: { method?: string; body?: unknown; accept?: string } = {},
): Promise<T> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  )
    throw forbidden("Invalid GitHub operation path");
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw unprocessable(
      "GitHub is temporarily unavailable. Retry this operation.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw unprocessable(
      `GitHub rejected this operation (HTTP ${response.status}). Check the App installation and repository permissions.`,
      { code: "github_bot_operation_failed", providerStatus: response.status },
    );
  }
  if (response.status === 204) return undefined as T;
  const reader = response.body?.getReader();
  if (!reader) throw unprocessable("GitHub returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024)
        throw unprocessable(
          "GitHub response exceeds the review limit. Narrow the request or report incomplete coverage.",
        );
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return (options.accept?.includes("diff") ? body : JSON.parse(body)) as T;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Resolve only this endpoint's vaulted App. Never consult personal grants. */
export async function githubBotCredentials(
  db: Db,
  companyId: string,
  endpointId: string,
) {
  const [row] = await db
    .select({ endpoint: chatEndpoints, connection: toolConnections })
    .from(chatEndpoints)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, chatEndpoints.connectionId),
        eq(toolConnections.companyId, companyId),
      ),
    )
    .where(
      and(
        eq(chatEndpoints.companyId, companyId),
        eq(chatEndpoints.id, endpointId),
        eq(chatEndpoints.provider, "github"),
      ),
    );
  if (!row || ["archived", "revoked", "paused"].includes(row.endpoint.status))
    throw conflict("GitHub bot connection is unavailable");
  const secrets = secretService(db);
  const credentials: Record<string, string> = {};
  for (const key of [
    "appId",
    "privateKey",
    "installationId",
    "webhookSecret",
  ]) {
    const ref = row.connection.credentialSecretRefs.find(
      (r) => r.configPath === `credentials.${key}`,
    );
    if (!ref) continue;
    credentials[key] = await secrets.resolveSecretValue(
      companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        consumerType: "tool_connection",
        consumerId: row.connection.id,
        configPath: ref.configPath,
        actorType: "system",
        actorId: null,
      },
    );
  }
  if (!credentials.appId || !credentials.privateKey)
    throw conflict("Connect the GitHub App before continuing");
  return {
    ...row,
    credentials,
    appJwt: githubAppJwt(credentials.appId, credentials.privateKey),
  };
}

/** Least-privilege short-lived token restricted to the single task repository. */
export async function githubBotRepositoryToken(
  db: Db,
  companyId: string,
  endpointId: string,
  repositoryId: string,
  fetchImpl = fetch,
) {
  const result = await githubBotCredentials(db, companyId, endpointId);
  if (
    !result.connection.enabled ||
    result.connection.status !== "active" ||
    !["active", "verifying"].includes(result.endpoint.status)
  )
    throw conflict("GitHub bot connection is not active");
  if (
    !result.credentials.installationId ||
    !/^[1-9][0-9]*$/.test(repositoryId) ||
    !Number.isSafeInteger(Number(repositoryId))
  )
    throw conflict("Verify the GitHub App installation first");
  const issued = await githubBotRequest<{ token?: string }>(
    fetchImpl,
    result.appJwt,
    `/app/installations/${encodeURIComponent(result.credentials.installationId)}/access_tokens`,
    {
      method: "POST",
      body: {
        repository_ids: [Number(repositoryId)],
        permissions: {
          contents: "read",
          metadata: "read",
          issues: "write",
          pull_requests: "write",
          checks: "write",
        },
      },
    },
  );
  if (!issued.token)
    throw unprocessable("GitHub did not issue an installation token");
  return issued.token;
}
