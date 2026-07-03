import { describe, expect, it } from "vitest";
import {
  buildExternalObjectMentionSourceKey,
  buildExternalObjectScopedIdentityKey,
  canonicalizeExternalObjectUrl,
  extractExternalObjectCanonicalUrls,
  findExternalObjectUrlMatches,
} from "./external-objects-server.js";

describe("findExternalObjectUrlMatches", () => {
  it("returns an empty list for empty markdown", () => {
    expect(findExternalObjectUrlMatches("")).toEqual([]);
    expect(findExternalObjectUrlMatches("no links here")).toEqual([]);
  });

  it("finds plain http and https URLs", () => {
    const matches = findExternalObjectUrlMatches("See https://example.com/docs and http://other.test/page.");
    expect(matches.map((m) => m.matchedText)).toEqual([
      "https://example.com/docs",
      "http://other.test/page",
    ]);
  });

  it("trims trailing sentence punctuation", () => {
    const [dot] = findExternalObjectUrlMatches("Ends here https://example.com/a.");
    expect(dot?.matchedText).toBe("https://example.com/a");

    const [comma] = findExternalObjectUrlMatches("Ends here: https://example.com/b,");
    expect(comma?.matchedText).toBe("https://example.com/b");
  });

  it("stops URL tokens at parentheses, so markdown link syntax does not leak in", () => {
    const [match] = findExternalObjectUrlMatches("See [docs](https://example.com/docs) now.");
    expect(match?.matchedText).toBe("https://example.com/docs");
  });

  it("ignores URLs inside fenced code blocks and inline code", () => {
    const markdown = [
      "```",
      "https://fenced.example.com/skip",
      "```",
      "Inline `https://inline.example.com/skip` too.",
      "But https://kept.example.com/page survives.",
    ].join("\n");
    const matches = findExternalObjectUrlMatches(markdown);
    expect(matches.map((m) => m.matchedText)).toEqual(["https://kept.example.com/page"]);
  });

  it("skips internal issue-reference URLs", () => {
    const matches = findExternalObjectUrlMatches(
      "Track https://app.example.com/issues/ENG-42 and https://external.test/thing",
    );
    expect(matches.map((m) => m.matchedText)).toEqual(["https://external.test/thing"]);
  });

  it("reports the index and length of each match", () => {
    const markdown = "before https://example.com/x after";
    const [match] = findExternalObjectUrlMatches(markdown);
    expect(match?.index).toBe(markdown.indexOf("https://"));
    expect(match?.length).toBe("https://example.com/x".length);
  });
});

describe("canonicalizeExternalObjectUrl", () => {
  it("lowercases the host, keeps the path, and drops query/fragment from the sanitized URL", () => {
    const canonical = canonicalizeExternalObjectUrl("https://Docs.Example.COM/Path/Page?utm_source=x#frag");
    expect(canonical?.sanitizedCanonicalUrl).toBe("https://docs.example.com/Path/Page");
    expect(canonical?.sanitizedDisplayUrl).toBe("https://docs.example.com/Path/Page");
    expect(canonical?.canonicalIdentity).toMatchObject({
      scheme: "https",
      host: "docs.example.com",
      path: "/Path/Page",
    });
  });

  it("normalizes an empty path to '/'", () => {
    expect(canonicalizeExternalObjectUrl("https://example.com")?.sanitizedCanonicalUrl).toBe("https://example.com/");
  });

  it("rejects non-http(s) protocols, credentials, and invalid URLs", () => {
    expect(canonicalizeExternalObjectUrl("ftp://example.com/file")).toBeNull();
    expect(canonicalizeExternalObjectUrl("mailto:user@example.com")).toBeNull();
    expect(canonicalizeExternalObjectUrl("https://user:pass@example.com/")).toBeNull();
    expect(canonicalizeExternalObjectUrl("not a url")).toBeNull();
  });

  it("ignores query params unless declared as identity params", () => {
    const a = canonicalizeExternalObjectUrl("https://example.com/doc?tab=1");
    const b = canonicalizeExternalObjectUrl("https://example.com/doc?tab=2");
    expect(a?.canonicalIdentityHash).toBe(b?.canonicalIdentityHash);
    expect(a?.canonicalIdentity.queryParamHashes).toBeUndefined();
  });

  it("hashes declared identity query params into the identity", () => {
    const options = { identityQueryParams: ["id"] };
    const a = canonicalizeExternalObjectUrl("https://example.com/doc?id=1", options);
    const b = canonicalizeExternalObjectUrl("https://example.com/doc?id=2", options);
    const aAgain = canonicalizeExternalObjectUrl("https://example.com/doc?id=1", options);

    expect(a?.canonicalIdentity.queryParamHashes?.id).toBeTypeOf("string");
    expect(a?.canonicalIdentityHash).not.toBe(b?.canonicalIdentityHash);
    expect(a?.canonicalIdentityHash).toBe(aAgain?.canonicalIdentityHash);
    // The raw value must never appear — only its hash.
    expect(JSON.stringify(a)).not.toContain("id=1");
  });
});

describe("extractExternalObjectCanonicalUrls", () => {
  it("deduplicates URLs that share a canonical identity, preserving order", () => {
    const markdown = [
      "First https://Example.com/doc?utm=1",
      "Dupe https://example.com/doc",
      "Then https://example.com/other",
    ].join("\n");
    const urls = extractExternalObjectCanonicalUrls(markdown);
    expect(urls.map((u) => u.sanitizedCanonicalUrl)).toEqual([
      "https://example.com/doc",
      "https://example.com/other",
    ]);
  });

  it("drops matches that cannot be canonicalized", () => {
    expect(extractExternalObjectCanonicalUrls("")).toEqual([]);
  });
});

describe("scoped key builders", () => {
  it("joins scoped identity key parts with colons", () => {
    expect(
      buildExternalObjectScopedIdentityKey({
        companyId: "co",
        providerKey: "github",
        objectType: "pr",
        canonicalIdentityHash: "abc",
      }),
    ).toBe("co:github:pr:abc");
  });

  it("uses empty slots for absent optional mention source fields", () => {
    expect(
      buildExternalObjectMentionSourceKey({
        companyId: "co",
        sourceIssueId: "issue",
        sourceKind: "comment",
      }),
    ).toBe("co:issue:comment:::");

    expect(
      buildExternalObjectMentionSourceKey({
        companyId: "co",
        sourceIssueId: "issue",
        sourceKind: "document",
        sourceRecordId: "rec",
        documentKey: "doc",
        propertyKey: "prop",
      }),
    ).toBe("co:issue:document:rec:doc:prop");
  });
});
