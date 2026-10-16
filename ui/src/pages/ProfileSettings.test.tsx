// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeAssetNamespace } from "@paperclipai/shared";
import { ProfileSettings } from "./ProfileSettings";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
  enableTotp: vi.fn(),
  verifyTotp: vi.fn(),
  disableTotp: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("ProfileSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
        twoFactorEnabled: false,
      },
    });
    mockAuthApi.enableTotp.mockResolvedValue({
      totpURI: "otpauth://totp/Paperclip:user-1?secret=ABC123DEF456",
      backupCodes: ["aaaa1111", "bbbb2222", "cccc3333"],
    });
    mockAuthApi.verifyTotp.mockResolvedValue({ status: true });
    mockAuthApi.disableTotp.mockResolvedValue({ status: true });
    mockAssetsApi.uploadImage.mockResolvedValue({
      assetId: "asset-1",
      contentPath: "/api/assets/asset-1/content",
    });
    mockAuthApi.updateProfile.mockImplementation(async (input: { name: string; image: string | null }) => ({
      id: "user-1",
      name: input.name,
      email: "jane@example.com",
      image: input.image,
    }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not render a keyboard shortcuts toggle because shortcuts are always enabled", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><ProfileSettings /></QueryClientProvider>);
    });
    await flushReact();
    expect(container.textContent).toContain("Jane Example");
    expect(container.textContent).not.toContain("Keyboard shortcuts");
    expect(container.querySelector('[aria-label="Toggle keyboard shortcuts"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("uploads a clicked avatar into Paperclip storage and persists the returned asset path", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Avatar image URL");

    const avatarInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(avatarInput).not.toBeNull();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    Object.defineProperty(avatarInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      avatarInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, "profiles/user-1");
    expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
      name: "Jane Example",
      image: "/api/assets/asset-1/content",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("uploads an avatar for a user id that comes from an identity provider", async () => {
    const userId = "oidc:example|jane.example@example.com";
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId },
      user: {
        id: userId,
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const avatarInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(avatarInput).not.toBeNull();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    Object.defineProperty(avatarInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      avatarInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const namespace = `profiles/${userId}`;
    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, namespace);
    // The namespace goes to the API without a change, so the avatar arrives
    // under the identity of the user.
    expect(sanitizeAssetNamespace(namespace)).toBe(namespace);
    expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
      name: "Jane Example",
      image: "/api/assets/asset-1/content",
    });

    await act(async () => {
      root.unmount();
    });
  });

  async function mount(twoFactorEnabled: boolean) {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
        twoFactorEnabled,
      },
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return { root, queryClient };
  }

  it("shows the disabled two-factor CTA when twoFactorEnabled is false", async () => {
    const { root } = await mount(false);
    expect(container.textContent).toContain("Two-factor authentication");
    expect(container.textContent).toContain("Enable two-factor");
    expect(container.textContent).not.toContain("Disable two-factor");
    await act(async () => {
      root.unmount();
    });
  });

  it("shows the enabled two-factor status and disable CTA when twoFactorEnabled is true", async () => {
    const { root } = await mount(true);
    expect(container.textContent).toContain("Two-factor is on");
    expect(container.textContent).toContain("Disable two-factor");
    expect(container.textContent).not.toContain("Enable two-factor");
    await act(async () => {
      root.unmount();
    });
  });

  it("completes the enroll flow: enable → show backup codes → verify TOTP", async () => {
    const { root } = await mount(false);

    // Click "Enable two-factor"
    const enableBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Enable two-factor"),
    );
    expect(enableBtn).not.toBeNull();
    await act(async () => {
      enableBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Enter password and continue
    const passwordInput = container.querySelector("#enroll2faPassword") as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        passwordInput,
        "correct-password",
      );
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const continueBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Continue") && !b.textContent?.includes("cancel"),
    );
    expect(continueBtn).not.toBeNull();
    await act(async () => {
      continueBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    // enableTotp was called with the password
    expect(mockAuthApi.enableTotp).toHaveBeenCalledWith("correct-password");

    // Backup codes are displayed
    expect(container.textContent).toContain("aaaa1111");
    expect(container.textContent).toContain("bbbb2222");
    expect(container.textContent).toContain("Backup codes are one-time use");

    // Enter TOTP code and verify
    const verifyInput = container.querySelector("#verify2faCode") as HTMLInputElement;
    expect(verifyInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        verifyInput,
        "123456",
      );
      verifyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const verifyBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Verify and enable"),
    );
    expect(verifyBtn).not.toBeNull();
    await act(async () => {
      verifyBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAuthApi.verifyTotp).toHaveBeenCalledWith("123456");
    await act(async () => {
      root.unmount();
    });
  });

  it("completes the disable flow: enter password → disable", async () => {
    const { root } = await mount(true);

    const disableBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Disable two-factor"),
    );
    expect(disableBtn).not.toBeNull();
    await act(async () => {
      disableBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const passwordInput = container.querySelector("#disable2faPassword") as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        passwordInput,
        "correct-password",
      );
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // After the state changes to "disable", the idle CTA is replaced by the
    // confirm button in the disable sub-state — there is only one button
    // with this text at any point in the DOM.
    const confirmButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Disable two-factor"),
    );
    expect(confirmButton).not.toBeNull();
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAuthApi.disableTotp).toHaveBeenCalledWith("correct-password");
    await act(async () => {
      root.unmount();
    });
  });
});
