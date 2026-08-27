import { describe, expect, it } from "vitest";
import {
  ASSET_NAMESPACE_MAX_LENGTH,
  createAssetImageMetadataSchema,
  sanitizeAssetNamespace,
} from "./asset.js";

function parseNamespace(namespace: string) {
  return createAssetImageMetadataSchema.safeParse({ namespace });
}

describe("createAssetImageMetadataSchema", () => {
  it("accepts a plain slug namespace", () => {
    expect(parseNamespace("goals/drafts").success).toBe(true);
  });

  it("accepts identity-provider user ids", () => {
    const namespaces = [
      "profiles/oidc:example|user-1",
      "profiles/jane.example@example.com",
      "profiles/auth0|507f1f77bcf86cd799439011",
      "profiles/https:__id.example.com_users_1",
    ];
    for (const namespace of namespaces) {
      expect(parseNamespace(namespace), namespace).toMatchObject({ success: true });
    }
  });

  it("accepts filenames that contain a dot", () => {
    expect(parseNamespace("agents/agent-1/instructions/SKILL.md").success).toBe(true);
  });

  it("treats the namespace as optional", () => {
    expect(createAssetImageMetadataSchema.parse({})).toEqual({});
  });

  it("trims surrounding whitespace", () => {
    expect(createAssetImageMetadataSchema.parse({ namespace: "  goals  " })).toEqual({
      namespace: "goals",
    });
  });

  it("rejects namespaces with characters outside the accepted set", () => {
    const namespaces = ["profiles/bad name!", "profiles/user#1", "profiles/user\\1", "profiles/user?x=1"];
    for (const namespace of namespaces) {
      expect(parseNamespace(namespace).success, namespace).toBe(false);
    }
  });

  it("rejects empty and whitespace-only namespaces", () => {
    expect(parseNamespace("").success).toBe(false);
    expect(parseNamespace("   ").success).toBe(false);
  });

  it("rejects namespaces longer than the maximum length", () => {
    expect(parseNamespace("a".repeat(ASSET_NAMESPACE_MAX_LENGTH)).success).toBe(true);
    expect(parseNamespace("a".repeat(ASSET_NAMESPACE_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("rejects dot path segments", () => {
    const namespaces = ["profiles/../secrets", "../secrets", "profiles/./self", "profiles/..", "."];
    for (const namespace of namespaces) {
      expect(parseNamespace(namespace).success, namespace).toBe(false);
    }
  });

  it("names the namespace field in the failure message", () => {
    const parsed = parseNamespace("profiles/bad name!");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("namespace");
    expect(parsed.error?.issues[0]?.path).toEqual(["namespace"]);
  });
});

describe("sanitizeAssetNamespace", () => {
  it("keeps identity-provider user ids unchanged", () => {
    const namespaces = [
      "profiles/oidc:example|user-1",
      "profiles/jane.example@example.com",
      "agents/agent-1/instructions/SKILL.md",
    ];
    for (const namespace of namespaces) {
      expect(sanitizeAssetNamespace(namespace), namespace).toBe(namespace);
    }
  });

  it("replaces characters outside the accepted set with a dash", () => {
    expect(sanitizeAssetNamespace("profiles/bad name")).toBe("profiles/bad-name");
    expect(sanitizeAssetNamespace("profiles/user#1")).toBe("profiles/user-1");
  });

  it("collapses repeated dashes", () => {
    expect(sanitizeAssetNamespace("profiles/a  b")).toBe("profiles/a-b");
    expect(sanitizeAssetNamespace("profiles/a???b")).toBe("profiles/a-b");
  });

  it("removes control characters", () => {
    expect(sanitizeAssetNamespace("profiles/user\u0000\u0007id")).toBe("profiles/user-id");
  });

  it("trims whitespace around every segment", () => {
    expect(sanitizeAssetNamespace("  profiles  /  user-1  ")).toBe("profiles/user-1");
  });

  it("drops empty segments", () => {
    expect(sanitizeAssetNamespace("profiles//user-1/")).toBe("profiles/user-1");
    expect(sanitizeAssetNamespace("/profiles/user-1")).toBe("profiles/user-1");
  });

  it("drops the . and .. segments", () => {
    expect(sanitizeAssetNamespace("profiles/../secrets")).toBe("profiles/secrets");
    expect(sanitizeAssetNamespace("profiles/./user-1")).toBe("profiles/user-1");
    expect(sanitizeAssetNamespace("../../etc/passwd")).toBe("etc/passwd");
  });

  it("keeps a segment of three or more dots, which the schema accepts", () => {
    expect(sanitizeAssetNamespace("profiles/...")).toBe("profiles/...");
    expect(sanitizeAssetNamespace("profiles/....")).toBe("profiles/....");
    expect(parseNamespace("profiles/...").success).toBe(true);
  });

  it("caps the result at the maximum length", () => {
    const long = `profiles/${"a".repeat(400)}`;
    const sanitized = sanitizeAssetNamespace(long);
    expect(sanitized).toBeDefined();
    expect(sanitized?.length).toBe(ASSET_NAMESPACE_MAX_LENGTH);
  });

  it("does not leave a dot segment behind after a cut", () => {
    const long = `${"a".repeat(ASSET_NAMESPACE_MAX_LENGTH - 3)}/..b`;
    expect(sanitizeAssetNamespace(long)).toBe("a".repeat(ASSET_NAMESPACE_MAX_LENGTH - 3));
  });

  it("returns undefined when no segment survives", () => {
    expect(sanitizeAssetNamespace("")).toBeUndefined();
    expect(sanitizeAssetNamespace("   ")).toBeUndefined();
    expect(sanitizeAssetNamespace("///")).toBeUndefined();
    expect(sanitizeAssetNamespace("../..")).toBeUndefined();
  });

  it("returns a value that the schema accepts", () => {
    const inputs = [
      "profiles/oidc:example|user-1",
      "profiles/bad name!",
      "profiles/../secrets",
      `profiles/${"a".repeat(400)}`,
      `${"a".repeat(ASSET_NAMESPACE_MAX_LENGTH - 3)}/..b`,
      "profiles/user\u0000id",
    ];
    for (const input of inputs) {
      const sanitized = sanitizeAssetNamespace(input);
      expect(sanitized, input).toBeDefined();
      expect(parseNamespace(sanitized as string).success, `${input} -> ${sanitized}`).toBe(true);
    }
  });
});
