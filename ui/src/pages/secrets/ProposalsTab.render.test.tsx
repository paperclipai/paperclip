// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySecretProviderConfig, SecretProposalView } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalsTab } from "./ProposalsTab";

const mockSecretsApi = vi.hoisted(() => ({
  listProposals: vi.fn(),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const providerConfigs = [
  {
    id: "vault-local",
    provider: "local_encrypted",
    displayName: "Local default",
    status: "ready",
    isDefault: true,
    healthStatus: "ready",
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
  },
] satisfies Partial<CompanySecretProviderConfig>[];

function makeSecretProposal(overrides: Partial<SecretProposalView> = {}): SecretProposalView {
  return {
    id: "prop-secret-1",
    companyId: "company-1",
    kind: "secret",
    status: "pending",
    justification: "Need the GitHub token to open the PR.",
    proposedName: "dev/github/token",
    proposedKey: "token",
    proposedDescription: null,
    valueFingerprintSha256: "abcdef0123456789abcdef",
    valueLength: 40,
    secretId: null,
    secretName: null,
    secretProposalId: null,
    secretProposalName: null,
    targetType: null,
    target: null,
    configPath: null,
    proposedBy: { id: "agent-coder", name: "ClaudeCoder", icon: "code" },
    originIssue: { id: "issue-1", key: "PAP-14743", title: "UI review surface" },
    originRunId: "run-1",
    expiresAt: new Date(Date.now() + 12 * 24 * 3600_000).toISOString(),
    createdAt: "2026-07-20T00:00:00.000Z",
    resolvedByUserId: null,
    resolvedAt: null,
    resolutionReason: null,
    createdSecretId: null,
    appliedBindingConfigPath: null,
    viewerCanApprove: true,
    approveBlockReason: null,
    ...overrides,
  };
}

function makeBindingProposal(overrides: Partial<SecretProposalView> = {}): SecretProposalView {
  return {
    ...makeSecretProposal(),
    id: "prop-binding-1",
    kind: "binding",
    justification: "Bind the token to the deployer agent.",
    proposedName: null,
    proposedKey: null,
    valueFingerprintSha256: null,
    valueLength: null,
    secretId: null,
    secretName: null,
    secretProposalId: "prop-secret-1",
    secretProposalName: "dev/github/token",
    targetType: "agent",
    target: { id: "agent-deployer", name: "DeployBot", icon: "rocket" },
    configPath: "env.GITHUB_TOKEN",
    ...overrides,
  };
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForReact(predicate: () => boolean, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushReact();
  }
  throw new Error("Timed out waiting for React state to settle");
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

let activeRoot: ReturnType<typeof createRoot> | null = null;
let activeContainer: HTMLDivElement | null = null;

async function renderTab(companyId = "company-1") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  activeContainer = container;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProposalsTab
            companyId={companyId}
            providerConfigs={providerConfigs as CompanySecretProviderConfig[]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return { container, root };
}

describe("ProposalsTab", () => {
  afterEach(async () => {
    // Unmount the React root first so Radix dialog portals clean themselves up
    // before the DOM is wiped (else jsdom throws NotFoundError on teardown).
    if (activeRoot) await act(async () => activeRoot!.unmount());
    activeContainer?.remove();
    activeRoot = null;
    activeContainer = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mockSecretsApi.approveProposal.mockResolvedValue(makeSecretProposal({ status: "approved" }));
    mockSecretsApi.rejectProposal.mockResolvedValue(makeSecretProposal({ status: "rejected" }));
  });

  it("shows a fingerprint and provenance but never the value", async () => {
    mockSecretsApi.listProposals.mockResolvedValue([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => document.body.textContent?.includes("dev/github/token") ?? false);

    const text = document.body.textContent ?? "";
    expect(text).toContain("token"); // folder-styled leaf
    expect(text).toContain("sha256:abcdef0123"); // fingerprint
    expect(text).toContain("40 bytes"); // length
    expect(text).toContain("ClaudeCoder"); // proposer
    expect(text).toContain("PAP-14743"); // origin issue
    // Never renders a raw secret value.
    expect(text).not.toContain("ghp_");
  });

  it("disables Approve with the authz explanation when the viewer can't approve", async () => {
    mockSecretsApi.listProposals.mockResolvedValue([
      makeSecretProposal({
        viewerCanApprove: false,
        approveBlockReason: "You need secrets write to approve this.",
      }),
    ]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve")));

    const approve = findButton("Approve");
    expect(approve?.disabled).toBe(true);
  });

  it("opens the secret confirm dialog with re-folder/rename and approves with overrides", async () => {
    mockSecretsApi.listProposals.mockResolvedValue([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve")));

    await act(async () => findButton("Approve")?.click());
    await flushReact();

    const nameInput = document.getElementById("approve-name") as HTMLInputElement | null;
    const folderInput = document.getElementById("approve-folder") as HTMLInputElement | null;
    expect(nameInput?.value).toBe("token");
    expect(folderInput?.value).toBe("dev/github");
    // Dialog restates the fingerprint, never a value.
    expect(document.body.textContent).toContain("sha256:abcdef0123");

    await act(async () => {
      if (nameInput) setInputValue(nameInput, "client-secret");
    });
    await flushReact();

    await act(async () => findButton("Approve & create")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal).toHaveBeenCalledWith("company-1", "prop-secret-1", {
      overrides: {
        name: "dev/github/client-secret",
        description: null,
        providerConfigId: "vault-local",
      },
    });
  });

  it("surfaces the cascade pairing and approves the binding with cascade", async () => {
    mockSecretsApi.listProposals.mockResolvedValue([makeBindingProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve")));

    // Row shows target, delivery + env key, and the pending-secret pill.
    const rowText = document.body.textContent ?? "";
    expect(rowText).toContain("DeployBot");
    expect(rowText).toContain("GITHUB_TOKEN");
    expect(rowText).toContain("Env var");
    expect(rowText).toContain("Proposed");

    await act(async () => findButton("Approve")?.click());
    await flushReact();
    // Cascade is pre-checked because the secret is still a pending proposal.
    await act(async () => findButton("Approve secret & bind")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal).toHaveBeenCalledWith("company-1", "prop-binding-1", {
      cascade: true,
    });
  });

  it("requires a reason to reject", async () => {
    mockSecretsApi.listProposals.mockResolvedValue([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Reject")));

    await act(async () => findButton("Reject")?.click());
    await flushReact();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const dialogReject = () =>
      [...(dialog?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Reject",
      ) as HTMLButtonElement | undefined;

    // The dialog's confirm button is disabled until a reason is typed.
    const reason = dialog?.querySelector("#reject-reason") as HTMLTextAreaElement | null;
    expect(reason).not.toBeNull();
    expect(dialogReject()?.disabled).toBe(true);

    await act(async () => {
      if (reason) setInputValue(reason, "Not needed for this task.");
    });
    await flushReact();

    expect(dialogReject()?.disabled).toBe(false);
    await act(async () => dialogReject()?.click());
    await waitForReact(() => mockSecretsApi.rejectProposal.mock.calls.length > 0);

    expect(mockSecretsApi.rejectProposal).toHaveBeenCalledWith("company-1", "prop-secret-1", {
      reason: "Not needed for this task.",
    });
  });
});
