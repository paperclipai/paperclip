// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Rt2EnterpriseRolloutOverview, Rt2ScimApplyRequest } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnterpriseRolloutPage } from "./EnterpriseRolloutPage";

const getRolloutMock = vi.hoisted(() => vi.fn());
const validateSsoMock = vi.hoisted(() => vi.fn());
const previewScimMock = vi.hoisted(() => vi.fn());
const applyScimMock = vi.hoisted(() => vi.fn());
const previewTemplateMock = vi.hoisted(() => vi.fn());
const applyTemplateMock = vi.hoisted(() => vi.fn());
const saveRolloutMock = vi.hoisted(() => vi.fn());

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../api/rt2-enterprise", () => ({
  rt2EnterpriseApi: {
    getRollout: (companyId: string) => getRolloutMock(companyId),
    saveRollout: (companyId: string, input: unknown) => saveRolloutMock(companyId, input),
    validateSso: (companyId: string, input: unknown) => validateSsoMock(companyId, input),
    previewScim: (companyId: string, input: unknown) => previewScimMock(companyId, input),
    applyScim: (companyId: string, input: Rt2ScimApplyRequest) => applyScimMock(companyId, input),
    previewTemplate: (companyId: string, templateId: string) => previewTemplateMock(companyId, templateId),
    applyTemplate: (companyId: string, templateId: string) => applyTemplateMock(companyId, templateId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function createOverview(): Rt2EnterpriseRolloutOverview {
  return {
    companyId: "company-1",
    ssoConnections: [],
    templates: [],
    tenantPolicy: null,
    bindingModes: [],
    evidence: {
      overallStatus: "partial",
      readyCount: 1,
      partialCount: 1,
      missingCount: 2,
      items: [
        {
          area: "sso",
          status: "ready",
          label: "SSO handshake",
          detail: "Last IdP callback evidence passed.",
          recordIds: ["sso-evidence-1"],
          warnings: [],
        },
        {
          area: "scim",
          status: "partial",
          label: "SCIM preview",
          detail: "Preview ready for operator apply.",
          recordIds: ["scim-preview-1"],
          warnings: ["Deactivate candidate requires approval."],
        },
      ],
    },
    ssoValidation: {
      evidenceId: "sso-evidence-1",
      provider: "microsoft",
      status: "warning",
      checkedAt: "2026-04-29T01:00:00.000Z",
      certificateExpiresAt: null,
      checks: [
        { key: "issuer", label: "Issuer URL", status: "pass", detail: "HTTPS issuer accepted." },
      ],
      callbackStateChecks: [
        { key: "callback-state", label: "Callback state", status: "pass", detail: "Callback state matches." },
      ],
      failureReasons: [
        { code: "metadata_missing", message: "Metadata URL was not provided.", field: "metadataUrl" },
      ],
      warnings: ["Metadata URL was not provided."],
    },
    scimPreview: {
      previewId: "scim-preview-1",
      previewFingerprint: "fingerprint-1",
      status: "warning",
      checkedAt: "2026-04-29T01:01:00.000Z",
      summary: { create: 0, update: 0, deactivate: 1, warnings: 1 },
      candidates: [
        {
          id: "user:deactivate:u-2",
          kind: "user",
          action: "deactivate",
          externalId: "u-2",
          label: "former@isens.local",
          reason: "Inactive source user.",
          warnings: ["Requires review."],
        },
      ],
      warnings: ["1 deactivate candidate(s) require operator approval before apply."],
    },
    readiness: {
      overallStatus: "warning",
      items: [
        {
          area: "sso",
          label: "SSO",
          status: "warning",
          detail: "SSO has persisted evidence with warnings.",
          checks: [{ key: "sso-evidence", label: "Evidence", status: "pass", detail: "sso-evidence-1" }],
          warnings: [],
        },
      ],
    },
    auditLog: [
      {
        id: "audit-1",
        action: "rt2.rollout.scim_applied",
        actorType: "system",
        actorId: "board-user",
        entityType: "rt2_enterprise_rollout",
        entityId: "scim-apply-1",
        createdAt: "2026-04-29T01:02:00.000Z",
        details: {
          evidenceId: "scim-apply-1",
          previewId: "scim-preview-1",
          status: "partial",
          rollbackCandidateCount: 1,
        },
      },
    ],
    recommendedDefaults: {
      ssoProvider: "microsoft",
      bindingMode: "authenticated",
      policyDefault: "operator_safe",
      templateCategory: "enterprise",
    },
  };
}

describe("EnterpriseRolloutPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getRolloutMock.mockResolvedValue(createOverview());
    previewTemplateMock.mockResolvedValue(null);
    applyScimMock.mockResolvedValue({
      evidenceId: "scim-apply-1",
      previewId: "scim-preview-1",
      previewFingerprint: "fingerprint-1",
      status: "partial",
      appliedAt: "2026-04-29T01:03:00.000Z",
      summary: { applied: 1, skipped: 0, failed: 1, rollbackCandidates: 1 },
      candidates: [
        {
          candidateId: "user:deactivate:u-2",
          kind: "user",
          action: "deactivate",
          externalId: "u-2",
          label: "former@isens.local",
          status: "applied",
          reason: "Candidate apply evidence recorded.",
        },
        {
          candidateId: "user:update:u-3",
          kind: "user",
          action: "update",
          externalId: "u-3",
          label: "bad@isens.local",
          status: "failed",
          reason: "User email is not a valid address.",
          failureReason: { code: "candidate_validation_failed", message: "User email is not a valid address." },
        },
      ],
      rollbackCandidates: [
        {
          candidateId: "user:deactivate:u-2",
          kind: "user",
          externalId: "u-2",
          action: "deactivate",
          priorState: { active: true },
          targetState: { active: false },
          reason: "Operator review.",
        },
      ],
      failureReasons: [{ code: "candidate_validation_failed", message: "User email is not a valid address." }],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders persisted SSO evidence, callback checks, SCIM preview IDs, and audit details", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EnterpriseRolloutPage />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("sso-evidence-1");
    expect(container.textContent).toContain("Callback state");
    expect(container.textContent).toContain("metadata_missing: Metadata URL was not provided.");
    expect(container.textContent).toContain("preview scim-preview-1");
    expect(container.textContent).toContain("fingerprint fingerprint-1");
    expect(container.textContent).toContain("rollback 1");

    await act(async () => {
      root.unmount();
    });
  });

  it("requires deactivate acknowledgement before applying selected SCIM candidates", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <EnterpriseRolloutPage />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const applyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("선택 SCIM 적용"),
    );
    expect(applyButton).toBeTruthy();
    expect(applyButton).toHaveProperty("disabled", true);

    const candidateCheckbox = container.querySelector('input[aria-label="select former@isens.local"]') as HTMLInputElement | null;
    expect(candidateCheckbox).toBeTruthy();
    await act(async () => {
      candidateCheckbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(applyButton).toHaveProperty("disabled", true);

    const acknowledgement = Array.from(container.querySelectorAll("input[type='checkbox']")).find(
      (input) => input.parentElement?.textContent?.includes("Deactivate 후보 적용 승인"),
    ) as HTMLInputElement | undefined;
    expect(acknowledgement).toBeTruthy();
    await act(async () => {
      acknowledgement!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(applyButton).toHaveProperty("disabled", false);

    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(applyScimMock).toHaveBeenCalledWith("company-1", {
      previewId: "scim-preview-1",
      previewFingerprint: "fingerprint-1",
      selectedCandidateIds: ["user:deactivate:u-2"],
      acknowledgeDeactivations: true,
    });
    expect(container.textContent).toContain("evidence scim-apply-1");
    expect(container.textContent).toContain("candidate_validation_failed: User email is not a valid address.");
    expect(container.textContent).toContain("user:deactivate:u-2");

    await act(async () => {
      root.unmount();
    });
  });
});
