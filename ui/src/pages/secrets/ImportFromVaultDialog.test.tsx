// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportCandidate,
  RemoteSecretImportPreviewResult,
  RemoteSecretImportResult,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";

const mockSecretsApi = vi.hoisted(() => ({
  remoteImportPreview: vi.fn(),
  remoteImport: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { ImportFromVaultDialog } from "./ImportFromVaultDialog";

const awsVault: CompanySecretProviderConfig = {
  id: "vault-aws",
  companyId: "company-1",
  provider: "aws_secrets_manager",
  displayName: "AWS production",
  status: "ready",
  isDefault: true,
  config: { region: "us-east-1" },
  healthStatus: null,
  healthCheckedAt: null,
  healthMessage: null,
  healthDetails: null,
  disabledAt: null,
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeCandidate(
  overrides: Partial<RemoteSecretImportCandidate> = {},
): RemoteSecretImportCandidate {
  return {
    externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/foo-AbCdEf",
    remoteName: "prod/foo",
    name: "prod/foo",
    key: "prod-foo",
    providerVersionRef: null,
    providerMetadata: { name: "prod/foo" },
    status: "ready",
    importable: true,
    conflicts: [],
    ...overrides,
  };
}

function makePreview(
  candidates: RemoteSecretImportCandidate[],
  nextToken: string | null = null,
): RemoteSecretImportPreviewResult {
  return {
    providerConfigId: awsVault.id,
    provider: "aws_secrets_manager",
    nextToken,
    candidates,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function flushDebounce() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  });
}

function findButton(predicate: (text: string) => boolean) {
  return Array.from(document.querySelectorAll("button")).find((btn) =>
    predicate(btn.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { queryClient };
}

describe("ImportFromVaultDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("loads candidates and selects rows, persisting through pagination", async () => {
    mockSecretsApi.remoteImportPreview
      .mockResolvedValueOnce(
        makePreview(
          [
            makeCandidate({
              externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/stripe-ABC",
              remoteName: "prod/stripe",
              name: "prod/stripe",
              key: "prod-stripe",
            }),
            makeCandidate({
              externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ",
              remoteName: "prod/openai",
              name: "prod/openai",
              key: "prod-openai",
            }),
          ],
          "page-2",
        ),
      )
      .mockResolvedValueOnce(
        makePreview(
          [
            makeCandidate({
              externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/sendgrid-Q9",
              remoteName: "prod/sendgrid",
              name: "prod/sendgrid",
              key: "prod-sendgrid",
            }),
          ],
          null,
        ),
      );

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const list = document.querySelector('[data-testid="vault-list"]');
    expect(list).not.toBeNull();
    expect(document.body.textContent).toContain("Import secrets from a vault");
    expect(document.body.textContent).toContain("Their values stay in your vault.");
    // One usable vault: no vault picker.
    expect(document.querySelector('[aria-label="Vault"]')).toBeNull();
    expect(document.body.textContent).toContain("prod/stripe");
    expect(document.body.textContent).toContain("prod/openai");

    // Select stripe via row click
    const stripeRow = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/stripe-ABC"]',
    ) as HTMLElement | null;
    expect(stripeRow).not.toBeNull();
    await act(async () => {
      stripeRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(findButton((text) => text === "Continue with 1")).toBeTruthy();

    // Load more page
    const loadMore = document.querySelector('[data-testid="vault-load-more"]') as HTMLButtonElement | null;
    expect(loadMore).not.toBeNull();
    await act(async () => {
      loadMore!.click();
    });
    await flush();
    await flush();

    expect(document.body.textContent).toContain("prod/sendgrid");
    // Selection persisted through pagination.
    expect(findButton((text) => text === "Continue with 1")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows secrets already in Paperclip as not selectable and explains conflicts", async () => {
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/sendgrid-Q9",
          remoteName: "prod/sendgrid",
          name: "prod/sendgrid",
          key: "prod-sendgrid",
          status: "duplicate",
          importable: false,
          conflicts: [
            { type: "exact_reference", message: "Already imported", existingSecretId: "secret-sg" },
          ],
        }),
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ",
          remoteName: "prod/openai",
          name: "prod/openai",
          key: "prod-openai",
          status: "conflict",
          importable: true,
          conflicts: [
            { type: "name", message: "Name already in use" },
          ],
        }),
      ]),
    );

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const duplicateRow = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/sendgrid-Q9"]',
    );
    expect(duplicateRow?.getAttribute("data-row-state")).toBe("duplicate");
    const duplicateCheckbox = duplicateRow?.querySelector(
      'button[role="checkbox"]',
    ) as HTMLButtonElement | null;
    expect(duplicateCheckbox?.getAttribute("data-disabled")).not.toBeNull();

    expect(duplicateRow?.textContent).toContain("Already in Paperclip");

    // Clicking the row does not select it either.
    await act(async () => {
      duplicateRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(findButton((text) => text === "Continue")).toBeTruthy();

    const conflictRow = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ"]',
    );
    expect(conflictRow?.getAttribute("data-row-state")).toBe("conflict");
    expect(conflictRow?.textContent).toContain("Name already in use");
    expect(conflictRow?.textContent).not.toContain("Already in Paperclip");
    // Raw references are never shown.
    expect(document.body.textContent).not.toContain("arn:aws");

    await act(async () => {
      root.unmount();
    });
  });

  it("blocks import when a review row collides with an existing Paperclip secret", async () => {
    const conflictCandidate = makeCandidate({
      externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ",
      remoteName: "prod/openai",
      name: "OPENAI_API_KEY",
      key: "openai_api_key",
      status: "conflict",
      conflicts: [{ type: "key", message: "Key already in use" }],
    });
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([conflictCandidate]),
    );

    const existing: CompanySecret[] = [
      {
        id: "secret-existing",
        companyId: "company-1",
        scope: "company",
        ownerUserId: null,
        userSecretDefinitionId: null,
        key: "openai_api_key",
        name: "OPENAI_API_KEY",
        provider: "aws_secrets_manager",
        status: "active",
        managedMode: "external_reference",
        externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:other-XYZ",
        providerConfigId: awsVault.id,
        providerMetadata: null,
        latestVersion: 1,
        description: null,
        lastResolvedAt: null,
        lastRotatedAt: null,
        deletedAt: null,
        createdByAgentId: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={existing}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    // Select the conflict row
    const row = document.querySelector(
      '[data-testid="vault-row-arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ"]',
    ) as HTMLElement | null;
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Continue to the naming step.
    const continueBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Continue"),
    );
    expect(continueBtn).toBeTruthy();
    await act(async () => {
      continueBtn!.click();
    });
    await flush();

    // Naming step: the error is shown under the row. The Import button stays
    // enabled, but pressing it explains what to fix instead of importing.
    expect(document.body.textContent).toContain("Name 1 secret");
    expect(document.body.textContent?.toLowerCase()).toContain("a paperclip secret already uses this");

    const importBtn = findButton((text) => text.startsWith("Import "));
    expect(importBtn).toBeTruthy();
    expect(importBtn?.disabled).toBe(false);
    expect(document.querySelector('[data-testid="import-blocked-message"]')).toBeNull();
    await click(importBtn);
    expect(mockSecretsApi.remoteImport).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="import-blocked-message"]')?.textContent,
    ).toContain("Fix the 1 secret marked above");

    await act(async () => {
      root.unmount();
    });
  });

  it("requires lowercase operator-entered keys during review", async () => {
    const externalRef = "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ";
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef,
          remoteName: "prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
        }),
      ]),
    );

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const row = document.querySelector(
      `[data-testid="vault-row-${externalRef}"]`,
    ) as HTMLElement | null;
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const continueBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Continue"),
    );
    await act(async () => {
      continueBtn!.click();
    });
    await flush();

    // Keys sit behind a disclosure until they are needed.
    expect(document.querySelector(`[data-testid="review-key-${externalRef}"]`)).toBeNull();
    await click(document.querySelector('[data-testid="review-details-toggle"]'));

    const keyInput = document.querySelector(
      `[data-testid="review-key-${externalRef}"]`,
    ) as HTMLInputElement | null;
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(keyInput, "MY_KEY");
      keyInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(document.body.textContent).toContain("lowercase letters");
    // The key field stays visible while it has a problem, even with the disclosure closed.
    await click(document.querySelector('[data-testid="review-details-toggle"]'));
    expect(document.querySelector(`[data-testid="review-key-${externalRef}"]`)).not.toBeNull();

    await click(findButton((text) => text.startsWith("Import ")));
    expect(mockSecretsApi.remoteImport).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="import-blocked-message"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("submits the operator-entered review description", async () => {
    const externalRef = "arn:aws:secretsmanager:us-east-1:1:secret:prod/openai-XYZ";
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef,
          remoteName: "prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
          providerMetadata: {
            description: "Raw AWS description should not seed the review field",
          },
        }),
      ]),
    );
    mockSecretsApi.remoteImport.mockResolvedValueOnce({
      providerConfigId: awsVault.id,
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [
        {
          externalRef,
          name: "OpenAI API key",
          key: "openai-api-key",
          status: "imported",
          reason: null,
          secretId: "secret-openai",
          conflicts: [],
        },
      ],
    });

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const row = document.querySelector(
      `[data-testid="vault-row-${externalRef}"]`,
    ) as HTMLElement | null;
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const continueBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Continue"),
    );
    await act(async () => {
      continueBtn!.click();
    });
    await flush();

    await click(document.querySelector('[data-testid="review-details-toggle"]'));
    const descriptionInput = document.querySelector(
      `[data-testid="review-description-${externalRef}"]`,
    ) as HTMLInputElement | null;
    expect(descriptionInput?.value).toBe("");
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(descriptionInput, "Operator-entered OpenAI key");
      descriptionInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const importBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.startsWith("Import "),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      importBtn!.click();
    });
    await flush();
    await flush();

    expect(mockSecretsApi.remoteImport).toHaveBeenCalledWith("company-1", {
      providerConfigId: awsVault.id,
      secrets: [
        expect.objectContaining({
          externalRef,
          description: "Operator-entered OpenAI key",
          providerMetadata: null,
        }),
      ],
    });

    // Everything imported: a short confirmation with one Done action.
    expect(document.body.textContent).toContain("1 secret imported");
    expect(
      document.querySelector(`[data-testid="result-row-${externalRef}"]`)?.getAttribute("data-row-status"),
    ).toBe("imported");
    expect(findButton((text) => text === "Done")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps failed secrets listed with their reason after a mixed import and retries only those", async () => {
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(
      makePreview([
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:a-AAA",
          remoteName: "alpha",
          name: "alpha",
          key: "alpha",
        }),
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:b-BBB",
          remoteName: "beta",
          name: "beta",
          key: "beta",
        }),
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:c-CCC",
          remoteName: "gamma",
          name: "gamma",
          key: "gamma",
        }),
      ]),
    );

    const result: RemoteSecretImportResult = {
      providerConfigId: awsVault.id,
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 1,
      errorCount: 1,
      results: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:a-AAA",
          name: "alpha",
          key: "alpha",
          status: "imported",
          reason: null,
          secretId: "secret-alpha",
          conflicts: [],
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:b-BBB",
          name: "beta",
          key: "beta",
          status: "skipped",
          reason: "exact reference already imported",
          secretId: null,
          conflicts: [
            { type: "exact_reference", message: "exact reference already imported" },
          ],
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:c-CCC",
          name: "gamma",
          key: "gamma",
          status: "error",
          reason: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
          secretId: null,
          conflicts: [],
        },
      ],
    };
    mockSecretsApi.remoteImport.mockResolvedValueOnce(result);

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    // Select all loaded
    const headerCheckbox = document.querySelector(
      '[data-testid="vault-select-all"]',
    ) as HTMLButtonElement | null;
    expect(headerCheckbox).toBeTruthy();
    await act(async () => {
      headerCheckbox!.click();
    });
    await flush();

    // Continue
    const continueBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Continue"),
    );
    await act(async () => {
      continueBtn!.click();
    });
    await flush();

    // Import
    const importBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent?.startsWith("Import "),
    ) as HTMLButtonElement | undefined;
    expect(importBtn).toBeTruthy();
    await act(async () => {
      importBtn!.click();
    });
    await flush();
    await flush();

    expect(mockSecretsApi.remoteImport).toHaveBeenCalledTimes(1);
    const summary = document.querySelector('[data-testid="result-summary"]');
    expect(summary?.textContent).toContain("1 imported.");
    expect(summary?.textContent).toContain("1 already in Paperclip.");
    expect(summary?.textContent).toContain("1 could not be linked and is listed below.");

    // Only the failure stays in the list, with its reason.
    const gammaRef = "arn:aws:secretsmanager:us-east-1:1:secret:c-CCC";
    expect(document.querySelectorAll('[data-testid^="review-row-"]').length).toBe(1);
    expect(
      document.querySelector(`[data-testid="review-failure-${gammaRef}"]`)?.textContent,
    ).toContain("AWS Secrets Manager denied the request");
    expect(document.body.textContent).not.toContain("AccessDeniedException");
    expect(document.body.textContent).not.toContain("123456789012");
    expect(document.body.textContent).not.toContain("arn:aws");

    // The finished rows are one click away, each with its own outcome.
    await click(document.querySelector('[data-testid="result-done-toggle"]'));
    expect(
      document
        .querySelector('[data-testid="result-row-arn:aws:secretsmanager:us-east-1:1:secret:a-AAA"]')
        ?.getAttribute("data-row-status"),
    ).toBe("imported");
    const skippedRow = document.querySelector(
      '[data-testid="result-row-arn:aws:secretsmanager:us-east-1:1:secret:b-BBB"]',
    );
    expect(skippedRow?.getAttribute("data-row-status")).toBe("skipped");
    expect(skippedRow?.textContent).toContain("exact reference already imported");

    // Footer: Close on the left, Try again on the right; closing needs no discard prompt.
    expect(findButton((text) => text === "Close")).toBeTruthy();
    expect(findButton((text) => text === "Back")).toBeUndefined();

    mockSecretsApi.remoteImport.mockResolvedValueOnce({
      providerConfigId: awsVault.id,
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [
        {
          externalRef: gammaRef,
          name: "gamma",
          key: "gamma",
          status: "imported",
          reason: null,
          secretId: "secret-gamma",
          conflicts: [],
        },
      ],
    } satisfies RemoteSecretImportResult);
    await click(findButton((text) => text === "Try again"));
    await flush();

    expect(mockSecretsApi.remoteImport).toHaveBeenCalledTimes(2);
    const retryInput = mockSecretsApi.remoteImport.mock.calls[1]?.[1];
    expect(retryInput.secrets.map((secret: { externalRef: string }) => secret.externalRef)).toEqual([
      gammaRef,
    ]);
    expect(document.body.textContent).toContain("2 secrets imported");
    expect(document.querySelectorAll('[data-testid^="result-row-"]').length).toBe(3);
    expect(findButton((text) => text === "Done")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an empty state when no AWS vault is configured", async () => {
    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[]}
            existingSecrets={[]}
            onManageVaults={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    const empty = document.querySelector('[data-testid="select-empty-vaults"]');
    expect(empty?.textContent).toContain("No vault is connected yet.");
    expect(findButton((text) => text === "Connect one in Vaults")).toBeTruthy();
    expect(findButton((text) => text.startsWith("Continue"))).toBeUndefined();
    expect(mockSecretsApi.remoteImportPreview).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a permission-error banner when AWS denies ListSecrets", async () => {
    const error = Object.assign(new Error("AccessDeniedException"), {
      name: "ApiError",
      status: 403,
      body: null,
    });
    mockSecretsApi.remoteImportPreview.mockRejectedValueOnce(error);

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const banner = document.querySelector('[data-testid="preview-error-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Paperclip couldn't load the secrets in this vault.");
    expect(findButton((text) => text === "Try again")).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders sanitized preview provider errors without raw AWS exception text", async () => {
    const onManageVaults = vi.fn();
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.remoteImportPreview.mockRejectedValueOnce(
      new ApiError(
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        403,
        { error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.", details: { code: "access_denied" } },
      ),
    );

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
            onManageVaults={onManageVaults}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const banner = document.querySelector('[data-testid="preview-error-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("AWS denied access. Paperclip's role can't list the secrets in this vault.");
    expect(banner?.textContent).toContain("secretsmanager:ListSecrets");
    await click(findButton((text) => text === "Fix it in Vaults"));
    expect(onManageVaults).toHaveBeenCalledTimes(1);
    // Nothing to continue with while the vault cannot be listed.
    expect(findButton((text) => text.startsWith("Continue"))).toBeUndefined();
    expect(banner?.textContent).not.toContain(rawProviderMessage);
    expect(banner?.textContent).not.toContain("arn:aws");
    expect(banner?.textContent).not.toContain("123456789012");

    await act(async () => {
      root.unmount();
    });
  });

  it("debounces search and uses the new query for the next preview", async () => {
    mockSecretsApi.remoteImportPreview
      .mockResolvedValueOnce(makePreview([makeCandidate()]))
      .mockResolvedValueOnce(makePreview([
        makeCandidate({
          externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:stripe-XYZ",
          remoteName: "stripe",
          name: "stripe",
          key: "stripe",
        }),
      ]));

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const search = document.querySelector('[data-testid="vault-search"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      search.focus();
      valueSetter?.call(search, "stripe");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushDebounce();
    await flush();

    expect(mockSecretsApi.remoteImportPreview).toHaveBeenCalledTimes(2);
    const lastCall = mockSecretsApi.remoteImportPreview.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ query: "stripe" });

    await act(async () => {
      root.unmount();
    });
  });

  it("explains why Continue does nothing when no secret is selected", async () => {
    mockSecretsApi.remoteImportPreview.mockResolvedValueOnce(makePreview([makeCandidate()]));

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={vi.fn()}
            companyId="company-1"
            providerConfigs={[awsVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    const continueBtn = findButton((text) => text === "Continue");
    expect(continueBtn?.disabled).toBe(false);
    await click(continueBtn);
    expect(
      document.querySelector('[data-testid="import-blocked-message"]')?.textContent,
    ).toBe("Select at least one secret to import.");
    expect(document.querySelector('[data-testid="vault-list"]')).not.toBeNull();

    // Picking a secret clears the message.
    await click(document.querySelector('[data-testid="vault-select-all"]'));
    expect(document.querySelector('[data-testid="import-blocked-message"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("offers a vault picker only when more than one vault is usable, and asks before discarding picks", async () => {
    mockSecretsApi.remoteImportPreview.mockResolvedValue(makePreview([makeCandidate()]));
    const secondVault: CompanySecretProviderConfig = {
      ...awsVault,
      id: "vault-aws-2",
      displayName: "AWS staging",
      isDefault: false,
    };
    const onOpenChange = vi.fn();

    const { queryClient } = makeWrapper();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ImportFromVaultDialog
            open
            onOpenChange={onOpenChange}
            companyId="company-1"
            providerConfigs={[awsVault, secondVault]}
            existingSecrets={[]}
          />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    expect(document.querySelector('[aria-label="Vault"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Secret in AWS production");

    await click(document.querySelector('[data-testid="vault-select-all"]'));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await click(findButton((text) => text === "Cancel"));
    expect(confirmSpy).toHaveBeenCalledWith("Discard 1 pending import?");
    expect(onOpenChange).not.toHaveBeenCalled();
    await click(findButton((text) => text === "Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    confirmSpy.mockRestore();

    await act(async () => {
      root.unmount();
    });
  });
});
