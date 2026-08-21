import { describe, expect, it } from "vitest";
import { resolveFileCandidates, verifyWorkProduct, type VerifierDeps } from "./verifier.js";

const ROOTS = ["/vault", "/repo"];

function deps(overrides: Partial<VerifierDeps> = {}): VerifierDeps {
  return {
    roots: ROOTS,
    fileHasContent: async () => false,
    commitExists: async () => false,
    commitTouchesPath: async () => false,
    documentHasBody: async () => false,
    urlIsReachable: async () => false,
    ...overrides,
  };
}

describe("resolveFileCandidates", () => {
  it("resolves a relative path against every configured root", () => {
    expect(resolveFileCandidates("content/kurs.md", ROOTS)).toEqual([
      "/vault/content/kurs.md",
      "/repo/content/kurs.md",
    ]);
  });

  it("keeps an absolute path inside a root as-is", () => {
    expect(resolveFileCandidates("/vault/content/kurs.md", ROOTS)).toEqual(["/vault/content/kurs.md"]);
  });

  it("refuses an absolute path outside every root", () => {
    expect(resolveFileCandidates("/etc/passwd", ROOTS)).toEqual([]);
  });

  it("refuses path traversal that escapes the roots", () => {
    expect(resolveFileCandidates("../../etc/passwd", ROOTS)).toEqual([]);
  });
});

describe("verifyWorkProduct", () => {
  it("verifies a file that exists with content", async () => {
    const health = await verifyWorkProduct(
      { type: "file", provider: "git", externalId: "content/kurs.md", url: null, metadata: null },
      deps({ fileHasContent: async (p) => p === "/vault/content/kurs.md" }),
    );
    expect(health).toBe("verified");
  });

  it("reports a file that does not exist as missing", async () => {
    const health = await verifyWorkProduct(
      { type: "file", provider: "git", externalId: "content/kurs.md", url: null, metadata: null },
      deps(),
    );
    expect(health).toBe("missing");
  });

  it("reports an empty file as missing", async () => {
    const health = await verifyWorkProduct(
      { type: "file", provider: "git", externalId: "content/leer.md", url: null, metadata: null },
      deps({ fileHasContent: async () => false }),
    );
    expect(health).toBe("missing");
  });

  // A repo-relative commit only exists in *its own* repo. Checking it against the first
  // configured root reports real work as missing.
  it("checks the commit in the repo the file was found in, not in the first root", async () => {
    const seenRoots: Array<string | undefined> = [];
    const health = await verifyWorkProduct(
      {
        type: "file",
        provider: "git",
        externalId: "content/kurs.md",
        url: null,
        metadata: { commit: "a0d45ff" },
      },
      deps({
        // The file lives in the *second* root.
        fileHasContent: async (p) => p === "/repo/content/kurs.md",
        commitExists: async (_sha, root) => {
          seenRoots.push(root);
          return root === "/repo";
        },
        commitTouchesPath: async (_sha, _path, root) => root === "/repo",
      }),
    );
    expect(seenRoots).toContain("/repo");
    expect(health).toBe("verified");
  });

  it("verifies a commit found in any configured root", async () => {
    const health = await verifyWorkProduct(
      { type: "commit", provider: "git", externalId: "a0d45ff", url: null, metadata: null },
      deps({ commitExists: async (_sha, root) => root === "/repo" }),
    );
    expect(health).toBe("verified");
  });

  it("requires the named commit to actually touch the file when one is given", async () => {
    const product = {
      type: "file" as const,
      provider: "git",
      externalId: "content/kurs.md",
      url: null,
      metadata: { commit: "a0d45ff" },
    };
    const verified = await verifyWorkProduct(product, deps({
      fileHasContent: async () => true,
      commitExists: async () => true,
      commitTouchesPath: async () => true,
    }));
    expect(verified).toBe("verified");

    const lying = await verifyWorkProduct(product, deps({
      fileHasContent: async () => true,
      commitExists: async () => true,
      commitTouchesPath: async () => false,
    }));
    expect(lying).toBe("missing");
  });

  it("verifies a paperclip document with a non-empty body", async () => {
    const health = await verifyWorkProduct(
      { type: "document", provider: "paperclip", externalId: "doc-1", url: null, metadata: null },
      deps({ documentHasBody: async (id) => id === "doc-1" }),
    );
    expect(health).toBe("verified");
  });

  it("reports an empty document as missing", async () => {
    const health = await verifyWorkProduct(
      { type: "document", provider: "paperclip", externalId: "doc-empty", url: null, metadata: null },
      deps({ documentHasBody: async () => false }),
    );
    expect(health).toBe("missing");
  });

  it("verifies a reachable url", async () => {
    const health = await verifyWorkProduct(
      { type: "url", provider: "http", externalId: null, url: "https://example.test/x", metadata: null },
      deps({ urlIsReachable: async () => true }),
    );
    expect(health).toBe("verified");
  });

  it("returns unknown for a type it cannot check", async () => {
    const health = await verifyWorkProduct(
      { type: "deployment", provider: "k8s", externalId: "svc-1", url: null, metadata: null },
      deps(),
    );
    expect(health).toBe("unknown");
  });

  it("returns missing when a checkable product declares no location at all", async () => {
    const health = await verifyWorkProduct(
      { type: "file", provider: "git", externalId: null, url: null, metadata: null },
      deps({ fileHasContent: async () => true }),
    );
    expect(health).toBe("missing");
  });
});
