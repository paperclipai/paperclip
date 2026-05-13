import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitCredentialsClient } from "./git-credentials.js";

describe("createGitCredentialsClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to /api/workspace/git-credentials and returns username/password", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ username: "x", password: "y" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const c = createGitCredentialsClient({
      paperclipPublicUrl: "https://pp",
      runJwt: "jwt",
      repoUrl: "https://github.com/acme/repo.git",
    });
    const r = await c.fetch();
    expect(r).toEqual({ username: "x", password: "y" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://pp/api/workspace/git-credentials",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer jwt" }),
      }),
    );
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const c = createGitCredentialsClient({
      paperclipPublicUrl: "https://pp",
      runJwt: "jwt",
      repoUrl: "",
    });
    await expect(c.fetch()).rejects.toThrow(/500/);
  });

  it("returns null on 503 not_configured (public-repo / first-run path)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "not_configured" }), { status: 503 }),
      ),
    );
    const c = createGitCredentialsClient({
      paperclipPublicUrl: "https://pp",
      runJwt: "jwt",
      repoUrl: "https://github.com/acme/public.git",
    });
    await expect(c.fetch()).resolves.toBeNull();
  });

  it("throws on 503 with a non-not_configured body (generic transient)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream timeout", { status: 503 })),
    );
    const c = createGitCredentialsClient({
      paperclipPublicUrl: "https://pp",
      runJwt: "jwt",
      repoUrl: "",
    });
    await expect(c.fetch()).rejects.toThrow(/503/);
  });

  it("throws when response is missing username/password", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const c = createGitCredentialsClient({
      paperclipPublicUrl: "https://pp",
      runJwt: "jwt",
      repoUrl: "",
    });
    await expect(c.fetch()).rejects.toThrow(/missing username/);
  });
});
