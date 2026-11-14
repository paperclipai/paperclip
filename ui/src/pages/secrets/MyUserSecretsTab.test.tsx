// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyUserSecretsTab } from "./MyUserSecretsTab";
import { ApiError } from "../../api/client";
import type { MyUserSecretEntry } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";

const mockSecretsApi = vi.hoisted(() => ({
  listMyUserSecrets: vi.fn(),
  removeMyUserSecret: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// The overflow menu is a Radix portal; render it inline so its items are reachable in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function definition(overrides: Partial<UserSecretDefinition> = {}): UserSecretDefinition {
  return {
    id: "def-1",
    companyId: "c1",
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    description: "Used for private repo access",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mySecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "secret-1",
    status: "active",
    latestVersion: 1,
    lastRotatedAt: null,
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
    ...overrides,
  } as CompanySecret;
}

function rows() {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="my-secret-"]'));
}

function buttonIn(scope: ParentNode, label: string) {
  return Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

const transientError = () =>
  new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });

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

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

function render() {
  root = createRoot(container);
  return act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MyUserSecretsTab companyId="c1" />
      </QueryClientProvider>,
    );
  });
}

describe("MyUserSecretsTab", () => {
  it("keeps loaded secrets visible when a refetch fails during an outage", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: null }];
    mockSecretsApi.listMyUserSecrets.mockResolvedValue(entries);

    await render();
    await flushReact();
    expect(container.textContent).toContain("Personal GitHub token");

    mockSecretsApi.listMyUserSecrets.mockRejectedValue(transientError());
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets("c1") });
    });
    await flushReact();

    expect(mockSecretsApi.listMyUserSecrets).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
  });

  it("shows readable copy and a Retry button when the list fails to load", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: null }];
    mockSecretsApi.listMyUserSecrets
      .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
      .mockResolvedValue(entries);

    await render();
    await waitForReact(() => container.querySelector('[data-query-view="error"]') !== null);

    const errorState = container.querySelector('[data-query-view="error"]');
    expect(errorState?.textContent).toContain("Couldn't load your secrets");
    expect(errorState?.textContent).toContain("Boom");
    expect(container.textContent).not.toContain("Nothing is asked of you yet");
    const retryButton = Array.from(errorState?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retryButton).toBeTruthy();

    await act(() => retryButton!.click());
    await waitForReact(() => container.textContent?.includes("Personal GitHub token") ?? false);

    expect(mockSecretsApi.listMyUserSecrets).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  });

  it("says in plain words that nothing is asked yet when no secrets are defined", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([]);

    await render();
    await flushReact();

    expect(container.textContent).toContain("Values only you provide. Agents use them when they work for you.");
    expect(container.textContent).toContain(
      "Nothing is asked of you yet. An admin decides which secrets each member provides.",
    );
    expect(container.textContent).not.toContain("your value.");
    expect(rows()).toHaveLength(0);
  });

  it("sorts secrets that still need a value first and counts them in the lead", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([
      { definition: definition({ id: "def-added", name: "Added token" }), secret: mySecret() },
      { definition: definition({ id: "def-off", name: "Retired token", status: "disabled" }), secret: null },
      { definition: definition({ id: "def-missing-1", name: "Missing token" }), secret: null },
      { definition: definition({ id: "def-missing-2", name: "Another missing token" }), secret: null },
    ] satisfies MyUserSecretEntry[]);

    await render();
    await flushReact();

    expect(rows().map((row) => row.dataset.testid)).toEqual([
      "my-secret-def-missing-1",
      "my-secret-def-missing-2",
      "my-secret-def-added",
      "my-secret-def-off",
    ]);
    expect(container.textContent).toContain("2 still need your value.");
  });

  it("uses the singular lead when one secret needs a value", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: definition(), secret: null }]);

    await render();
    await flushReact();

    expect(container.textContent).toContain("1 still needs your value.");
  });

  it("shows the name, the key agents refer to and guidance, but no always-true status", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([
      {
        definition: definition({ usageGuidance: "Create it under Settings → Developer settings." }),
        secret: mySecret(),
      },
    ]);

    await render();
    await flushReact();

    const [row] = rows();
    expect(row.textContent).toContain("Personal GitHub token");
    expect(row.textContent).toContain("Used for private repo access");
    expect(row.textContent).toContain("Create it under Settings → Developer settings.");
    expect(row.textContent).toContain("Added 3d ago");
    expect(row.querySelector("code")?.textContent).toBe("PERSONAL_GH_TOKEN");
    expect(row.textContent).not.toMatch(/Active|Value set|local_encrypted/);
    expect(buttonIn(row, "Replace")).toBeDefined();
    expect(buttonIn(row, "Set value")).toBeUndefined();
  });

  it("explains a turned-off secret and offers no way to add a value", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([
      { definition: definition({ id: "def-off", status: "disabled" }), secret: null },
      { definition: definition({ id: "def-off-with-value", status: "disabled" }), secret: mySecret() },
    ]);

    await render();
    await flushReact();

    const [withoutValue, withValue] = rows();
    expect(withoutValue.textContent).toContain("Agents won't ask for it.");
    expect(withoutValue.querySelectorAll("button")).toHaveLength(0);
    expect(buttonIn(withValue, "Replace")).toBeUndefined();
    expect(buttonIn(withValue, "Remove your value")).toBeDefined();
    expect(container.textContent).not.toContain("your value.");
  });

  it("adds a value through the dialog for a secret that needs one", async () => {
    const def = definition();
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: def, secret: null }]);
    mockSecretsApi.createMyUserSecret.mockResolvedValue(mySecret());

    await render();
    await flushReact();
    await act(() => buttonIn(rows()[0], "Set value")!.click());
    await flushReact();

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Set your value for Personal GitHub token");
    expect(dialog.textContent).toContain("Encrypted when saved. After that it can be replaced, never viewed.");
    const save = buttonIn(dialog, "Save value")!;
    expect(save.disabled).toBe(true);

    await act(() => setTextareaValue(dialog.querySelector("textarea")!, "  ghp_example  "));
    await flushReact();
    expect(save.disabled).toBe(false);
    await act(() => save.click());
    await waitForReact(() => mockPushToast.mock.calls.length > 0);

    expect(mockSecretsApi.createMyUserSecret).toHaveBeenCalledWith("c1", {
      definitionId: "def-1",
      definitionKey: "PERSONAL_GH_TOKEN",
      value: "ghp_example",
    });
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Your value was saved", tone: "success" }),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("replaces an existing value in place", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: definition(), secret: mySecret() }]);
    mockSecretsApi.rotateMyUserSecret.mockResolvedValue(mySecret({ latestVersion: 2 }));

    await render();
    await flushReact();
    await act(() => buttonIn(rows()[0], "Replace")!.click());
    await flushReact();

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Replace your value for Personal GitHub token");
    await act(() => setTextareaValue(dialog.querySelector("textarea")!, "ghp_new"));
    await flushReact();
    await act(() => buttonIn(dialog, "Replace value")!.click());
    await waitForReact(() => mockPushToast.mock.calls.length > 0);

    expect(mockSecretsApi.rotateMyUserSecret).toHaveBeenCalledWith("c1", "secret-1", { value: "ghp_new" });
    expect(mockSecretsApi.createMyUserSecret).not.toHaveBeenCalled();
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Your value was replaced", tone: "success" }),
    );
  });

  it("hides the typed value until Show value is pressed", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: definition(), secret: null }]);

    await render();
    await flushReact();
    await act(() => buttonIn(rows()[0], "Set value")!.click());
    await flushReact();

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    const toggle = dialog.querySelector('button[aria-label="Show value"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(() => toggle.click());
    expect(dialog.querySelector('button[aria-label="Hide value"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("removes a value from the row's overflow menu and refreshes the list", async () => {
    const def = definition();
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: def, secret: mySecret() }]);
    mockSecretsApi.removeMyUserSecret.mockResolvedValue(undefined);

    await render();
    await flushReact();
    expect(rows()[0].querySelector('button[aria-label="More actions for Personal GitHub token"]')).not.toBeNull();

    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: def, secret: null }]);
    await act(() => buttonIn(rows()[0], "Remove your value")!.click());
    await waitForReact(() => buttonIn(container, "Set value") !== undefined);

    expect(mockSecretsApi.removeMyUserSecret).toHaveBeenCalledWith("c1", "secret-1");
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Your value was removed", tone: "info" });
  });

  it("says what went wrong when a value cannot be removed", async () => {
    mockSecretsApi.listMyUserSecrets.mockResolvedValue([{ definition: definition(), secret: mySecret() }]);
    mockSecretsApi.removeMyUserSecret.mockRejectedValue(new ApiError("Boom", 500, { error: "Boom" }));

    await render();
    await flushReact();
    await act(() => buttonIn(rows()[0], "Remove your value")!.click());
    await waitForReact(() => mockPushToast.mock.calls.length > 0);

    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't remove your value", tone: "error" }),
    );
    expect(buttonIn(rows()[0], "Replace")).toBeDefined();
  });
});
