import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ghFetch, runWithServerGitHubToken, serverGitHubTokenMiddleware } from "../services/github-fetch.js";

function authorizationSent(fetchMock: ReturnType<typeof vi.fn>) {
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization");
}

const asInstanceAdmin = <T>(fn: () => T) => runWithServerGitHubToken(true, fn);

describe("ghFetch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the server GITHUB_TOKEN to github.com API and raw hosts for instance admins", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok");
    for (const url of ["https://api.github.com/repos/o/r", "https://raw.githubusercontent.com/o/r/sha/SKILL.md"]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      await asInstanceAdmin(() => ghFetch(url, { headers: { accept: "application/vnd.github+json" } }));
      expect(authorizationSent(fetchMock)).toBe("Bearer tok");
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get("accept")).toBe("application/vnd.github+json");
    }
  });

  it("falls back to GH_TOKEN", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "gh");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await asInstanceAdmin(() => ghFetch("https://api.github.com/repos/o/r"));
    expect(authorizationSent(fetchMock)).toBe("Bearer gh");
  });

  it("does not send the token to other hosts, over plain http, or over a caller header", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok");
    for (const url of ["https://ghe.example.com/api/v3/repos/o/r", "http://api.github.com/repos/o/r"]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      await asInstanceAdmin(() => ghFetch(url));
      expect(authorizationSent(fetchMock)).toBeNull();
    }

    const own = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", own);
    await asInstanceAdmin(() => ghFetch("https://api.github.com/repos/o/r", { headers: { authorization: "Bearer mine" } }));
    expect(authorizationSent(own)).toBe("Bearer mine");
  });

  it("stays anonymous outside an instance-admin scope", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok");
    for (const run of [(fn: () => Promise<Response>) => fn(), (fn: () => Promise<Response>) => runWithServerGitHubToken(false, fn)]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetchMock);
      await run(() => ghFetch("https://api.github.com/repos/o/private"));
      expect(authorizationSent(fetchMock)).toBeNull();
    }
  });

  it("stays anonymous without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await asInstanceAdmin(() => ghFetch("https://api.github.com/repos/o/r"));
    expect(authorizationSent(fetchMock)).toBeNull();
  });

  it("scopes the token to requests whose actor is an instance admin", async () => {
    vi.stubEnv("GITHUB_TOKEN", "tok");
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", isInstanceAdmin: req.get("x-admin") === "1" } as typeof req.actor;
      next();
    });
    app.use(serverGitHubTokenMiddleware);
    app.get("/import", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await ghFetch("https://api.github.com/repos/o/r");
      res.json({ ok: true });
    });

    await request(app).get("/import").set("x-admin", "1").expect(200);
    await request(app).get("/import").expect(200);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization")).toBeNull();
  });
});
