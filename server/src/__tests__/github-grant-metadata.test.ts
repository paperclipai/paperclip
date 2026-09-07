import { describe, expect, it, vi } from "vitest";
import { loadGitHubGrantMetadata } from "../services/tool-access.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub grant metadata", () => {
  it("keeps only user and installation summaries while counting accessible repositories", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) return json({ id: 42, login: "octocat", avatar_url: "https://avatars.example/octocat" });
      if (url.includes("/user/installations?")) {
        return json({
          installations: [
            { id: 101, repository_selection: "selected", html_url: "https://github.com/settings/installations/101", account: { login: "paperclipai" } },
            { id: 102, repository_selection: "all", account: { login: "octocat" } },
          ],
        });
      }
      if (url.includes("/user/installations/101/repositories")) {
        return json({ total_count: 2, repositories: [{ full_name: "paperclipai/private-name-must-not-persist" }] });
      }
      if (url.includes("/user/installations/102/repositories")) return json({ total_count: 5 });
      return json({}, 404);
    });

    const metadata = await loadGitHubGrantMetadata("ghu_secret", request, "paperclip-development");

    expect(metadata).toMatchObject({
      userId: "42",
      login: "octocat",
      installationCount: 2,
      repositoryCount: 7,
      repositorySelection: "mixed",
      installationIds: ["101", "102"],
      installationOwnerLogins: ["paperclipai", "octocat"],
      installationUrl: "https://github.com/apps/paperclip-development/installations/new",
      managementUrl: "https://github.com/settings/installations/101",
      appSlug: "paperclip-development",
      webhookHealth: "pending",
    });
    expect(JSON.stringify(metadata)).not.toContain("private-name-must-not-persist");
    expect(request).toHaveBeenCalledTimes(4);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_secret");
    }
  });

  it("requires at least one installation with an accessible repository", async () => {
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/user")
      ? json({ id: 42, login: "octocat" })
      : json({ installations: [] }));

    await expect(loadGitHubGrantMetadata("ghu_secret", request)).rejects.toMatchObject({
      details: expect.objectContaining({ code: "github_installation_required" }),
    });
  });
});
