import { Buffer } from "node:buffer";

export const WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY = "wordpress.application_password" as const;
export const WORDPRESS_USERNAME_CONFIG_PATH = "credentials.username" as const;
export const WORDPRESS_APPLICATION_PASSWORD_CONFIG_PATH = "credentials.application_password" as const;
export const WORDPRESS_AUTH_CHECK_PATH = "/wp-json/wp/v2/users/me?context=edit" as const;
export const WORDPRESS_MAX_RESPONSE_BYTES = 16 * 1024;

export const WORDPRESS_AUTH_CHECK_TOOL = {
  name: "wordpress_authentication_check",
  title: "Check WordPress authentication",
  description: "Verify the configured WordPress identity without exposing credentials or profile details.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
} as const;

export function wordPressCredentialProjection(configPath: string): {
  projectionClass: "class_3_static_lease";
  projectionAllowlistKey: typeof WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY;
} | Record<string, never> {
  return configPath === WORDPRESS_APPLICATION_PASSWORD_CONFIG_PATH
    ? {
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY,
      }
    : {};
}

export interface WordPressConnectionBinding {
  companyId: string;
  projectId: string;
  allowedAgentIds: readonly string[];
}

type WordPressStoredConfig = {
  sourceTemplateKey?: unknown;
  connectionMethodKey?: unknown;
  methodConfig?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedAgentIds(value: unknown): string[] {
  return Array.from(new Set(String(value ?? "").split(/[\s,]+/g).map((entry) => entry.trim()).filter(Boolean))).sort();
}

export function assertWordPressConnectionConfigUnchanged(
  existing: WordPressStoredConfig,
  proposed: WordPressStoredConfig,
): void {
  if (proposed.sourceTemplateKey !== "wordpress" || proposed.connectionMethodKey !== "application-password-readonly") {
    throw new Error("WordPress connection type cannot be changed while credentials are bound");
  }
  const current = record(existing.methodConfig);
  const next = record(proposed.methodConfig);
  const currentAgents = normalizedAgentIds(current.allowedAgentIds);
  const nextAgents = normalizedAgentIds(next.allowedAgentIds);
  if (
    validateWordPressBaseUrl(String(next.baseUrl ?? "")) !== validateWordPressBaseUrl(String(current.baseUrl ?? ""))
    || String(next.projectId ?? "") !== String(current.projectId ?? "")
    || nextAgents.length !== currentAgents.length
    || nextAgents.some((agentId, index) => agentId !== currentAgents[index])
  ) {
    throw new Error("WordPress credential recipient and scope cannot be changed in place");
  }
}

export function assertWordPressCredentialRefs(refs: readonly {
  configPath: string;
  projectionClass?: string | null;
  projectionAllowlistKey?: string | null;
}[]): void {
  const usernameRefs = refs.filter((ref) => ref.configPath === WORDPRESS_USERNAME_CONFIG_PATH);
  const passwordRefs = refs.filter((ref) => ref.configPath === WORDPRESS_APPLICATION_PASSWORD_CONFIG_PATH);
  if (refs.length !== 2 || usernameRefs.length !== 1 || passwordRefs.length !== 1) {
    throw new Error("WordPress requires exactly one username and one Application Password secret");
  }
  const passwordRef = passwordRefs[0]!;
  if (
    passwordRef.projectionClass !== "class_3_static_lease"
    || passwordRef.projectionAllowlistKey !== WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY
  ) {
    throw new Error("WordPress Application Password must retain its class-3 allowlist binding");
  }
}

export function validateWordPressBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WordPress base URL must be a valid absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("WordPress base URL must use HTTPS");
  if (url.username || url.password) throw new Error("WordPress base URL must not contain credentials");
  if (url.search || url.hash) throw new Error("WordPress base URL must not contain a query or fragment");
  if (url.pathname.toLowerCase().includes("/wp-json/")) {
    throw new Error("WordPress base URL must not include an API endpoint path");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function wordPressAuthenticationCheckUrl(baseUrl: string): string {
  return `${validateWordPressBaseUrl(baseUrl)}${WORDPRESS_AUTH_CHECK_PATH}`;
}

export function assertWordPressConnectionScope(
  binding: WordPressConnectionBinding,
  context: { companyId: string; projectId: string | null; agentId: string | null },
): void {
  if (
    context.companyId !== binding.companyId
    || context.projectId !== binding.projectId
    || !context.agentId
    || !binding.allowedAgentIds.includes(context.agentId)
  ) {
    throw new Error("WordPress connection is outside the allowed company, project, or agent scope");
  }
}

export async function executeWordPressAuthenticationCheck(input: {
  baseUrl: string;
  username: string;
  applicationPassword: string;
  request?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<{ authenticated: true; userId: number }> {
  const endpoint = wordPressAuthenticationCheckUrl(input.baseUrl);
  const request = input.request ?? fetch;
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${input.username}:${input.applicationPassword}`, "utf8").toString("base64")}`,
      },
    });
  } catch {
    throw new Error("WordPress authentication check could not reach the configured site");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("WordPress authentication check refused a redirect");
  }
  if (!response.ok) throw new Error("WordPress authentication check was rejected");
  let payload: unknown;
  try {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > WORDPRESS_MAX_RESPONSE_BYTES) {
      throw new Error("response too large");
    }
    if (!response.body) throw new Error("empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > WORDPRESS_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("WordPress authentication check returned an invalid response");
  }
  const id = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).id
    : null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("WordPress authentication check returned an invalid response");
  }
  return { authenticated: true, userId: id };
}
