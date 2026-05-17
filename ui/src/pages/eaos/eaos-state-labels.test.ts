import { describe, expect, it } from "vitest";
import {
  cleanupChipFor,
  displayRedactedValue,
  isRedactedValue,
  lifecycleChipFor,
  providerChipFor,
  REDACTED_DISPLAY,
  REDACTED_SENTINEL,
  truthToSourceClass,
} from "./eaos-state-labels";
import type { SandboxLeaseReadModel } from "@/api/sandbox";

function baseLease(overrides: Partial<SandboxLeaseReadModel> = {}): SandboxLeaseReadModel {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    status: "active",
    leasePolicy: "ephemeral",
    provider: "docker",
    providerLeaseId: "prov-1",
    kind: null,
    sandboxState: "running",
    capabilities: null,
    quotas: null,
    network: null,
    egressPreview: null,
    policyHash: null,
    artifacts: { present: false, count: 0 },
    truth: "backend-backed",
    providerEnabled: true,
    failureReason: null,
    cleanupStatus: null,
    acquiredAt: "2026-05-17T00:00:00.000Z",
    lastUsedAt: "2026-05-17T00:00:00.000Z",
    expiresAt: null,
    releasedAt: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("truthToSourceClass", () => {
  it("maps backend-backed to backend-backed", () => {
    expect(truthToSourceClass("backend-backed")).toBe("backend-backed");
  });

  it("maps derived to backend-derived", () => {
    expect(truthToSourceClass("derived")).toBe("backend-derived");
  });

  it("maps preview to preview", () => {
    expect(truthToSourceClass("preview")).toBe("preview");
  });

  it("treats missing truth as unknown — never as green", () => {
    expect(truthToSourceClass(null)).toBe("unknown");
    expect(truthToSourceClass(undefined)).toBe("unknown");
  });
});

describe("lifecycleChipFor", () => {
  it("prefers sandbox state when present", () => {
    const chip = lifecycleChipFor(baseLease({ sandboxState: "running" }));
    expect(chip.kind).toBe("sandbox-state");
    expect(chip.label).toBe("Running");
    expect(chip.tone).toBe("success");
  });

  it("falls back to lease status when sandbox state is null", () => {
    const chip = lifecycleChipFor(baseLease({ sandboxState: null, status: "released" }));
    expect(chip.kind).toBe("lease-status");
    expect(chip.label).toBe("Released");
  });

  it("uses danger tone for failed sandbox state", () => {
    const chip = lifecycleChipFor(baseLease({ sandboxState: "failed" }));
    expect(chip.tone).toBe("danger");
  });
});

describe("cleanupChipFor", () => {
  it("returns neutral when cleanupStatus is null", () => {
    const chip = cleanupChipFor(baseLease({ cleanupStatus: null }));
    expect(chip.label).toBe("No cleanup state");
    expect(chip.tone).toBe("neutral");
  });

  it("maps success cleanup to success tone", () => {
    const chip = cleanupChipFor(baseLease({ cleanupStatus: "success" }));
    expect(chip.tone).toBe("success");
    expect(chip.label).toBe("Cleanup complete");
  });

  it("maps failed to danger", () => {
    const chip = cleanupChipFor(baseLease({ cleanupStatus: "failed" }));
    expect(chip.tone).toBe("danger");
  });
});

describe("providerChipFor", () => {
  it("returns warn when provider key missing", () => {
    const chip = providerChipFor(null, false);
    expect(chip.label).toBe("No provider");
    expect(chip.tone).toBe("warn");
    expect(chip.previewOnly).toBe(true);
  });

  it("keeps previewOnly true even when provider flag is enabled", () => {
    const chip = providerChipFor("docker", true);
    expect(chip.enabled).toBe(true);
    expect(chip.previewOnly).toBe(true);
  });
});

describe("redaction helpers", () => {
  it("recognizes the backend [REDACTED] sentinel", () => {
    expect(isRedactedValue(REDACTED_SENTINEL)).toBe(true);
    expect(isRedactedValue("ok")).toBe(false);
    expect(isRedactedValue(null)).toBe(false);
  });

  it("displays redacted values as human copy", () => {
    expect(displayRedactedValue(REDACTED_SENTINEL)).toBe(REDACTED_DISPLAY);
    expect(displayRedactedValue("plain")).toBe("plain");
    expect(displayRedactedValue(null)).toBe("—");
  });
});
