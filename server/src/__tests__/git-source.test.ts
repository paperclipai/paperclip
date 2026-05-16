import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listServerRefs = vi.fn();
const cloneFn = vi.fn();
const walkFn = vi.fn();
const readBlobFn = vi.fn();
const resolveRefFn = vi.fn();
const treeFn = vi.fn((args: unknown) => ({ __tree: args }));

vi.mock("isomorphic-git", () => ({
  default: {
    listServerRefs: (...args: unknown[]) => listServerRefs(...args),
    clone: (...args: unknown[]) => cloneFn(...args),
    walk: (...args: unknown[]) => walkFn(...args),
    readBlob: (...args: unknown[]) => readBlobFn(...args),
    resolveRef: (...args: unknown[]) => resolveRefFn(...args),
    TREE: (...args: unknown[]) => treeFn(...args),
  },
}));

vi.mock("isomorphic-git/http/node", () => ({
  default: { request: vi.fn() },
}));

const { parseGitSourceUrl, resolveGitRef, openRepoSnapshot, buildCloneUrl } =
  await import("../services/git-source.js");

beforeEach(() => {
  listServerRefs.mockReset();
  cloneFn.mockReset();
  walkFn.mockReset();
  readBlobFn.mockReset();
  resolveRefFn.mockReset();
  treeFn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseGitSourceUrl", () => {
  it("parses a bare github repo URL", () => {
    expect(parseGitSourceUrl("https://github.com/anthropics/claude-code")).toMatchObject({
      cloneUrl: "https://github.com/anthropics/claude-code.git",
      hostname: "github.com",
      owner: "anthropics",
      repo: "claude-code",
      ref: null,
      basePath: "",
      filePath: null,
      explicitRef: false,
    });
  });

  it("strips trailing .git from the repo segment", () => {
    expect(parseGitSourceUrl("https://example.com/o/r.git")).toMatchObject({
      cloneUrl: "https://example.com/o/r.git",
      repo: "r",
    });
  });

  it("parses a github tree URL with subpath", () => {
    expect(
      parseGitSourceUrl("https://github.com/o/r/tree/develop/sub/dir"),
    ).toMatchObject({
      ref: "develop",
      basePath: "sub/dir",
      filePath: null,
      explicitRef: true,
    });
  });

  it("parses a github blob URL as a file path", () => {
    expect(
      parseGitSourceUrl("https://github.com/o/r/blob/main/path/to/file.md"),
    ).toMatchObject({
      ref: "main",
      basePath: "path/to",
      filePath: "path/to/file.md",
      explicitRef: true,
    });
  });

  it("parses a gitea src/branch URL with subpath", () => {
    expect(
      parseGitSourceUrl("https://git.example.com/o/r/src/branch/main/skills"),
    ).toMatchObject({
      cloneUrl: "https://git.example.com/o/r.git",
      ref: "main",
      basePath: "skills",
      filePath: null,
      explicitRef: true,
    });
  });

  it("parses a gitea src/tag URL", () => {
    expect(
      parseGitSourceUrl("https://git.example.com/o/r/src/tag/v1.2.3"),
    ).toMatchObject({
      ref: "v1.2.3",
      basePath: "",
      explicitRef: true,
    });
  });

  it("parses a gitea src/commit URL with file", () => {
    expect(
      parseGitSourceUrl("https://git.example.com/o/r/src/commit/abc123/dir/SKILL.md"),
    ).toMatchObject({
      ref: "abc123",
      basePath: "dir",
      filePath: "dir/SKILL.md",
    });
  });

  it("parses a gitlab tree URL", () => {
    expect(
      parseGitSourceUrl("https://gitlab.com/group/proj/-/tree/main/sub"),
    ).toMatchObject({
      cloneUrl: "https://gitlab.com/group/proj.git",
      ref: "main",
      basePath: "sub",
      explicitRef: true,
    });
  });

  it("parses a gitlab blob URL", () => {
    expect(
      parseGitSourceUrl("https://gitlab.com/group/proj/-/blob/main/sub/file.md"),
    ).toMatchObject({
      ref: "main",
      filePath: "sub/file.md",
      basePath: "sub",
    });
  });

  it("rejects non-https URLs", () => {
    expect(() => parseGitSourceUrl("http://github.com/o/r")).toThrow(/HTTPS/);
  });

  it("rejects URLs without owner/repo", () => {
    expect(() => parseGitSourceUrl("https://github.com/o")).toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => parseGitSourceUrl("not a url")).toThrow();
  });
});

