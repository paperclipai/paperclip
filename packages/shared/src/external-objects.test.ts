import { describe, expect, it } from "vitest";
import { formatExternalObjectMentionSourceLabel } from "./external-objects.js";
import {
  buildExternalObjectMentionSourceKey,
  buildExternalObjectScopedIdentityKey,
  canonicalizeExternalObjectUrl,
  extractExternalObjectCanonicalUrls,
  findExternalObjectUrlMatches,
} from "./external-objects-server.js";
import { externalObjectProviderKeySchema, externalObjectTypeSchema } from "./validators/external-object.js";

describe("external object references", () => {
  it("extracts external urls without changing internal issue reference behavior", () => {
    expect(
      findExternalObjectUrlMatches(
        "See PAP-1, /issues/PAP-2, https://paperclip.ing/PAP/issues/PAP-3, and https://github.com/acme/app/pull/4.",
      ),
    ).toEqual([{ index: 70, length: 34, matchedText: "https://github.com/acme/app/pull/4" }]);
  });

  it("ignores urls inside inline and fenced code", () => {
    const markdown = [
      "Use https://github.com/acme/app/pull/1 here.",
      "`https://github.com/acme/app/pull/2` should not count.",
      "```",
      "https://github.com/acme/app/pull/3",
      "```",
    ].join("\n");

    expect(findExternalObjectUrlMatches(markdown).map((match) => match.matchedText)).toEqual([
      "https://github.com/acme/app/pull/1",
    ]);
  });

  it("canonicalizes urls by stripping query and fragment by default", () => {
    expect(canonicalizeExternalObjectUrl("HTTPS://GitHub.com/acme/app/pull/1?token=secret#discussion")).toMatchObject({
      sanitizedCanonicalUrl: "https://github.com/acme/app/pull/1",
      sanitizedDisplayUrl: "https://github.com/acme/app/pull/1",
      redactedMatchedText: "https://github.com/acme/app/pull/1",
      canonicalIdentity: {
        scheme: "https",
        host: "github.com",
        path: "/acme/app/pull/1",
      },
    });
  });

  it("rejects urls with userinfo", () => {
    expect(canonicalizeExternalObjectUrl("https://token:secret@github.com/acme/app/pull/1")).toBeNull();
  });

  it("hashes provider-required query identity values without storing plaintext", () => {
    const first = canonicalizeExternalObjectUrl("https://deploy.test/run?id=secret-run&token=drop", {
      identityQueryParams: ["id"],
    });
    const second = canonicalizeExternalObjectUrl("https://deploy.test/run?id=secret-run&token=other", {
      identityQueryParams: ["id"],
    });

    expect(first?.sanitizedCanonicalUrl).toBe("https://deploy.test/run");
    expect(first?.canonicalIdentity.queryParamHashes?.id).toHaveLength(64);
    expect(first?.canonicalIdentity.queryParamHashes?.id).not.toContain("secret-run");
    expect(second?.canonicalIdentityHash).toBe(first?.canonicalIdentityHash);
  });

  it("dedupes extracted canonical urls by canonical identity", () => {
    expect(
      extractExternalObjectCanonicalUrls(
        "https://github.com/acme/app/pull/1?token=a and https://github.com/acme/app/pull/1#discussion",
      ).map((entry) => entry.sanitizedCanonicalUrl),
    ).toEqual(["https://github.com/acme/app/pull/1"]);
  });

  it("includes company id in scoped object identity keys", () => {
    const base = {
      providerKey: "github",
      objectType: "pull_request",
      canonicalIdentityHash: "hash",
    };

    expect(buildExternalObjectScopedIdentityKey({ companyId: "company-a", ...base })).not.toBe(
      buildExternalObjectScopedIdentityKey({ companyId: "company-b", ...base }),
    );
  });

  it("builds source keys for replacing mentions from the same source", () => {
    const oldMentionSource = buildExternalObjectMentionSourceKey({
      companyId: "company-a",
      sourceIssueId: "issue-1",
      sourceKind: "comment",
      sourceRecordId: "comment-1",
    });
    const newMentionSource = buildExternalObjectMentionSourceKey({
      companyId: "company-a",
      sourceIssueId: "issue-1",
      sourceKind: "comment",
      sourceRecordId: "comment-1",
    });
    const anotherCompanySource = buildExternalObjectMentionSourceKey({
      companyId: "company-b",
      sourceIssueId: "issue-1",
      sourceKind: "comment",
      sourceRecordId: "comment-1",
    });

    expect(newMentionSource).toBe(oldMentionSource);
    expect(anotherCompanySource).not.toBe(oldMentionSource);
  });

  it("formats stable source labels", () => {
    expect(formatExternalObjectMentionSourceLabel({ sourceKind: "title" })).toBe("Title");
    expect(formatExternalObjectMentionSourceLabel({ sourceKind: "document", documentKey: "plan" })).toBe(
      "Document: plan",
    );
    expect(formatExternalObjectMentionSourceLabel({ sourceKind: "property", propertyKey: "pr" })).toBe(
      "Property: pr",
    );
  });

  it("validates provider keys and object types", () => {
    expect(externalObjectProviderKeySchema.parse("github.enterprise")).toBe("github.enterprise");
    expect(externalObjectTypeSchema.parse("pull_request")).toBe("pull_request");
    expect(externalObjectProviderKeySchema.safeParse("GitHub").success).toBe(false);
    expect(externalObjectTypeSchema.safeParse("pull-request").success).toBe(false);
  });
});
