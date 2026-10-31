import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createGitHubWorkspaceDeliveryResolver, type GitHubWorkspaceDeliveryInput } from "../services/github-workspace-delivery.js";

const HEAD = "1".repeat(40);
const TIP = "2".repeat(40);
const MERGE = "3".repeat(40);
const OTHER = "4".repeat(40);
const input: GitHubWorkspaceDeliveryInput = { companyId: "company-a", repoUrl: "https://github.com/acme/repo.git", headSha: HEAD, destinationRef: "refs/heads/main" };
const ref = (name = "heads/main", tip = TIP) => ({ ref: `refs/${name}`, object: { type: "commit", sha: tip } });
const comparison = (base: string, included: boolean) => ({ status: included ? "ahead" : "diverged", base_commit: { sha: base }, merge_base_commit: { sha: included ? base : OTHER }, behind_by: included ? 0 : 1, ahead_by: 1 });
const pull = () => ({ number: 17, merged: true, head: { sha: HEAD, repo: { full_name: "fork/repo" } }, base: { ref: "main", repo: { full_name: "acme/repo" } }, merge_commit_sha: MERGE });
function fixture(extra: Record<string, unknown> = {}, ambient = false) {
  const routes: Record<string, unknown> = {
    "/git/ref/heads/main": ref(),
    [`/compare/${HEAD}...${TIP}?per_page=1`]: comparison(HEAD, false),
    [`/commits/${HEAD}/pulls?per_page=100&page=1`]: [{ number: 17 }],
    "/pulls/17": pull(),
    [`/compare/${MERGE}...${TIP}?per_page=1`]: comparison(MERGE, true),
    ...extra,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url).startsWith("https://api.github.com/repos/acme/repo")).toBe(true);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const path = String(url).slice("https://api.github.com/repos/acme/repo".length);
    const value = routes[path];
    if (typeof value === "function") return value(init);
    if (value instanceof Response) return value.clone();
    return value === undefined ? new Response(null, { status: 404 }) : Response.json(value);
  });
  const credentialProvider = vi.fn(async () => ambient ? { token: "test-credential", source: "server_env" as const, secretName: null } : null);
  const resolve = createGitHubWorkspaceDeliveryResolver({} as Db, { fetch, credentialProvider });
  return { resolve, fetch, credentialProvider };
}