describe("buildCloneUrl", () => {
  it("produces a .git suffix URL on the given host", () => {
    expect(buildCloneUrl("git.example.com", "o", "r")).toBe(
      "https://git.example.com/o/r.git",
    );
  });
});

describe("resolveGitRef", () => {
  it("passes through a 40-hex SHA without hitting the network", async () => {
    const parsed = parseGitSourceUrl(
      "https://github.com/o/r/tree/0123456789abcdef0123456789abcdef01234567",
    );
    const result = await resolveGitRef(parsed);
    expect(result).toEqual({
      pinnedSha: "0123456789abcdef0123456789abcdef01234567",
      trackingRef: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(listServerRefs).not.toHaveBeenCalled();
  });

  it("returns default branch via HEAD symref when ref is absent", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "HEAD", oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", target: "refs/heads/main" },
      { ref: "refs/heads/main", oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { ref: "refs/heads/chore", oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    const result = await resolveGitRef(parsed);
    expect(result).toEqual({
      pinnedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      trackingRef: "main",
    });
    expect(listServerRefs).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://git.example.com/o/r.git",
        symrefs: true,
        protocolVersion: 2,
      }),
    );
  });

  it("resolves a named branch to its SHA", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "HEAD", oid: "1111111111111111111111111111111111111111", target: "refs/heads/main" },
      { ref: "refs/heads/main", oid: "1111111111111111111111111111111111111111" },
      { ref: "refs/heads/develop", oid: "2222222222222222222222222222222222222222" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r/src/branch/develop");
    const result = await resolveGitRef(parsed);
    expect(result).toEqual({
      pinnedSha: "2222222222222222222222222222222222222222",
      trackingRef: "develop",
    });
  });

  it("prefers a peeled annotated tag over the tag object", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "refs/tags/v1.0", oid: "tttttttttttttttttttttttttttttttttttttttt" },
      { ref: "refs/tags/v1.0^{}", oid: "cccccccccccccccccccccccccccccccccccccccc" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r/src/tag/v1.0");
    const result = await resolveGitRef(parsed);
    expect(result.pinnedSha).toBe("cccccccccccccccccccccccccccccccccccccccc");
    expect(result.trackingRef).toBe("v1.0");
  });

  it("resolves a lightweight tag when no peeled entry exists", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "refs/tags/v2.0", oid: "dddddddddddddddddddddddddddddddddddddddd" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r/src/tag/v2.0");
    const result = await resolveGitRef(parsed);
    expect(result.pinnedSha).toBe("dddddddddddddddddddddddddddddddddddddddd");
  });

  it("throws when an explicit ref does not exist", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "HEAD", oid: "9999999999999999999999999999999999999999", target: "refs/heads/main" },
      { ref: "refs/heads/main", oid: "9999999999999999999999999999999999999999" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r/src/branch/missing");
    await expect(resolveGitRef(parsed)).rejects.toThrow(/Ref 'missing' not found/);
  });

  it("translates network errors into a user-facing message", async () => {
    listServerRefs.mockRejectedValue(new Error("ENOTFOUND git.invalid"));
    const parsed = parseGitSourceUrl("https://git.invalid/o/r");
    await expect(resolveGitRef(parsed)).rejects.toThrow(/could not connect/i);
  });

  it("translates 401 errors into an auth message", async () => {
    listServerRefs.mockRejectedValue(new Error("HTTP Error: 401 Unauthorized"));
    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    await expect(resolveGitRef(parsed)).rejects.toThrow(/authentication/i);
  });

  it("translates 404 errors into a repo-not-found message", async () => {
    listServerRefs.mockRejectedValue(new Error("HTTP Error: 404 Not Found"));
    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    await expect(resolveGitRef(parsed)).rejects.toThrow(/repository not found/i);
  });

  it("sends an onAuth callback when a token is supplied", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "HEAD", oid: "1111111111111111111111111111111111111111", target: "refs/heads/main" },
      { ref: "refs/heads/main", oid: "1111111111111111111111111111111111111111" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    await resolveGitRef(parsed, "tok_abc");
    const callArgs = listServerRefs.mock.calls[0]![0] as { onAuth: () => unknown };
    expect(typeof callArgs.onAuth).toBe("function");
    expect(callArgs.onAuth()).toEqual({ username: "tok_abc", password: "x-oauth-basic" });
  });

  it("omits onAuth when no token is supplied", async () => {
    listServerRefs.mockResolvedValue([
      { ref: "HEAD", oid: "1111111111111111111111111111111111111111", target: "refs/heads/main" },
      { ref: "refs/heads/main", oid: "1111111111111111111111111111111111111111" },
    ]);
    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    await resolveGitRef(parsed);
    const callArgs = listServerRefs.mock.calls[0]![0] as { onAuth?: unknown };
    expect(callArgs.onAuth).toBeUndefined();
  });
});

