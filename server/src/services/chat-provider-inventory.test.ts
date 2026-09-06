import { describe, expect, it, vi } from "vitest";
import {
  discoverDedicatedGitHubAppInstallation,
  getSlackBotChannel,
  listGitHubInstallationRepositories,
  listSlackBotChannels,
} from "./chat-provider-inventory.js";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("chat provider inventory", () => {
  it("paginates Slack and returns only non-archived bot memberships", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ok: true,
          channels: [
            { id: "C1", name: "agents", is_member: true },
            { id: "C2", name: "not-invited", is_member: false },
            { id: "C3", name: "archived", is_member: true, is_archived: true },
          ],
          response_metadata: { next_cursor: "next" },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          channels: [
            {
              id: "G1",
              name: "private-agents",
              is_member: true,
              is_private: true,
            },
          ],
          response_metadata: { next_cursor: "" },
        }),
      ) as unknown as typeof globalThis.fetch;
    const result = await listSlackBotChannels({
      botToken: "xoxb-secret",
      fetch,
    });
    expect(result.resources).toEqual([
      expect.objectContaining({ providerResourceId: "C1", label: "#agents" }),
      expect.objectContaining({
        providerResourceId: "G1",
        label: "#private-agents",
        metadata: expect.objectContaining({ private: true }),
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondUrl = String(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0],
    );
    expect(secondUrl).toContain("cursor=next");
  });

  it("resolves one newly joined Slack channel without exposing the bot token", async () => {
    const fetch = vi.fn(async () =>
      response({
        ok: true,
        channel: {
          id: "C-NEW",
          name: "new-agent-work",
          is_member: true,
          is_private: true,
          context_team_id: "T-ENTERPRISE",
        },
      }),
    ) as unknown as typeof globalThis.fetch;
    const result = await getSlackBotChannel({
      botToken: "xoxb-secret",
      channelId: "C-NEW",
      fetch,
    });
    expect(result).toEqual({
      providerResourceId: "C-NEW",
      type: "channel",
      label: "#new-agent-work",
      metadata: {
        private: true,
        contextTeamId: "T-ENTERPRISE",
        source: "provider_inventory",
      },
    });
    expect(JSON.stringify(result)).not.toContain("xoxb-secret");
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/conversations.info",
        search: "?channel=C-NEW",
      }),
      expect.objectContaining({
        headers: { authorization: "Bearer xoxb-secret" },
      }),
    );
  });

  it("does not hydrate a Slack resource after the bot has already left", async () => {
    const fetch = vi.fn(async () =>
      response({
        ok: true,
        channel: {
          id: "C-LEFT",
          name: "former-channel",
          is_member: false,
        },
      }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      getSlackBotChannel({
        botToken: "xoxb-secret",
        channelId: "C-LEFT",
        fetch,
      }),
    ).resolves.toBeNull();
  });

  it("exchanges a GitHub App JWT and never exposes the installation token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ token: "installation-secret" }))
      .mockResolvedValueOnce(
        response({
          repositories: [
            {
              id: 101,
              name: "repo",
              full_name: "paperclip/repo",
              html_url: "https://github.com/paperclip/repo",
              owner: { id: 12, login: "paperclip" },
              private: true,
            },
          ],
        }),
      ) as unknown as typeof globalThis.fetch;
    const result = await listGitHubInstallationRepositories({
      appJwt: "app-jwt",
      installationId: "44",
      fetch,
    });
    expect(result.resources).toEqual([
      expect.objectContaining({
        providerResourceId: "101",
        parentProviderResourceId: "12",
        label: "paperclip/repo",
        providerUrl: "https://github.com/paperclip/repo",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("installation-secret");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/app/installations/44/access_tokens",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer installation-secret",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("discovers the one active installation without asking for an ID", async () => {
    const fetch = vi.fn(async () =>
      response([
        {
          id: 44,
          account: { id: 12, login: "paperclip", type: "Organization" },
          permissions: {
            issues: "write",
            metadata: "read",
            pull_requests: "write",
          },
          suspended_at: null,
        },
        {
          id: 55,
          account: { id: 13, login: "suspended" },
          suspended_at: "2026-09-05T00:00:00Z",
        },
      ]),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      discoverDedicatedGitHubAppInstallation({ appJwt: "jwt", fetch }),
    ).resolves.toEqual({
      installationId: "44",
      accountId: "12",
      accountLabel: "paperclip",
      accountType: "Organization",
      permissions: {
        issues: "write",
        metadata: "read",
        pull_requests: "write",
      },
    });
  });

  it("searches every GitHub App installation page before enforcing uniqueness", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("&page=2")) {
        return response([
          {
            id: 144,
            account: { id: 12, login: "paperclip", type: "Organization" },
            permissions: {
              issues: "write",
              metadata: "read",
              pull_requests: "write",
            },
            suspended_at: null,
          },
        ]);
      }
      return response(
        Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          account: { id: index + 1, login: `suspended-${index + 1}` },
          suspended_at: "2026-09-05T00:00:00Z",
        })),
      );
    }) as unknown as typeof globalThis.fetch;

    await expect(
      discoverDedicatedGitHubAppInstallation({ appJwt: "jwt", fetch }),
    ).resolves.toMatchObject({
      installationId: "144",
      accountId: "12",
      accountLabel: "paperclip",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.github.com/app/installations?per_page=100&page=2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects an installation whose effective grants lag the App registration", async () => {
    await expect(
      discoverDedicatedGitHubAppInstallation({
        appJwt: "jwt",
        fetch: vi.fn(async () =>
          response([
            {
              id: 44,
              account: { id: 12, login: "paperclip" },
              permissions: {
                issues: "read",
                metadata: "read",
                pull_requests: "write",
              },
              suspended_at: null,
            },
          ]),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(
      "active installation has not granted the required access for: issues",
    );
  });

  it("rejects zero or multiple active installations", async () => {
    await expect(
      discoverDedicatedGitHubAppInstallation({
        appJwt: "jwt",
        fetch: vi.fn(async () =>
          response([]),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("install this GitHub App");
    await expect(
      discoverDedicatedGitHubAppInstallation({
        appJwt: "jwt",
        fetch: vi.fn(async () =>
          response([{ id: 1 }, { id: 2 }]),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("exactly one active installation");
  });

  it("fails closed when either provider rejects inventory", async () => {
    await expect(
      listSlackBotChannels({
        botToken: "bad",
        fetch: vi.fn(async () =>
          response({ ok: false, error: "invalid_auth" }),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("Slack inventory failed: invalid_auth");
    await expect(
      listGitHubInstallationRepositories({
        appJwt: "bad",
        installationId: "1",
        fetch: vi.fn(async () =>
          response({ message: "Not Found" }, 404),
        ) as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("GitHub inventory failed: Not Found");
  });
});
