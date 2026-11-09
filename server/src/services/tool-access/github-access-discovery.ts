import { randomUUID } from "node:crypto";
import { unprocessable } from "../../errors.js";

function gitHubRepositoryOwnerType(repository: Record<string, unknown>) {
  const type = recordValue(repository.owner) ? repository.owner.type : undefined;
  return type === "Organization" ? "organization" as const
    : type === "User" ? "personal" as const : undefined;
}

export async function loadGitHubTokenRepositories(
  headers: Record<string, string>,
  request: typeof fetch = fetch,
) {
  const repositories: Array<{
    id: string;
    fullName: string;
    ownerType?: "personal" | "organization";
    private?: boolean;
  }> = [];
  for (let page = 1; ; page += 1) {
    const response = await request(
      `https://api.github.com/user/repos?per_page=100&page=${page}`,
      {
        headers: {
          ...headers,
          accept: "application/vnd.github+json",
          "user-agent": "Paperclip",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw unprocessable(
        "Could not load GitHub repositories. Reconnect GitHub and try again.",
      );
    const rows: unknown = await response.json();
    if (!Array.isArray(rows))
      throw unprocessable("GitHub returned invalid repositories");
    for (const row of rows) {
      if (
        !recordValue(row) ||
        !githubId(row.id) ||
        typeof row.full_name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(
          row.full_name,
        )
      ) {
        throw unprocessable("GitHub returned invalid repository metadata");
      }
      repositories.push({
        id: githubId(row.id)!,
        fullName: row.full_name,
        ...(gitHubRepositoryOwnerType(row) ? { ownerType: gitHubRepositoryOwnerType(row) } : {}),
        ...(typeof row.private === "boolean" ? { private: row.private } : {}),
      });
    }
    if (!/;\s*rel="next"/.test(response.headers.get("link") ?? ""))
      return repositories;
    if (!rows.length) throw unprocessable("GitHub returned invalid pagination");
  }
}

export async function loadGitHubGrantMetadata(
  accessToken: string,
  request: typeof fetch = fetch,
  appSlug?: string,
): Promise<{
  userId: string;
  login: string;
  avatarUrl?: string;
  installationCount: number;
  repositoryCount: number;
  repositorySelection: "all" | "selected" | "mixed" | "none";
  installationIds: string[];
  installationOwnerLogins: string[];
  repositories: Array<{
    id: string;
    fullName: string;
    installationId: string;
    ownerType?: "personal" | "organization";
    private?: boolean;
  }>;
  installationUrl: string;
  managementUrl: string;
  appSlug?: string;
  accessRevision: string;
  lastAccessRefreshAt: string;
  webhookHealth: "pending";
}> {
  let resolvedAppSlug = appSlug;
  const accessRefreshStartedAt = new Date().toISOString();
  const github = async (
    path: string,
  ): Promise<{ data: Record<string, unknown>; hasNext: boolean }> => {
    const response = await request(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "Paperclip",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw unprocessable(
        "GitHub could not verify this account's installation access",
        {
          code:
            response.status === 401
              ? "oauth_reauthorization_required"
              : "github_access_check_failed",
        },
      );
    }
    const value = (await response.json()) as unknown;
    if (!recordValue(value))
      throw unprocessable("GitHub returned invalid account metadata", {
        code: "github_bad_response",
      });
    return {
      data: value,
      hasNext: /;\s*rel="next"/.test(response.headers.get("link") ?? ""),
    };
  };
  const list = async (
    path: string,
    key: string,
  ): Promise<Record<string, unknown>[]> => {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; ; page += 1) {
      const { data, hasNext } = await github(
        `${path}?per_page=100&page=${page}`,
      );
      const batch = data[key];
      if (
        !Array.isArray(batch) ||
        !batch.every(recordValue) ||
        (hasNext && batch.length === 0)
      ) {
        throw unprocessable("GitHub returned invalid access metadata", {
          code: "github_bad_response",
        });
      }
      items.push(...batch);
      if (!hasNext) return items;
    }
  };
  const { data: user } = await github("/user");
  const userId = githubId(user.id);
  const login = typeof user.login === "string" ? user.login : null;
  if (!userId || !login)
    throw unprocessable("GitHub returned invalid account metadata", {
      code: "github_bad_response",
    });
  const installations = await list("/user/installations", "installations");
  const installationIds: string[] = [];
  const owners = new Set<string>();
  const selections = new Set<"all" | "selected">();
  const managementUrls = new Set<string>();
  const repositories = new Map<
    string,
    { id: string; fullName: string; installationId: string; ownerType?: "personal" | "organization"; private?: boolean }
  >();
  for (const installation of installations) {
    const installationId = githubId(installation.id);
    if (!installationId) continue;
    installationIds.push(installationId);
    // Older grants predate the broker's appSlug field. GitHub's installation
    // response identifies this token's app without choosing an environment.
    if (
      !resolvedAppSlug &&
      typeof installation.app_slug === "string" &&
      /^[a-z0-9-]{1,100}$/.test(installation.app_slug)
    ) {
      resolvedAppSlug = installation.app_slug;
    }
    if (
      installation.repository_selection === "all" ||
      installation.repository_selection === "selected"
    ) {
      selections.add(installation.repository_selection);
    }
    const account = recordValue(installation.account)
      ? installation.account
      : null;
    if (typeof account?.login === "string") owners.add(account.login);
    const managementUrl = githubInstallationManagementUrl(
      installation.html_url,
    );
    if (managementUrl) managementUrls.add(managementUrl);
    for (const repository of await list(
      `/user/installations/${installationId}/repositories`,
      "repositories",
    )) {
      const id = githubId(repository.id);
      const fullName =
        typeof repository.full_name === "string" ? repository.full_name : "";
      if (
        !id ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(
          fullName,
        )
      ) {
        throw unprocessable("GitHub returned invalid repository metadata", {
          code: "github_bad_response",
        });
      }
      repositories.set(id, {
        id,
        fullName,
        installationId,
        ...(gitHubRepositoryOwnerType(repository) ? { ownerType: gitHubRepositoryOwnerType(repository) } : {}),
        ...(typeof repository.private === "boolean"
          ? { private: repository.private }
          : {}),
      });
    }
  }
  const repositoryCount = repositories.size;
  if (installationIds.length === 0 || repositoryCount === 0) {
    const installationUrl = resolvedAppSlug
      ? `https://github.com/apps/${resolvedAppSlug}/installations/new`
      : "https://github.com/settings/installations";
    throw unprocessable(
      "GitHub access is required. Install Paperclip and grant at least one repository before refreshing access.",
      {
        code: "github_installation_required",
        installationUrl,
        managementUrl: "https://github.com/settings/installations",
      },
    );
  }
  const installationUrl = resolvedAppSlug
    ? `https://github.com/apps/${resolvedAppSlug}/installations/new`
    : "https://github.com/settings/installations";
  return {
    userId,
    login,
    ...(typeof user.avatar_url === "string"
      ? { avatarUrl: user.avatar_url }
      : {}),
    installationCount: installationIds.length,
    repositoryCount,
    repositorySelection:
      selections.size > 1
        ? "mixed"
        : (selections.values().next().value ?? "none"),
    installationIds,
    installationOwnerLogins: [...owners],
    repositories: [...repositories.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    ),
    installationUrl,
    managementUrl:
      managementUrls.size === 1
        ? managementUrls.values().next().value!
        : "https://github.com/settings/installations",
    ...(resolvedAppSlug ? { appSlug: resolvedAppSlug } : {}),
    accessRevision: randomUUID(),
    lastAccessRefreshAt: accessRefreshStartedAt,
    webhookHealth: "pending",
  };
}

function githubInstallationManagementUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com"
    )
      return null;
    return url.pathname.includes("/settings/installations/")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function githubId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value))
    return value;
  return null;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

