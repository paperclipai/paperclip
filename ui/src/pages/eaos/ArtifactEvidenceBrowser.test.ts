import { describe, expect, it } from "vitest";
import { __testing } from "./ArtifactEvidenceBrowser";
import type { SandboxLeaseReadModel } from "@/api/sandbox";

const { artifactRowsFromLease, artifactStatusTone } = __testing;

function lease(overrides: Partial<SandboxLeaseReadModel> = {}): SandboxLeaseReadModel {
  return {
    id: "lease-x",
    companyId: "c",
    environmentId: "e",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    status: "active",
    leasePolicy: "ephemeral",
    provider: "docker",
    providerLeaseId: "p1",
    kind: null,
    sandboxState: "running",
    capabilities: null,
    quotas: null,
    network: null,
    egressPreview: null,
    policyHash: null,
    artifacts: { present: true, count: 2 },
    truth: "backend-backed",
    providerEnabled: true,
    failureReason: null,
    cleanupStatus: "success",
    acquiredAt: "2026-05-17T00:00:00.000Z",
    lastUsedAt: "2026-05-17T00:00:00.000Z",
    expiresAt: "2026-05-17T01:00:00.000Z",
    releasedAt: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("artifactRowsFromLease", () => {
  it("returns no rows when no artifacts are present", () => {
    const rows = artifactRowsFromLease(lease({ artifacts: { present: false, count: 0 } }));
    expect(rows).toEqual([]);
  });

  it("emits a single redacted summary row when artifacts are present", () => {
    const rows = artifactRowsFromLease(lease());
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("lease-artifact");
    expect(row.title).toContain("(2)");
    expect(row.redacted).toBe(true);
    expect(row.sourceClass).toBe("backend-backed");
    expect(row.provenance).toBe("provider:docker");
    expect(row.expiry).toBe("2026-05-17T01:00:00.000Z");
  });

  it("classifies preview-truth leases as preview source even when artifacts present", () => {
    const rows = artifactRowsFromLease(lease({ truth: "preview" }));
    expect(rows[0].sourceClass).toBe("preview");
  });

  it("falls back to 'sandbox' provenance when provider key is missing", () => {
    const rows = artifactRowsFromLease(lease({ provider: null }));
    expect(rows[0].provenance).toBe("sandbox");
  });
});

describe("artifactStatusTone", () => {
  it("maps known good statuses to success", () => {
    expect(artifactStatusTone("active")).toBe("success");
    expect(artifactStatusTone("approved")).toBe("success");
    expect(artifactStatusTone("completed")).toBe("success");
  });

  it("maps failure statuses to danger", () => {
    expect(artifactStatusTone("failed")).toBe("danger");
    expect(artifactStatusTone("rejected")).toBe("danger");
  });

  it("maps unknown/empty to warn — never to success", () => {
    expect(artifactStatusTone("unknown")).toBe("warn");
    expect(artifactStatusTone("")).toBe("warn");
  });
});