describe("GitHub workspace delivery proof", () => {
  it("discovers an exact-head squash PR without a recorded work product, including a fork", async () => {
    const f = fixture();
    expect(await f.resolve(input)).toEqual({ status: "delivered", headSha: HEAD, destinationRef: "refs/heads/main", destinationTipSha: TIP, evidence: { kind: "merged_pr", number: 17, mergeCommitSha: MERGE } });
    expect(f.fetch).toHaveBeenCalledTimes(5);
    expect(f.credentialProvider).toHaveBeenCalledWith("company-a");
  });

  it("accepts ordinary ancestry without a PR lookup", async () => {
    const f = fixture({ [`/compare/${HEAD}...${TIP}?per_page=1`]: comparison(HEAD, true) });
    expect(await f.resolve(input)).toMatchObject({ status: "delivered", evidence: { kind: "ancestry" } });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["different source HEAD", { ...pull(), head: { sha: OTHER } }],
    ["different destination branch", { ...pull(), base: { ref: "release", repo: { full_name: "acme/repo" } } }],
    ["different destination repository", { ...pull(), base: { ref: "main", repo: { full_name: "other/repo" } } }],
    ["open PR with test merge commit", { ...pull(), merged: false }],
  ])("does not accept %s", async (_label, response) => {
    const f = fixture({ "/pulls/17": response });
    expect(await f.resolve(input)).toEqual({ status: "not_delivered" });
  });

  it("rejects an integration commit removed from the destination by force push", async () => {
    const f = fixture({ [`/compare/${MERGE}...${TIP}?per_page=1`]: comparison(MERGE, false) });
    expect(await f.resolve(input)).toEqual({ status: "not_delivered" });
  });

  it.each([null, "", "HEAD", "main~1", "refs/remotes/untrusted/main", "refs/heads/../main"])("rejects unresolved or unsupported destination %s before authentication", async (destinationRef) => {
    const f = fixture();
    expect(await f.resolve({ ...input, destinationRef })).toMatchObject({ status: "unknown" });
    expect(f.credentialProvider).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["origin/main", "refs/remotes/origin/main", "main"])("normalizes branch %s while preserving exact destination", async (destinationRef) => {
    const f = fixture();
    expect(await f.resolve({ ...input, destinationRef })).toMatchObject({ status: "delivered", destinationRef: "refs/heads/main" });
  });

  it("keeps a bare branch/tag collision unknown even if they have the same tip", async () => {
    const f = fixture({ "/git/ref/tags/main": ref("tags/main") });
    expect(await f.resolve({ ...input, destinationRef: "main" })).toEqual({ status: "unknown", reason: "ambiguous_destination_ref" });
  });

  it.each(["refs/tags/release", TIP])("allows only direct ancestry for tag/SHA destination %s", async (destinationRef) => {
    const f = fixture({ "/git/ref/tags/release": ref("tags/release"), [`/commits/${TIP}?per_page=1`]: { sha: TIP } });
    expect(await f.resolve({ ...input, destinationRef })).toEqual({ status: "not_delivered" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("resolves an annotated tag to its commit before testing ancestry", async () => {
    const f = fixture({ "/git/ref/tags/release": { ref: "refs/tags/release", object: { type: "tag", sha: OTHER } }, "/commits/tags%2Frelease?per_page=1": { sha: TIP }, [`/compare/${HEAD}...${TIP}?per_page=1`]: comparison(HEAD, true) });
    expect(await f.resolve({ ...input, destinationRef: "refs/tags/release" })).toMatchObject({ status: "delivered", destinationRef: "refs/tags/release", destinationTipSha: TIP });
  });

  it("does not borrow instance credentials for a private repository", async () => {
    const f = fixture({ "": { private: true, full_name: "acme/repo" } }, true);
    expect(await f.resolve(input)).toEqual({ status: "unknown", reason: "ambient_credential_requires_public_repository" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("probes ambient access again on each observation", async () => {
    let calls = 0;
    const f = fixture({ "": () => Response.json({ private: calls++ > 0, full_name: "acme/repo" }) }, true);
    expect(await f.resolve(input)).toMatchObject({ status: "delivered" });
    expect(await f.resolve(input)).toMatchObject({ status: "unknown" });
  });

  it.each([401, 403, 404, 429, 503])("preserves unknown on GitHub HTTP %s", async (status) => {
    const f = fixture({ "/git/ref/heads/main": new Response(null, { status }) });
    expect(await f.resolve(input)).toMatchObject({ status: "unknown" });
  });

  it("rejects a malformed positive comparison instead of trusting status alone", async () => {
    const f = fixture({ [`/compare/${HEAD}...${TIP}?per_page=1`]: { ...comparison(HEAD, true), merge_base_commit: { sha: OTHER } } });
    expect(await f.resolve(input)).toEqual({ status: "unknown", reason: "invalid_comparison_response" });
  });

  it("keeps unknown if association pagination exceeds the bounded search", async () => {
    const page = () => Response.json([], { headers: { link: '<https://host.invalid/token>; rel="next"' } });
    const f = fixture(Object.fromEntries([1, 2, 3].map((n) => [`/commits/${HEAD}/pulls?per_page=100&page=${n}`, page])));
    expect(await f.resolve(input)).toEqual({ status: "unknown", reason: "association_budget_exhausted" });
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });

  it("bounds PR candidate lookups and does not mistake exhaustion for a negative", async () => {
    const f = fixture({ [`/commits/${HEAD}/pulls?per_page=100&page=1`]: Array.from({ length: 100 }, (_, i) => ({ number: i + 100 })) });
    expect(await f.resolve(input)).toEqual({ status: "unknown", reason: "request_budget_exhausted" });
    expect(f.fetch).toHaveBeenCalledTimes(24);
  });

  it("propagates the shared request cancellation signal to an active transport", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const f = fixture({ "/git/ref/heads/main": (init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      started();
    }) });
    try {
      const result = f.resolve(input);
      await waiting;
      controller.abort();
      expect(await result).toEqual({ status: "unknown", reason: "github_unavailable" });
      expect(timeout).toHaveBeenCalledWith(20_000);
    } finally { timeout.mockRestore(); }
  });

  it("redacts transport failures", async () => {
    const f = fixture({ "/git/ref/heads/main": () => { throw new Error("test-credential secret provider response"); } });
    expect(await f.resolve(input)).toEqual({ status: "unknown", reason: "github_unavailable" });
  });

  it("cancels and rejects an oversized provider body", async () => {
    const cancel = vi.fn();
    const f = fixture({ "/git/ref/heads/main": () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel })) });
    expect(await f.resolve(input)).toEqual({ status: "unknown", reason: "response_too_large" });
    expect(cancel).toHaveBeenCalled();
  });
});
