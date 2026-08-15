import { describe, expect, it } from "vitest";
import {
  COMPANY_WORK_PROJECTION_API_VERSION,
  createCompanyWorkProjectionCredentialSchema,
  createdCompanyWorkProjectionCredentialSchema,
  companyWorkProjectionResponseSchema,
} from "./company-work-projection.js";
import { agentApiKeyScopeSchema } from "./agent.js";

describe("company work projection contracts", () => {
  it("keeps projection credentials outside normal agent scope composition", () => {
    expect(agentApiKeyScopeSchema.safeParse({ kind: "company_work_projection_read" }).success).toBe(false);
    expect(createdCompanyWorkProjectionCredentialSchema.parse({
      id: "00000000-0000-4000-8000-000000000003",
      companyId: "00000000-0000-4000-8000-000000000001",
      name: "Synthetic reader",
      tokenVersion: 1,
      token: `pcwp_v1_${"a".repeat(48)}`,
      createdAt: "2026-08-14T20:00:00.000Z",
      revokedAt: null,
    }).token).toMatch(/^pcwp_v1_/);
    expect(createCompanyWorkProjectionCredentialSchema.safeParse({
      name: "Synthetic reader",
      unexpected: "private",
    }).success).toBe(false);
  });

  it("keeps the response closed and versioned", () => {
    const response = {
      apiVersion: COMPANY_WORK_PROJECTION_API_VERSION,
      schemaVersion: 1,
      companyId: "00000000-0000-4000-8000-000000000001",
      snapshot: {
        revision: "0",
        issuedAt: "2026-08-14T20:00:00.000Z",
        expiresAt: "2026-08-14T20:05:00.000Z",
      },
      items: [],
      page: { size: 0, hasMore: false, nextCursor: null, completeness: "complete" },
      etag: `"${"a".repeat(64)}"`,
    };
    expect(companyWorkProjectionResponseSchema.parse(response)).toEqual(response);
    expect(companyWorkProjectionResponseSchema.safeParse({ ...response, description: "private" }).success).toBe(false);
    expect(companyWorkProjectionResponseSchema.safeParse({ ...response, schemaVersion: 2 }).success).toBe(false);
  });
});
