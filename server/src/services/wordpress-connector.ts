import { Buffer } from "node:buffer";

export const WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY = "wordpress.application_password" as const;
export const WORDPRESS_USERNAME_CONFIG_PATH = "credentials.username" as const;
export const WORDPRESS_APPLICATION_PASSWORD_CONFIG_PATH = "credentials.application_password" as const;
export const WORDPRESS_AUTH_CHECK_PATH = "/wp-json/wp/v2/users/me?context=edit" as const;

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
    payload = await response.json();
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
