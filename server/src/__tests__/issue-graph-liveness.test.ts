import { describe, expect, it } from "vitest";
import {
  hasExplicitExternalServiceWakeExemption,
  type IssueLivenessIssueInput,
} from "../services/recovery/issue-graph-liveness.ts";

const NOW_ISO = "2099-07-30T04:00:00.000Z";
const ONE_HOUR_MS = 60 * 60 * 1000;

function buildIssue(overrides: Partial<IssueLivenessIssueInput> = {}): IssueLivenessIssueInput {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "FRA-1",
    title: "Test issue",
    status: "blocked",
    monitorNextCheckAt: new Date(Date.parse(NOW_ISO) + ONE_HOUR_MS).toISOString(),
    executionPolicy: null,
    executionState: {
      monitor: {
        kind: "external_service",
        status: "pending",
        nextCheckAt: new Date(Date.parse(NOW_ISO) + ONE_HOUR_MS).toISOString(),
        serviceName: "fra-23044-same-head-preflight",
        attemptCount: 1,
        maxAttempts: 3,
      },
    },
    ...overrides,
  };
}

describe("hasExplicitExternalServiceWakeExemption", () => {
  it("does not exempt non-external monitors", () => {
    const issue = buildIssue({
      executionState: {
        monitor: {
          kind: "manual",
          status: "pending",
          serviceName: "fra-23044-same-head-preflight",
        },
      },
    });

    expect(hasExplicitExternalServiceWakeExemption(issue)).toBe(false);
  });

  it("does not exempt descriptive-free external monitors", () => {
    const issue = buildIssue({
      executionState: {
        monitor: {
          kind: "external_service",
          status: "pending",
          serviceName: "   ",
          externalRef: null,
          notes: null,
        },
      },
    });

    expect(hasExplicitExternalServiceWakeExemption(issue)).toBe(false);
  });

  it("keeps a genuinely pending external monitor exempt", () => {
    const issue = buildIssue();
    expect(hasExplicitExternalServiceWakeExemption(issue)).toBe(true);
  });

  it("does not exempt a spent triggered monitor with no next check", () => {
    const issue = buildIssue({
      monitorNextCheckAt: null,
      executionState: {
        monitor: {
          kind: "external_service",
          status: "triggered",
          nextCheckAt: null,
          serviceName: "fra-23044-same-head-preflight",
          attemptCount: 2,
          maxAttempts: 3,
        },
      },
    });

    expect(hasExplicitExternalServiceWakeExemption(issue)).toBe(false);
  });

  it("does not exempt an explicitly cleared monitor", () => {
    const issue = buildIssue({
      executionState: {
        monitor: {
          kind: "external_service",
          status: "cleared",
          nextCheckAt: new Date(Date.parse(NOW_ISO) + ONE_HOUR_MS).toISOString(),
          clearedAt: NOW_ISO,
          clearReason: "manual_reset",
          serviceName: "fra-23044-same-head-preflight",
          attemptCount: 1,
          maxAttempts: 3,
        },
      },
    });

    expect(hasExplicitExternalServiceWakeExemption(issue)).toBe(false);
  });

  it("does not exempt a timed-out external monitor", () => {
    const issue = buildIssue({
      executionState: {
        monitor: {
          kind: "external_service",
          status: "pending",
          nextCheckAt: new Date(Date.parse(NOW_ISO) + ONE_HOUR_MS).toISOString(),
          timeoutAt: "2000-01-01T00:00:00.000Z",
          serviceName: "fra-23044-same-head-preflight",
          attemptCount: 1,
          maxAttempts: 3,
        },
      },
    });

    expect(hasExplicitExternalServiceWakeExemption(issue)).toBe(false);
  });
});
