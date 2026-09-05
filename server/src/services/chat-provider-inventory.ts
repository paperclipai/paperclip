import type { ChatProvider } from "@paperclipai/shared";

export interface ChatProviderResourceInventoryItem {
  providerResourceId: string;
  parentProviderResourceId?: string;
  type: string;
  label: string;
  providerUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatProviderInventoryResult {
  provider: ChatProvider;
  resources: ChatProviderResourceInventoryItem[];
}

export interface GitHubAppInstallationIdentity {
  installationId: string;
  accountId?: string;
  accountLabel?: string;
  accountType?: string;
}

async function jsonResponse<T>(response: Response, provider: string): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${provider} returned an unreadable inventory response`);
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : String(response.status);
    throw new Error(`${provider} inventory failed: ${message}`);
  }
  return body as T;
}

/** List only Slack conversations where the installed bot is a member. */
export async function listSlackBotChannels(input: {
  botToken: string;
  fetch: typeof globalThis.fetch;
}): Promise<ChatProviderInventoryResult> {
  const resources: ChatProviderResourceInventoryItem[] = [];
  let cursor = "";
  do {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await input.fetch(url, {
      headers: { authorization: `Bearer ${input.botToken}` },
    });
    const body = await jsonResponse<{
      ok?: boolean;
      error?: string;
      channels?: Array<{
        id?: string;
        name?: string;
        is_member?: boolean;
        is_private?: boolean;
        is_archived?: boolean;
        context_team_id?: string;
      }>;
      response_metadata?: { next_cursor?: string };
    }>(response, "Slack");
    if (!body.ok) throw new Error(`Slack inventory failed: ${body.error ?? "unknown error"}`);
    for (const channel of body.channels ?? []) {
      if (!channel.id || !channel.is_member || channel.is_archived) continue;
      resources.push({
        providerResourceId: channel.id,
        type: "channel",
        label: channel.name ? `#${channel.name}` : channel.id,
        metadata: {
          private: channel.is_private === true,
          ...(channel.context_team_id
            ? { contextTeamId: channel.context_team_id }
            : {}),
          source: "provider_inventory",
        },
      });
    }
    cursor = body.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor);
  return { provider: "slack", resources };
}

/**
 * Exchange a GitHub App JWT for a short-lived installation token and list the
 * repositories selected for that installation. The token never leaves this
 * function and is never persisted in Paperclip.
 */
export async function listGitHubInstallationRepositories(input: {
  appJwt: string;
  installationId: string;
  fetch: typeof globalThis.fetch;
}): Promise<ChatProviderInventoryResult> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.appJwt}`,
    "x-github-api-version": "2022-11-28",
  };
  const tokenResponse = await input.fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    { method: "POST", headers },
  );
  const tokenBody = await jsonResponse<{ token?: string; message?: string }>(
    tokenResponse,
    "GitHub",
  );
  if (!tokenBody.token)
    throw new Error("GitHub inventory failed: installation token was missing");

  const resources: ChatProviderResourceInventoryItem[] = [];
  let page = 1;
  try {
    while (true) {
      const url = new URL("https://api.github.com/installation/repositories");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await input.fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${tokenBody.token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      const body = await jsonResponse<{
        repositories?: Array<{
          id?: number;
          name?: string;
          full_name?: string;
          html_url?: string;
          owner?: { id?: number; login?: string };
          private?: boolean;
        }>;
      }>(response, "GitHub");
      const repositories = body.repositories ?? [];
      for (const repository of repositories) {
        if (!Number.isFinite(repository.id)) continue;
        const id = String(repository.id);
        resources.push({
          providerResourceId: id,
          parentProviderResourceId: repository.owner?.id
            ? String(repository.owner.id)
            : undefined,
          type: "repository",
          label: repository.full_name ?? repository.name ?? id,
          providerUrl:
            repository.html_url ??
            (repository.full_name
              ? `https://github.com/${repository.full_name}`
              : undefined),
          metadata: {
            private: repository.private === true,
            ...(repository.owner?.login
              ? { owner: repository.owner.login }
              : {}),
            source: "provider_inventory",
          },
        });
      }
      if (repositories.length < 100) break;
      page += 1;
    }
  } finally {
    // Avoid keeping the installation token reachable longer than the request
    // scope. JavaScript strings cannot be reliably zeroed, but this prevents
    // accidental return/persistence through the inventory result.
    tokenBody.token = undefined;
  }
  return { provider: "github", resources };
}

/**
 * Resolve the one installation belonging to a dedicated per-agent GitHub App.
 * Keeping one app identity per endpoint is the same invariant used for Slack
 * and Teams bots; it also avoids exposing an installation-id field to users.
 */
export async function discoverDedicatedGitHubAppInstallation(input: {
  appJwt: string;
  fetch: typeof globalThis.fetch;
}): Promise<GitHubAppInstallationIdentity> {
  const response = await input.fetch(
    "https://api.github.com/app/installations?per_page=100",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.appJwt}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const installations = await jsonResponse<
    Array<{
      id?: number;
      account?: { id?: number; login?: string; name?: string; type?: string };
      suspended_at?: string | null;
    }>
  >(response, "GitHub");
  const active = installations.filter(
    (installation) =>
      Number.isFinite(installation.id) && !installation.suspended_at,
  );
  if (active.length === 0) {
    throw new Error(
      "GitHub inventory failed: install this GitHub App on the selected repositories first",
    );
  }
  if (active.length !== 1) {
    throw new Error(
      "GitHub inventory failed: this chat connection requires a dedicated GitHub App with exactly one active installation",
    );
  }
  const installation = active[0]!;
  return {
    installationId: String(installation.id),
    accountId: Number.isFinite(installation.account?.id)
      ? String(installation.account?.id)
      : undefined,
    accountLabel:
      installation.account?.login ?? installation.account?.name ?? undefined,
    accountType: installation.account?.type,
  };
}
