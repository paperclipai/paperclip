import { describe, expect, it, vi } from "vitest";
import { loadGitHubTokenAccount } from "../services/github-token-account.js";

const TOKEN = "ghp_unit_fixture_token";
const fixedNow = () => new Date("2026-10-14T12:00:00.000Z");

describe("loadGitHubTokenAccount", () => {
  it("reads the token's account from GET /user without following redirects", async () => {
    const request = vi.fn(async () => Response.json({ id: 4242, login: "octo-a", avatar_url: "https://avatars.githubusercontent.com/u/4242" }));
    await expect(loadGitHubTokenAccount(TOKEN, request, fixedNow)).resolves.toEqual({
      userId: "4242",
      login: "octo-a",
      avatarUrl: "https://avatars.githubusercontent.com/u/4242",
      verifiedAt: "2026-10-14T12:00:00.000Z",
    });
    expect(request).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
    }));
  });

  it.each([
    ["a rejected token", async () => new Response("bad credentials", { status: 401 })],
    ["an unreachable GitHub", async () => { throw new Error(`socket closed for ${TOKEN}`); }],
    ["a malformed account", async () => Response.json({ id: "4242", login: "octo-a" })],
    ["an invalid login", async () => Response.json({ id: 4242, login: "../evil" })],
    ["a non-JSON body", async () => new Response(`<html>${TOKEN}</html>`, { status: 200 })],
  ])("rejects %s without exposing the token", async (_label, respond) => {
    const error = await loadGitHubTokenAccount(TOKEN, vi.fn(respond) as unknown as typeof fetch, fixedNow)
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
