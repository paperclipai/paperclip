import { githubAppJwt } from "../../chat-github-client.js";

import {
  unprocessable,
} from "../../../errors.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

export const REQUIRED_GITHUB_EVENTS = [
  "issue_comment",
  "pull_request_review_comment",
] as const;

export const REQUIRED_GITHUB_PERMISSIONS = {
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export const UNAVOIDABLE_GITHUB_EVENTS = [
  "github_app_authorization",
  "installation",
  "installation_repositories",
] as const;

export async function verifyGitHubCredentials(
  credentials: Record<string, string>,
  fetchImpl: typeof fetch,
  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number,
): Promise<VerifiedProviderIdentity> {
  const token = githubAppJwt(credentials.appId, credentials.privateKey);
  const response = await fetchImpl("https://api.github.com/app", {
    signal: AbortSignal.timeout(PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  const result = (await response.json()) as {
    id?: number;
    login?: string;
    slug?: string;
    name?: string;
    message?: string;
    owner?: { login?: string; type?: string };
    permissions?: Record<string, string>;
    events?: string[];
  };
  if (!response.ok)
    throw unprocessable(
      `GitHub rejected the app credentials: ${result.message ?? response.status}`,
    );
  const missingPermissions = Object.entries(REQUIRED_GITHUB_PERMISSIONS)
    .filter(
      ([permission, access]) => result.permissions?.[permission] !== access,
    )
    .map(([permission]) => permission);
  const excessivePermissions = Object.keys(result.permissions ?? {}).filter(
    (permission) => !(permission in REQUIRED_GITHUB_PERMISSIONS) && !((permission === "contents" && result.permissions?.contents === "read") || (permission === "checks" && result.permissions?.checks === "write")),
  );
  const configuredEvents = new Set(result.events ?? []);
  const missingEvents = REQUIRED_GITHUB_EVENTS.filter(
    (event) => !configuredEvents.has(event),
  );
  const allowedEvents = new Set<string>([
    ...REQUIRED_GITHUB_EVENTS,
    ...UNAVOIDABLE_GITHUB_EVENTS,
    "pull_request",
    "pull_request_review",
    "issues",
  ]);
  const excessiveEvents = [...configuredEvents].filter(
    (event) => !allowedEvents.has(event),
  );
  if (
    missingPermissions.length > 0 ||
    excessivePermissions.length > 0 ||
    missingEvents.length > 0 ||
    excessiveEvents.length > 0
  ) {
    throw unprocessable(
      [
        missingPermissions.length > 0
          ? `GitHub App needs the documented minimum access for: ${missingPermissions.join(", ")}`
          : null,
        excessivePermissions.length > 0
          ? `GitHub App has broader permissions than Paperclip needs: ${excessivePermissions.join(", ")}`
          : null,
        missingEvents.length > 0
          ? `GitHub App must subscribe to: ${missingEvents.join(", ")}`
          : null,
        excessiveEvents.length > 0
          ? `GitHub App subscribes to broader events than Paperclip needs: ${excessiveEvents.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(". "),
      {
        code: "chat_provider_permissions_missing",
        provider: "github",
        missingPermissions,
        excessivePermissions,
        missingEvents,
        excessiveEvents,
      },
    );
  }
  return {
    githubOwnerType: result.owner?.type === "Organization" ? "organization" : result.owner?.type === "User" ? "personal" : undefined,
    githubOwnerLogin: result.owner?.login,
    providerAccountId: result.owner?.login,
    providerAccountLabel: result.owner?.login ?? result.name,
    // The App registration id is the stable, immutable endpoint identity.
    // The adapter discovers the separate bot-user id while initializing.
    botExternalId:
      typeof result.id === "number" && Number.isFinite(result.id)
        ? String(result.id)
        : undefined,
    botUsername: result.slug ? `${result.slug}[bot]` : undefined,
    botLabel: result.name ?? result.slug,
  };
}
