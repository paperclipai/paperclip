import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionGrant } from "@paperclipai/shared";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { toolsApi } from "./tools";

/** A minimal well-formed grant row. */
function sampleGrant(overrides: Partial<ConnectionGrant> = {}): ConnectionGrant {
  return {
    id: "grant-1",
    companyId: "company-1",
    connectionId: "conn-1",
    kind: "workspace",
    subjectUserId: null,
    providerTenant: { name: "Acme workspace" },
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
    createdByAgentId: null,
    createdByUserId: null,
    revokedAt: null,
    revokedByAgentId: null,
    revokedByUserId: null,
    lastUsedAt: null,
    createdAt: new Date("2026-07-21T00:00:00Z"),
    updatedAt: new Date("2026-07-21T00:00:00Z"),
    ...overrides,
  };
}

describe("toolsApi.listConnectionGrants", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  // Root cause of PAP-14922: the route returns `{ connection, grants }`, not a
  // bare array. The client must unwrap `.grants` so callers can `.filter(...)`.
  it("unwraps the `.grants` array from the server wrapper response", async () => {
    const grant = sampleGrant();
    mockApi.get.mockResolvedValue({
      connection: { id: "conn-1", uid: "acme" },
      grants: [grant],
    });
    const res = await toolsApi.listConnectionGrants("conn-1");
    expect(mockApi.get).toHaveBeenCalledWith("/tool-connections/conn-1/grants");
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("grant-1");
    // The exact call site that crashed with "grants.filter is not a function".
    expect(() => res.filter((g) => g.status !== "revoked")).not.toThrow();
  });

  it("passes a bare array through unchanged (forward/back compat)", async () => {
    mockApi.get.mockResolvedValue([sampleGrant()]);
    const res = await toolsApi.listConnectionGrants("conn-1");
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
  });

  it("returns [] for a wrapper with a non-array `grants`", async () => {
    mockApi.get.mockResolvedValue({ connection: { id: "conn-1", uid: "acme" }, grants: null });
    const res = await toolsApi.listConnectionGrants("conn-1");
    expect(res).toEqual([]);
  });

  it("returns [] for a completely malformed response", async () => {
    mockApi.get.mockResolvedValue(null);
    const res = await toolsApi.listConnectionGrants("conn-1");
    expect(res).toEqual([]);
  });
});
