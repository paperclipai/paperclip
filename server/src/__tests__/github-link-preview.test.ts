import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recognizeLinkPreview } from "@paperclipai/shared";
import { createGitHubLinkPreviewProvider, resolveLinkPreviewGitHubCredential } from "../services/github-link-preview.js";
import { resolveGitHubApiCredential, resolveManagedGitHubCredential } from "../services/git-credentials.js";

vi.mock("../services/git-credentials.js", async original => ({
  ...await original<typeof import("../services/git-credentials.js")>(),
  resolveManagedGitHubCredential: vi.fn(), resolveGitHubApiCredential: vi.fn(),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
const db = null as unknown as Db;
const scope = { companyId: "company-a", userId: "alice" };
const target = recognizeLinkPreview("https://github.com/acme/web/pull/42")!;
beforeEach(() => vi.resetAllMocks());

describe("GitHub link preview boundary", () => {
  it("uses only the current viewer's managed identity with no standing delegation", async () => {
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValue({ configured: true, credential: { token: "token", source: "managed_connection", secretName: null } });
    expect(await resolveLinkPreviewGitHubCredential(db, scope)).toEqual({ token: "token", source: "managed_connection", secretName: null });
    expect(resolveManagedGitHubCredential).toHaveBeenCalledWith(db, {}, scope.companyId, { responsibleUserId: "alice", allowStandingDelegation: false });
    expect(resolveGitHubApiCredential).not.toHaveBeenCalled();
  });
  it("does not bypass a configured connection that cannot supply credentials", async () => {
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValue({ configured: true });
    await expect(resolveLinkPreviewGitHubCredential(db, scope)).rejects.toThrow();
    expect(resolveGitHubApiCredential).not.toHaveBeenCalled();
  });
  it("uses the existing company/public fallback only without a managed connection", async () => {
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValue({ configured: false });
    vi.mocked(resolveGitHubApiCredential).mockResolvedValue(null);
    expect(await resolveLinkPreviewGitHubCredential(db, scope)).toBeNull();
    expect(resolveGitHubApiCredential).toHaveBeenCalledWith(db, scope.companyId);
  });
  it.each([
    [{ state: "open" }, "open"], [{ state: "open", mergeable: false }, "conflicts"],
    [{ state: "open", mergeable: null }, "open"], [{ state: "open", draft: true }, "draft"],
    [{ state: "open", draft: true, mergeable: false }, "draft"],
    [{ state: "closed", merged: true }, "merged"], [{ state: "closed" }, "closed"],
  ])("normalizes state %j as %s without fetching checks or reviews", async (fields, expected) => {
    const fetcher = vi.fn(async () => Response.json({ title: "A change", updated_at: "2026-11-10T12:00:00Z", user: { login: "alice" }, ...fields }));
    const provider = createGitHubLinkPreviewProvider(db, { fetch: fetcher, credentialProvider: () => null });
    const result = await provider.resolve(target, scope, new AbortController().signal);
    expect(result.preview).toMatchObject({ title: "A change", state: expected, author: "alice", target });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/web/pulls/42", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it.each([401, 403, 429, 500])("returns a quiet absence for GitHub HTTP %s", async status => {
    const provider = createGitHubLinkPreviewProvider(db, { fetch: async () => new Response(null, { status }), credentialProvider: () => null });
    expect((await provider.resolve(target, scope, new AbortController().signal)).preview).toBeNull();
  });
  it("retains the instance-token public-repository boundary", async () => {
    const fetcher = vi.fn(async () => Response.json({ private: true }));
    const provider = createGitHubLinkPreviewProvider(db, { fetch: fetcher, credentialProvider: () => ({ token: "instance", source: "server_env", secretName: null }) });
    expect((await provider.resolve(target, scope, new AbortController().signal)).preview).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/web", expect.any(Object));
  });
});
