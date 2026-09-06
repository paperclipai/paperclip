import { describe, expect, it, vi } from "vitest";
import {
  discoverDedicatedGitHubAppInstallation,
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
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer installation-secret",
        }),
      }),
    );
  });

  it("discovers the one active installation without asking for an ID", async () => {
    const fetch = vi.fn(async () =>
      response([
        {
          id: 44,
          account: { id: 12, login: "paperclip", type: "Organization" },
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
    });
  });

  it("searches every GitHub App installation page before enforcing uniqueness", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("&page=2")) {
        return response([
          {
            id: 144,
            account: { id: 12, login: "paperclip", type: "Organization" },
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
      expect.any(Object),
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
