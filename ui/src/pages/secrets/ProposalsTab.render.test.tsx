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

function fieldByLabel<T extends HTMLElement = HTMLInputElement>(label: string): T | null {
  const host = [...document.querySelectorAll("label")].find((node) =>
    node.textContent?.trim().startsWith(label),
  );
  return (host?.querySelector("input, select") as T | null) ?? null;
}

/** Serve each status its own rows, the way the API does. */
function mockProposals(rows: SecretProposalView[]) {
  mockSecretsApi.listProposals.mockImplementation(async (_companyId: string, status = "pending") =>
    rows.filter((row) => row.status === status),
  );
}

let activeRoot: ReturnType<typeof createRoot> | null = null;
let activeContainer: HTMLDivElement | null = null;

async function renderTab(
  companyId = "company-1",
  configs: CompanySecretProviderConfig[] = providerConfigs as CompanySecretProviderConfig[],
) {
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
            providerConfigs={configs}
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
    mockProposals([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => document.body.textContent?.includes("dev/github/token") ?? false);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Nothing changes until you approve.");
    expect(text).toContain("ClaudeCoder wants to save a new secret, dev/github/token");
    expect(text).toContain("sha256:abcdef0123"); // fingerprint
    expect(text).toContain("40 bytes"); // length
    // Provenance: the task is named by its title and linked, not shown as a raw key.
    expect(text).toContain("While working on “UI review surface”");
    expect(text).not.toContain("PAP-14743");
    expect(document.querySelector('a[href="/issues/PAP-14743"]')).not.toBeNull();
    expect(text).toContain("Expires in");
    // Justification is framed as an untrusted, agent-authored claim (Q0 concern).
    expect(text).toContain("Reason given by the agent");
    expect(text).toContain("“Need the GitHub token to open the PR.”");
    // Never renders a raw secret value.
    expect(text).not.toContain("ghp_");
  });

  it("copies the full fingerprint for comparison", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockProposals([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    const chip = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("sha256:abcdef0123"),
    );
    await act(async () => chip?.click());
    await waitForReact(() => mockPushToast.mock.calls.length > 0);

    expect(writeText).toHaveBeenCalledWith("sha256:abcdef0123456789abcdef");
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Fingerprint copied", tone: "success" });
  });

  it("replaces the actions with a plain sentence when the viewer can't decide", async () => {
    mockProposals([
      makeSecretProposal({
        viewerCanApprove: false,
        approveBlockReason: "Company admin access required",
      }),
      makeBindingProposal({
        viewerCanApprove: false,
        approveBlockReason: "agent_config:update denied",
        secretProposalId: null,
        secretProposalName: null,
        secretId: "secret-1",
        secretName: "dev/github/token",
      }),
    ]);
    await renderTab();
    await waitForReact(() => document.body.textContent?.includes("dev/github/token") ?? false);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Only organization admins can approve or reject this.");
    expect(text).toContain(
      "Only people who can change DeployBot’s settings can approve or reject this.",
    );
    // The server's internal block reason is never shown.
    expect(text).not.toContain("agent_config:update");
    expect(findButton("Approve and save secret")).toBeUndefined();
    expect(findButton("Approve access")).toBeUndefined();
    expect(findButton("Reject")).toBeUndefined();
    expect(fieldByLabel("Name")?.disabled).toBe(true);
  });

  it("approves a new secret with an edited name and the default vault", async () => {
    mockProposals([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    const nameInput = fieldByLabel("Name");
    expect(nameInput?.value).toBe("dev/github/token");
    // One usable vault: nothing to choose, so no picker.
    expect(fieldByLabel("Stored in")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      if (nameInput) setInputValue(nameInput, " dev/github/client-secret/ ");
    });
    await flushReact();

    await act(async () => findButton("Approve and save secret")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal).toHaveBeenCalledWith("company-1", "prop-secret-1", {
      overrides: {
        name: "dev/github/client-secret",
        description: null,
        providerConfigId: "vault-local",
      },
    });
    await waitForReact(() => mockPushToast.mock.calls.length > 0);
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Secret approved", tone: "success" }),
    );
  });

  it("won't approve a new secret without a name", async () => {
    mockProposals([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    await act(async () => {
      const nameInput = fieldByLabel("Name");
      if (nameInput) setInputValue(nameInput, "  ");
    });
    await flushReact();

    expect(findButton("Approve and save secret")?.disabled).toBe(true);
  });

  it("lets the approver pick a vault and add a description", async () => {
    mockProposals([makeSecretProposal()]);
    await renderTab("company-1", [
      providerConfigs[0],
      { ...providerConfigs[0], id: "vault-team", displayName: "Team vault", isDefault: false },
    ] as CompanySecretProviderConfig[]);
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    const vault = fieldByLabel<HTMLSelectElement>("Stored in");
    expect(vault?.value).toBe("vault-local");
    expect([...(vault?.options ?? [])].map((option) => option.textContent)).toEqual([
      "Local default",
      "Team vault",
    ]);
    await act(async () => {
      if (vault) {
        vault.value = "vault-team";
        vault.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Description stays out of the way until asked for.
    expect(fieldByLabel("Description")).toBeNull();
    await act(async () => findButton("Add a description")?.click());
    await flushReact();
    await act(async () => {
      const description = fieldByLabel("Description");
      if (description) setInputValue(description, "Token for the release bot");
    });
    await flushReact();

    await act(async () => findButton("Approve and save secret")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal).toHaveBeenCalledWith("company-1", "prop-secret-1", {
      overrides: {
        name: "dev/github/token",
        description: "Token for the release bot",
        providerConfigId: "vault-team",
      },
    });
  });

  it("offers the only vault as a choice when it is not the default, so it can be picked", async () => {
    mockProposals([makeSecretProposal()]);
    await renderTab("company-1", [
      { ...providerConfigs[0], id: "vault-team", displayName: "Team vault", isDefault: false },
    ] as CompanySecretProviderConfig[]);
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    const vault = fieldByLabel<HTMLSelectElement>("Stored in");
    expect([...(vault?.options ?? [])].map((option) => [option.value, option.textContent])).toEqual([
      ["", "Paperclip"],
      ["vault-team", "Team vault"],
    ]);
    await act(async () => {
      if (vault) {
        vault.value = "vault-team";
        vault.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await act(async () => findButton("Approve and save secret")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal.mock.calls[0][2].overrides.providerConfigId).toBe("vault-team");
  });

  it("shows the agent's proposed description for review", async () => {
    mockProposals([makeSecretProposal({ proposedDescription: "CI token" })]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    expect(fieldByLabel("Description")?.value).toBe("CI token");
    await act(async () => findButton("Approve and save secret")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);
    expect(mockSecretsApi.approveProposal.mock.calls[0][2].overrides.description).toBe("CI token");
  });

  it("does not preselect a non-local default vault for secret approval", async () => {
    mockProposals([makeSecretProposal()]);
    await renderTab("company-1", [
      { ...providerConfigs[0], id: "vault-aws", provider: "aws_secrets_manager" },
      { ...providerConfigs[0], isDefault: false },
    ] as CompanySecretProviderConfig[]);
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    await act(async () => findButton("Approve and save secret")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal).toHaveBeenCalledWith("company-1", "prop-secret-1", {
      overrides: {
        name: "dev/github/token",
        description: null,
        providerConfigId: null,
      },
    });
  });

  it("approves access together with the new secret it depends on", async () => {
    mockProposals([makeBindingProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve access and save secret")));

    // Row says who gets what, how it is delivered, and that the secret is still new.
    const rowText = document.body.textContent ?? "";
    expect(rowText).toContain("ClaudeCoder wants DeployBot to use dev/github/token");
    expect(rowText).toContain("DeployBot’s runs as the environment variable GITHUB_TOKEN");
    expect(rowText).toContain("hasn’t been saved yet");
    expect(rowText).not.toContain("env.GITHUB_TOKEN");

    // Saving the secret is pre-checked because access can't be approved without it.
    const checkbox = document.querySelector(
      '[aria-label="Also save the new secret"]',
    ) as HTMLButtonElement | null;
    expect(checkbox?.getAttribute("aria-checked")).toBe("true");

    await act(async () => findButton("Approve access and save secret")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal).toHaveBeenCalledWith("company-1", "prop-binding-1", {
      cascade: true,
    });
  });

  it("approves access to an existing secret without a cascade", async () => {
    mockSecretsApi.approveProposal.mockResolvedValue(makeBindingProposal({ status: "approved" }));
    mockProposals([
      makeBindingProposal({
        secretProposalId: null,
        secretProposalName: null,
        secretId: "secret-1",
        secretName: "dev/stripe/key",
        target: { id: "agent-coder", name: "ClaudeCoder", icon: "code" },
        configPath: "access.STRIPE",
      }),
    ]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve access")));

    const rowText = document.body.textContent ?? "";
    expect(rowText).toContain("ClaudeCoder wants to use dev/stripe/key");
    expect(rowText).toContain("could ask for it during a run as STRIPE");
    expect(document.querySelector('[aria-label="Also save the new secret"]')).toBeNull();

    await act(async () => findButton("Approve access")?.click());
    await waitForReact(() => mockSecretsApi.approveProposal.mock.calls.length > 0);

    expect(mockSecretsApi.approveProposal.mock.calls[0]).toEqual([
      "company-1",
      "prop-binding-1",
      { cascade: undefined },
    ]);
    await waitForReact(() => mockPushToast.mock.calls.length > 0);
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Access approved" }),
    );
  });

  it("tells the approver which environment variable a new secret will be read as", async () => {
    mockProposals([makeSecretProposal(), makeBindingProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    expect(document.body.textContent).toContain("Agents given access will read it as GITHUB_TOKEN.");
    // New secrets are listed before the access requests that depend on them.
    const rows = [...document.querySelectorAll('[data-testid^="proposal-"]')].map((row) =>
      row.getAttribute("data-testid"),
    );
    expect(rows).toEqual(["proposal-prop-secret-1", "proposal-prop-binding-1"]);
  });

  it("requires a reason to reject, inline", async () => {
    mockProposals([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Reject")));

    await act(async () => findButton("Reject")?.click());
    await flushReact();

    // Rejecting happens in the row, not in a dialog.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const reason = () =>
      document.querySelector('[aria-label="Reason for rejecting"]') as HTMLInputElement | null;
    expect(reason()).not.toBeNull();
    expect(document.body.textContent).toContain("A reason is required. It is sent to ClaudeCoder.");
    expect(findButton("Approve and save secret")).toBeUndefined();

    // The confirm button is disabled until a reason is typed.
    expect(findButton("Reject")?.disabled).toBe(true);

    // Cancel returns to the approve/reject footer without calling the API.
    await act(async () => findButton("Cancel")?.click());
    await flushReact();
    expect(reason()).toBeNull();
    expect(findButton("Approve and save secret")).toBeDefined();
    await act(async () => findButton("Reject")?.click());
    await flushReact();

    await act(async () => {
      const input = reason();
      if (input) setInputValue(input, "  Not needed for this task. ");
    });
    await flushReact();

    expect(findButton("Reject")?.disabled).toBe(false);
    await act(async () => findButton("Reject")?.click());
    await waitForReact(() => mockSecretsApi.rejectProposal.mock.calls.length > 0);

    expect(mockSecretsApi.rejectProposal).toHaveBeenCalledWith("company-1", "prop-secret-1", {
      reason: "Not needed for this task.",
    });
    await waitForReact(() => mockPushToast.mock.calls.length > 0);
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Proposal rejected", tone: "info" }),
    );
  });

  it("shows a failed decision in the row and keeps the request open", async () => {
    mockSecretsApi.approveProposal.mockRejectedValue(new Error("A secret with this name already exists."));
    mockProposals([makeSecretProposal()]);
    await renderTab();
    await waitForReact(() => Boolean(findButton("Approve and save secret")));

    await act(async () => findButton("Approve and save secret")?.click());
    await waitForReact(() => Boolean(document.querySelector('[role="alert"]')));

    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(findButton("Approve and save secret")?.disabled).toBe(false);
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("shows the empty state when nothing is waiting or decided", async () => {
    mockProposals([]);
    await renderTab();
    await waitForReact(() => document.body.textContent?.includes("Nothing to review") ?? false);

    expect(document.body.textContent).toContain(
      "When an agent asks to save a secret or to use one, the request appears here.",
    );
  });

  it("lists recent decisions under the pending requests, newest first", async () => {
    mockProposals([
      makeSecretProposal({
        id: "done-approved",
        status: "approved",
        proposedName: "dev/slack/token",
        viewerCanApprove: false,
        resolvedByUserId: "user-raw-id-123",
        resolvedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      }),
      makeBindingProposal({
        id: "done-rejected",
        status: "rejected",
        viewerCanApprove: false,
        resolvedByUserId: "user-raw-id-123",
        resolvedAt: new Date(Date.now() - 3600_000).toISOString(),
        resolutionReason: "Use the shared connection.",
      }),
      makeSecretProposal({
        id: "done-expired",
        status: "expired",
        proposedName: "dev/old/key",
        viewerCanApprove: false,
        resolvedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
      }),
    ]);
    await renderTab();
    await waitForReact(() => document.body.textContent?.includes("Recently decided") ?? false);

    expect(mockSecretsApi.listProposals.mock.calls.map((call) => call[1]).sort()).toEqual([
      "approved",
      "expired",
      "pending",
      "rejected",
    ]);
    // Decided lists are asked for by decision time, so a fresh decision on an old request is in the page.
    expect(
      mockSecretsApi.listProposals.mock.calls.filter((call) => call[1] !== "pending").map((call) => call[2]),
    ).toEqual([
      { order: "resolved", limit: 10 },
      { order: "resolved", limit: 10 },
      { order: "resolved", limit: 10 },
    ]);
    expect(document.body.textContent).toContain("You’re caught up. No requests are waiting.");
    const decided = [
      ...document.querySelectorAll('section[aria-label="Recently decided"] li'),
    ].map((row) => row.textContent);
    expect(decided).toHaveLength(3);
    expect(decided[0]).toContain("ClaudeCoder wants DeployBot to use dev/github/token");
    expect(decided[0]).toContain("Rejected · 1h ago");
    expect(decided[1]).toContain("ClaudeCoder wants to save a new secret, dev/slack/token");
    expect(decided[1]).toContain("Approved · 2h ago");
    expect(decided[2]).toContain("Expired · 3d ago");
    // Decided rows are read-only and never show a raw user id.
    expect(document.body.textContent).not.toContain("user-raw-id-123");
    expect(findButton("Reject")).toBeUndefined();
  });
});
