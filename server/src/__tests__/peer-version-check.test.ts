import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { checkExactPeerVersions, parsePeerDependenciesManifest } from "../peer-version-check.js";

/**
 * Tests for the exact-version peer-dependency gate shared by the
 * OpenTelemetry bootstrap (`instrumentation.ts`) and the Sentry bootstrap
 * (`sentry.ts`). Those two suites test each bootstrap's own use of the gate;
 * this file tests the gate module itself, including the manifest-failure and
 * resolution-parity paths neither bootstrap suite exercises directly.
 */

describe("parsePeerDependenciesManifest", () => {
  it("fails closed on invalid JSON, instead of an empty map", () => {
    const result = parsePeerDependenciesManifest("{not valid json");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not valid JSON");
  });

  it("fails closed when peerDependencies is not an object", () => {
    const result = parsePeerDependenciesManifest(JSON.stringify({ peerDependencies: "nope" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("peerDependencies field is not an object");
  });

  it("parses to an empty map when peerDependencies is absent — not a failure on its own", () => {
    const result = parsePeerDependenciesManifest(JSON.stringify({ name: "x" }));

    expect(result).toEqual({ ok: true, peerDependencies: {} });
  });

  it("parses a declared peerDependencies map", () => {
    const result = parsePeerDependenciesManifest(
      JSON.stringify({ peerDependencies: { "@sentry/node": "10.71.0" } }),
    );

    expect(result).toEqual({ ok: true, peerDependencies: { "@sentry/node": "10.71.0" } });
  });
});

describe("checkExactPeerVersions — undeclared peer entry", () => {
  it("fails closed when the peer map has no entry for a requested package, instead of silently passing it", () => {
    // An explicit empty map, not an omitted argument. This proves the
    // "missing-entry" case fails closed on its own terms, separate from a
    // manifest read failure.
    const result = checkExactPeerVersions(["@sentry/node"], {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toMatchObject({ undeclared: ["@sentry/node"] });
    }
  });
});

describe("checkExactPeerVersions — unreadable or malformed server manifest", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("fails closed instead of treating an unreadable server/package.json as an empty peer map", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: (path: unknown, options?: unknown) => {
          if (String(path).endsWith("/server/package.json")) {
            throw Object.assign(new Error("simulated read failure"), { code: "EACCES" });
          }
          return actual.readFileSync(path as never, options as never);
        },
      };
    });

    const { checkExactPeerVersions: freshCheck } = await import("../peer-version-check.js");
    // No explicit peerDependencies argument — this exercises the real
    // server/package.json read, which the mock above makes fail.
    const result = freshCheck(["@sentry/node"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic).toContain("could not read the server manifest");
      // Non-secret: the diagnostic carries the filesystem error code only,
      // never the resolved path.
      expect(result.diagnostic).not.toContain("/server/package.json");
      expect(JSON.stringify(result.detail)).toContain("EACCES");
    }
  });

  it("fails closed instead of treating a malformed server/package.json as an empty peer map", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync: (path: unknown, options?: unknown) => {
          if (String(path).endsWith("/server/package.json")) return "{not valid json";
          return actual.readFileSync(path as never, options as never);
        },
      };
    });

    const { checkExactPeerVersions: freshCheck } = await import("../peer-version-check.js");
    const result = freshCheck(["@sentry/node"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic).toContain("could not read the server manifest");
    }
  });
});

describe("resolved package URL — the checked entry and the executed entry cannot diverge", () => {
  it("the URL checkExactPeerVersions resolves for a real installed package is the exact module import() loads", async () => {
    const require = createRequire(import.meta.url);
    const zodVersion = (require("zod/package.json") as { version: string }).version;

    const result = checkExactPeerVersions(["zod"], { zod: zodVersion });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [byResolvedUrl, byBareSpecifier] = await Promise.all([
      import(/* @vite-ignore */ result.resolved.zod),
      import("zod"),
    ]);

    // Node's module cache keys by resolved URL: importing the resolved URL
    // and importing the bare specifier return the exact same object only
    // when both resolve to the same file. This is a direct proof that the
    // package version checkExactPeerVersions read, and the module a
    // bootstrap's later import() loads, are provably one and the same
    // package — the two cannot diverge.
    expect(byResolvedUrl).toBe(byBareSpecifier);
  });
});
