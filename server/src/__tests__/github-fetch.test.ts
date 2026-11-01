import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGitHubTokenForHost,
  gitHubApiBase,
  ghFetch,
  isGitHubDotCom,
  isGitHubHost,
  resolveRawGitHubUrl,
} from "../services/github-fetch.js";

describe("github-fetch", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_ENTERPRISE_TOKEN;
    delete process.env.GH_ENTERPRISE_TOKEN;
    delete process.env.GITHUB_ENTERPRISE_HOST;
    delete process.env.GH_HOST;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  describe("isGitHubDotCom", () => {
    it("recognizes github.com and www.github.com case-insensitively", () => {
      expect(isGitHubDotCom("github.com")).toBe(true);
      expect(isGitHubDotCom("GITHUB.COM")).toBe(true);
      expect(isGitHubDotCom("www.github.com")).toBe(true);
      expect(isGitHubDotCom("WWW.GITHUB.COM")).toBe(true);
      expect(isGitHubDotCom("api.github.com")).toBe(false);
      expect(isGitHubDotCom("raw.githubusercontent.com")).toBe(false);
      expect(isGitHubDotCom("gitlab.com")).toBe(false);
    });
  });

  describe("isGitHubHost", () => {
    it("recognizes GitHub API and raw content hosts", () => {
      expect(isGitHubHost("github.com")).toBe(true);
      expect(isGitHubHost("www.github.com")).toBe(true);
      expect(isGitHubHost("api.github.com")).toBe(true);
      expect(isGitHubHost("API.GITHUB.COM")).toBe(true);
      expect(isGitHubHost("raw.githubusercontent.com")).toBe(true);
      expect(isGitHubHost("RAW.GITHUBUSERCONTENT.COM")).toBe(true);
      expect(isGitHubHost("githubusercontent.com")).toBe(false);
      expect(isGitHubHost("example.com")).toBe(false);
    });
  });

  describe("gitHubApiBase", () => {
    it("returns public API base for github.com and api/v3 for enterprise", () => {
      expect(gitHubApiBase("github.com")).toBe("https://api.github.com");
      expect(gitHubApiBase("www.github.com")).toBe("https://api.github.com");
      expect(gitHubApiBase("ghe.internal.corp")).toBe("https://ghe.internal.corp/api/v3");
    });
  });

  describe("resolveRawGitHubUrl", () => {
    it("resolves raw URL for github.com via raw.githubusercontent.com", () => {
      expect(
        resolveRawGitHubUrl("github.com", "paperclipai", "paperclip", "main", "skills/demo/SKILL.md"),
      ).toBe("https://raw.githubusercontent.com/paperclipai/paperclip/main/skills/demo/SKILL.md");
    });

    it("resolves raw URL for GitHub Enterprise via hostname/raw", () => {
      expect(
        resolveRawGitHubUrl("ghe.internal.corp", "paperclipai", "paperclip", "main", "/skills/demo/SKILL.md"),
      ).toBe("https://ghe.internal.corp/raw/paperclipai/paperclip/main/skills/demo/SKILL.md");
    });
  });

  describe("getGitHubTokenForHost", () => {
    it("returns GITHUB_TOKEN for GitHub hosts", () => {
      process.env.GITHUB_TOKEN = "ghp_secret_token";
      expect(getGitHubTokenForHost("api.github.com")).toBe("ghp_secret_token");
      expect(getGitHubTokenForHost("raw.githubusercontent.com")).toBe("ghp_secret_token");
      expect(getGitHubTokenForHost("github.com")).toBe("ghp_secret_token");
    });

    it("falls back to GH_TOKEN when GITHUB_TOKEN is not set", () => {
      process.env.GH_TOKEN = "gho_fallback_token";
      expect(getGitHubTokenForHost("api.github.com")).toBe("gho_fallback_token");
    });

    it("prefers GITHUB_TOKEN over GH_TOKEN when both are set", () => {
      process.env.GITHUB_TOKEN = "ghp_primary";
      process.env.GH_TOKEN = "gho_secondary";
      expect(getGitHubTokenForHost("api.github.com")).toBe("ghp_primary");
    });

    it("trims whitespace from environment token", () => {
      process.env.GITHUB_TOKEN = "  ghp_trimmed   \n";
      expect(getGitHubTokenForHost("api.github.com")).toBe("ghp_trimmed");
    });

    it("returns null when token is empty or whitespace only", () => {
      process.env.GITHUB_TOKEN = "   ";
      expect(getGitHubTokenForHost("api.github.com")).toBeNull();
    });

    it("returns null for non-GitHub hosts to prevent credential leakage", () => {
      process.env.GITHUB_TOKEN = "ghp_secret_token";
      expect(getGitHubTokenForHost("evil.com")).toBeNull();
      expect(getGitHubTokenForHost("gitlab.com")).toBeNull();
    });

    it("supports enterprise host when configured via GITHUB_ENTERPRISE_HOST or GH_HOST", () => {
      process.env.GITHUB_ENTERPRISE_HOST = "github.corp.internal";
      process.env.GITHUB_ENTERPRISE_TOKEN = "ghe_token_123";
      expect(getGitHubTokenForHost("github.corp.internal")).toBe("ghe_token_123");
      expect(getGitHubTokenForHost("other.corp.internal")).toBeNull();
    });
  });

  describe("ghFetch", () => {
    it("calls fetch directly when no token is present", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const res = await ghFetch("https://api.github.com/repos/owner/repo");
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo", undefined);
    });

    it("injects Authorization header for api.github.com when GITHUB_TOKEN is set", async () => {
      process.env.GITHUB_TOKEN = "ghp_test_123";
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      await ghFetch("https://api.github.com/repos/paperclipai/paperclip");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://api.github.com/repos/paperclipai/paperclip");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ghp_test_123");
    });

    it("injects Authorization header for raw.githubusercontent.com when GH_TOKEN is set", async () => {
      process.env.GH_TOKEN = "gho_test_raw";
      const mockFetch = vi.fn().mockResolvedValue(new Response("skill content", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      await ghFetch("https://raw.githubusercontent.com/mattpocock/skills/main/skills/tdd/SKILL.md");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://raw.githubusercontent.com/mattpocock/skills/main/skills/tdd/SKILL.md");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer gho_test_raw");
    });

    it("preserves other headers while injecting Authorization header", async () => {
      process.env.GITHUB_TOKEN = "ghp_test_123";
      const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      await ghFetch("https://api.github.com/repos/paperclipai/paperclip", {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "custom-agent",
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init?.headers).toEqual({
        accept: "application/vnd.github+json",
        "user-agent": "custom-agent",
        authorization: "Bearer ghp_test_123",
      });
    });

    it("does NOT overwrite existing authorization header", async () => {
      process.env.GITHUB_TOKEN = "ghp_env_token";
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      await ghFetch("https://api.github.com/repos/paperclipai/paperclip", {
        headers: {
          authorization: "Bearer caller_custom_token",
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer caller_custom_token");
    });

    it("does NOT overwrite existing uppercase Authorization header", async () => {
      process.env.GITHUB_TOKEN = "ghp_env_token";
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      await ghFetch("https://api.github.com/repos/paperclipai/paperclip", {
        headers: {
          Authorization: "Bearer caller_uppercase_token",
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer caller_uppercase_token");
      expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
    });

    it("does NOT inject token for third-party host", async () => {
      process.env.GITHUB_TOKEN = "ghp_secret_token";
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      await ghFetch("https://not-github.com/api/skills");
      const [, init] = mockFetch.mock.calls[0]!;
      expect(init).toBeUndefined();
    });

    it("supports Headers instance in init.headers", async () => {
      process.env.GITHUB_TOKEN = "ghp_test_123";
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const existingHeaders = new Headers({ accept: "application/json" });
      await ghFetch("https://api.github.com/user", { headers: existingHeaders });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init?.headers as Headers;
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer ghp_test_123");
    });

    it("supports array of tuple headers in init.headers", async () => {
      process.env.GITHUB_TOKEN = "ghp_test_123";
      const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", mockFetch);

      const existingHeaders: [string, string][] = [["accept", "application/json"]];
      await ghFetch("https://api.github.com/user", { headers: existingHeaders });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init?.headers as [string, string][];
      expect(headers).toContainEqual(["accept", "application/json"]);
      expect(headers).toContainEqual(["authorization", "Bearer ghp_test_123"]);
    });

    it("throws unprocessable on network failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      await expect(ghFetch("https://api.github.com/error")).rejects.toThrow(
        "Could not connect to api.github.com — ensure the URL points to a GitHub or GitHub Enterprise instance",
      );
    });
  });
});