describe("openRepoSnapshot", () => {
  it("clones at the tracking ref and walks the tree at the resolved SHA", async () => {
    cloneFn.mockResolvedValue(undefined);
    resolveRefFn.mockResolvedValue("ffffffffffffffffffffffffffffffffffffffff");
    walkFn.mockImplementation(async ({ map }: { map: (filepath: string, entries: Array<{ type: () => Promise<string> }>) => Promise<void> }) => {
      await map(".", [{ type: () => Promise.resolve("tree") }]);
      await map("README.md", [{ type: () => Promise.resolve("blob") }]);
      await map("skills/x/SKILL.md", [{ type: () => Promise.resolve("blob") }]);
      await map("skills/x", [{ type: () => Promise.resolve("tree") }]);
    });
    readBlobFn.mockResolvedValue({ blob: new TextEncoder().encode("hello") });

    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    const snap = await openRepoSnapshot(parsed, "main", "ffffffffffffffffffffffffffffffffffffffff", "tok");

    expect(cloneFn).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://git.example.com/o/r.git",
        ref: "main",
        singleBranch: true,
        depth: 1,
        noCheckout: true,
      }),
    );
    expect(snap.sha).toBe("ffffffffffffffffffffffffffffffffffffffff");

    const files = await snap.listFiles();
    expect(files).toEqual(["README.md", "skills/x/SKILL.md"]);

    const content = await snap.readFile("README.md");
    expect(content).toBe("hello");
    expect(readBlobFn).toHaveBeenCalledWith(
      expect.objectContaining({
        oid: "ffffffffffffffffffffffffffffffffffffffff",
        filepath: "README.md",
      }),
    );
  });

  it("falls back to the expected SHA as ref when no tracking ref is known", async () => {
    cloneFn.mockResolvedValue(undefined);
    resolveRefFn.mockResolvedValue("abc1234567890abc1234567890abc1234567890a");
    walkFn.mockImplementation(async () => {});

    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    await openRepoSnapshot(parsed, null, "abc1234567890abc1234567890abc1234567890a");

    expect(cloneFn).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "abc1234567890abc1234567890abc1234567890a" }),
    );
  });

  it("surfaces a 404 from clone as repository-not-found", async () => {
    cloneFn.mockRejectedValue(new Error("HTTP Error: 404 Not Found"));
    const parsed = parseGitSourceUrl("https://git.example.com/o/r");
    await expect(
      openRepoSnapshot(parsed, "main", "1111111111111111111111111111111111111111"),
    ).rejects.toThrow(/repository not found/i);
  });
});
