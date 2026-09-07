import { describe, expect, it, vi } from "vitest";
import { canBrowseProjectRepositoryGrant, mergeProjectRepository } from "../services/project-repositories.js";
import { loadGitHubTokenRepositories } from "../services/tool-access.js";
import type { ProjectRepository } from "@paperclipai/shared";

describe("project repository access", () => {
  const own = { status: "active", kind: "user", subjectUserId: "alice" };
  const shared = { ...own, kind: "organization", subjectUserId: null };
  const allowed = (grant: { status: string; kind: string; subjectUserId: string | null } = own, userId: string | null = "alice", activeMember = true, audience: string[] = []) =>
    canBrowseProjectRepositoryGrant({ grant, userId, activeMember, audience });
  it("includes only the caller's personal identity and active company membership", () => {
    expect(allowed()).toBe(true);
    expect(allowed(own, "bob")).toBe(false);
    expect(allowed(own, null)).toBe(false);
    expect(allowed(own, "alice", false)).toBe(false);
    expect(allowed({ ...own, kind: "agent" })).toBe(false);
    for (const status of ["revoked", "expired", "needs_reauthorization"]) expect(allowed({ ...own, status })).toBe(false);
  });
  it("honors shared audiences without an administrator bypass", () => {
    expect(allowed(shared)).toBe(true);
    expect(allowed(shared, "alice", true, ["alice"])).toBe(true);
    expect(allowed(shared, "alice", true, ["bob"])).toBe(false);
    expect(allowed(shared, "alice", false)).toBe(false);
    expect(allowed(shared, null, false)).toBe(true); // local trusted board
    expect(allowed(shared, null, false, ["alice"])).toBe(false);
  });
  it("deduplicates by provider id across personal and shared connections", () => {
    const repos = new Map<string, ProjectRepository>();
    mergeProjectRepository(repos, { id: "10", fullName: "org/old", private: true }, "Personal");
    mergeProjectRepository(repos, { id: "10", fullName: "org/renamed", private: true }, "Company");
    mergeProjectRepository(repos, { id: "10", fullName: "org/renamed", private: true }, "Company");
    expect([...repos.values()]).toEqual([{ id: "10", fullName: "org/renamed", url: "https://github.com/org/renamed", private: true, connections: ["Personal", "Company"] }]);
  });
  it("loads every PAT repository page and never follows provider-supplied URLs", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1, full_name: "org/a" }]), { headers: { link: '<https://evil.test/steal>; rel="next"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2, full_name: "org/b", private: true }])));
    expect(await loadGitHubTokenRepositories({ Authorization: "Bearer fixture" }, request)).toEqual([{ id: "1", fullName: "org/a" }, { id: "2", fullName: "org/b", private: true }]);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/user/repos?per_page=100&page=1", "https://api.github.com/user/repos?per_page=100&page=2",
    ]);
  });
  it("surfaces failed or invalid provider responses without exposing their body", async () => {
    for (const response of [new Response("secret", { status: 401 }), new Response(JSON.stringify([{ id: 1, full_name: "../bad" }]))]) {
      await expect(loadGitHubTokenRepositories({}, vi.fn().mockResolvedValue(response))).rejects.toThrow(/GitHub/);
    }
  });
});
