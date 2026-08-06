import { describe, expect, it } from "vitest";
import {
  BOARD_API_KEY_PERMISSION_KEYS,
  BOARD_API_KEY_SCOPE_PRESETS,
  boardApiKeyScopeConfigSchema,
  deriveBoardApiKeyStatus,
} from "./board-api-key-scope.js";
import { createBoardApiKeySchema } from "./validators/access.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function validScope() {
  return {
    version: 1 as const,
    kind: "scoped" as const,
    companyIds: [COMPANY_ID],
    permissions: ["companies:read" as const],
    instanceCapabilities: [] as const,
  };
}

describe("boardApiKeyScopeConfigSchema", () => {
  it("round trips the strict version-1 shape without normalization", () => {
    const input = validScope();
    expect(boardApiKeyScopeConfigSchema.parse(input)).toEqual(input);
  });

  it.each([
    ["unknown object key", { ...validScope(), extra: true }],
    ["unsupported version", { ...validScope(), version: 2 }],
    ["unsupported kind", { ...validScope(), kind: "legacy" }],
    ["empty companies", { ...validScope(), companyIds: [] }],
    ["duplicate companies", { ...validScope(), companyIds: [COMPANY_ID, COMPANY_ID] }],
    ["noncanonical company UUID", { ...validScope(), companyIds: [COMPANY_ID.toUpperCase()] }],
    ["empty permissions", { ...validScope(), permissions: [] }],
    ["duplicate permissions", { ...validScope(), permissions: ["companies:read", "companies:read"] }],
    ["unknown permission", { ...validScope(), permissions: ["companies:admin"] }],
    ["unsupported capability", { ...validScope(), instanceCapabilities: ["root"] }],
    ["duplicate capability", { ...validScope(), instanceCapabilities: ["instance_admin", "instance_admin"] }],
    ["coerced version", { ...validScope(), version: "1" }],
    ["trimmed permission", { ...validScope(), permissions: [" companies:read"] }],
  ])("rejects %s", (_label, input) => {
    expect(boardApiKeyScopeConfigSchema.safeParse(input).success).toBe(false);
  });

  it("enforces the company and permission cardinality bounds", () => {
    const tooManyCompanies = Array.from(
      { length: 51 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    );
    expect(boardApiKeyScopeConfigSchema.safeParse({ ...validScope(), companyIds: tooManyCompanies }).success).toBe(false);
    expect(BOARD_API_KEY_PERMISSION_KEYS).toHaveLength(59);
    expect(boardApiKeyScopeConfigSchema.parse({
      ...validScope(),
      permissions: [...BOARD_API_KEY_PERMISSION_KEYS],
    }).permissions).toHaveLength(59);
  });
});

describe("frozen board API key vocabulary and presets", () => {
  it("freezes the canonical 59 permission keys in numeric order", () => {
    expect(BOARD_API_KEY_PERMISSION_KEYS).toMatchSnapshot();
  });

  it("freezes all three ordered preset expansions", () => {
    expect(BOARD_API_KEY_SCOPE_PRESETS).toMatchSnapshot();
  });
});

describe("createBoardApiKeySchema", () => {
  it("requires an explicit strict non-null scope", () => {
    const valid = {
      name: "automation",
      expiresAt: "2026-09-05T12:00:00.000Z",
      scopeConfig: validScope(),
    };
    expect(createBoardApiKeySchema.parse(valid)).toEqual(valid);
    expect(createBoardApiKeySchema.safeParse({ name: "automation" }).success).toBe(false);
    expect(createBoardApiKeySchema.safeParse({ ...valid, scopeConfig: null }).success).toBe(false);
  });

  it.each([
    ["trimmed name", { name: " automation", scopeConfig: validScope() }],
    ["blank name", { name: "   ", scopeConfig: validScope() }],
    ["coerced expiry", { name: "automation", expiresAt: new Date(), scopeConfig: validScope() }],
    ["unknown key", { name: "automation", requestedCompanyId: COMPANY_ID, scopeConfig: validScope() }],
  ])("rejects %s", (_label, input) => {
    expect(createBoardApiKeySchema.safeParse(input).success).toBe(false);
  });
});

describe("deriveBoardApiKeyStatus", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");

  it("derives revoked, expired, finite, and never-expiring states", () => {
    expect(deriveBoardApiKeyStatus({ revokedAt: now, expiresAt: null }, now)).toBe("revoked");
    expect(deriveBoardApiKeyStatus({ revokedAt: null, expiresAt: now }, now)).toBe("expired");
    expect(deriveBoardApiKeyStatus({ revokedAt: null, expiresAt: "2026-08-07T12:00:00.000Z" }, now)).toBe("expires");
    expect(deriveBoardApiKeyStatus({ revokedAt: null, expiresAt: null }, now)).toBe("never_expires");
  });
});
