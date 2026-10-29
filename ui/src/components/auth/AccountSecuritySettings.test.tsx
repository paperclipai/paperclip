// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSecuritySettings } from "./AccountSecuritySettings";

const mockAuthApi = vi.hoisted(() => ({
  getAccountSecurity: vi.fn(),
  getSignInOptions: vi.fn(),
  enableTwoFactor: vi.fn(),
  verifyTotp: vi.fn(),
  disableTwoFactor: vi.fn(),
  regenerateBackupCodes: vi.fn(),
  listPasskeys: vi.fn(),
  addPasskey: vi.fn(),
  deletePasskey: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AAAA") },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TOTP_URI = "otpauth://totp/Paperclip:jane%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Paperclip";

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

describe("AccountSecuritySettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAuthApi.getAccountSecurity.mockResolvedValue({ twoFactorEnabled: false, hasPassword: true });
    mockAuthApi.getSignInOptions.mockResolvedValue({ passkeyOrigin: null });
    mockAuthApi.enableTwoFactor.mockResolvedValue({
      totpURI: TOTP_URI,
      backupCodes: ["aaaaa-bbbbb", "ccccc-ddddd"],
    });
    mockAuthApi.verifyTotp.mockResolvedValue(undefined);
    mockAuthApi.disableTwoFactor.mockResolvedValue(undefined);
    mockAuthApi.regenerateBackupCodes.mockResolvedValue(["eeeee-fffff"]);
    mockAuthApi.listPasskeys.mockResolvedValue([]);
    mockAuthApi.addPasskey.mockResolvedValue(undefined);
    mockAuthApi.deletePasskey.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AccountSecuritySettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("enrolls an authenticator app after password confirmation and a verified code", async () => {
    await mount();
    expect(container.textContent).toContain("Off");

    await act(async () => {
      findButton(container, "Set up authenticator app")!.click();
    });
    await act(async () => {
      setInputValue(container.querySelector('input[type="password"]') as HTMLInputElement, "supersecret");
    });
    await act(async () => {
      findButton(container, "Continue")!.click();
    });
    await flushReact();

    expect(mockAuthApi.enableTwoFactor).toHaveBeenCalledWith({ password: "supersecret" });
    expect(container.textContent).toContain("JBSWY3DPEHPK3PXP");
    expect(container.textContent).toContain("aaaaa-bbbbb");
    expect(container.querySelector('img[alt="Authenticator setup QR code"]')).not.toBeNull();

    mockAuthApi.getAccountSecurity.mockResolvedValue({ twoFactorEnabled: true, hasPassword: true });
    await act(async () => {
      setInputValue(container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement, " 123456 ");
    });
    await act(async () => {
      findButton(container, "Turn on two-factor")!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockAuthApi.verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: false });
    expect(container.textContent).toContain("On");
    expect(container.textContent).toContain("ccccc-ddddd");
    expect(findButton(container, "Turn off")).toBeDefined();
  });

  it("requires the password to turn two-factor off", async () => {
    mockAuthApi.getAccountSecurity.mockResolvedValue({ twoFactorEnabled: true, hasPassword: true });
    await mount();

    await act(async () => {
      findButton(container, "Turn off")!.click();
    });
    await act(async () => {
      setInputValue(container.querySelector('input[type="password"]') as HTMLInputElement, "supersecret");
    });
    mockAuthApi.getAccountSecurity.mockResolvedValue({ twoFactorEnabled: false, hasPassword: true });
    await act(async () => {
      findButton(container, "Turn off two-factor")!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockAuthApi.disableTwoFactor).toHaveBeenCalledWith({ password: "supersecret" });
    expect(findButton(container, "Set up authenticator app")).toBeDefined();
  });

  it("hides authenticator setup for an account that has no password", async () => {
    mockAuthApi.getAccountSecurity.mockResolvedValue({ twoFactorEnabled: false, hasPassword: false });
    await mount();

    expect(container.textContent).toContain("signs in without a password");
    expect(findButton(container, "Set up authenticator app")).toBeUndefined();
  });

  it("explains why passkeys are unavailable instead of offering them", async () => {
    await mount();

    expect(container.textContent).toContain("Passkeys are not available on this instance");
    expect(findButton(container, "Add a passkey")).toBeUndefined();
    expect(mockAuthApi.listPasskeys).not.toHaveBeenCalled();
  });

  it("points to the relying-party origin when this page is on another hostname", async () => {
    mockAuthApi.getSignInOptions.mockResolvedValue({ passkeyOrigin: "https://paperclip.example.com" });
    await mount();

    expect(container.textContent).toContain("Passkeys work only at");
    expect(container.querySelector('a[href="https://paperclip.example.com"]')).not.toBeNull();
    expect(findButton(container, "Add a passkey")).toBeUndefined();
    expect(mockAuthApi.listPasskeys).not.toHaveBeenCalled();
  });

  it("lists, adds, and removes passkeys when the instance supports them", async () => {
    mockAuthApi.getSignInOptions.mockResolvedValue({ passkeyOrigin: window.location.origin });
    mockAuthApi.listPasskeys.mockResolvedValue([
      { id: "pk-1", name: "Work laptop", deviceType: "multiDevice", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);
    await mount();

    expect(container.textContent).toContain("Work laptop");

    await act(async () => {
      findButton(container, "Add a passkey")!.click();
    });
    await act(async () => {
      setInputValue(container.querySelector('input[placeholder="Work laptop"]') as HTMLInputElement, "Phone");
    });
    await act(async () => {
      findButton(container, "Create passkey")!.click();
    });
    await flushReact();
    expect(mockAuthApi.addPasskey).toHaveBeenCalledWith({ name: "Phone" });

    await act(async () => {
      (container.querySelector('button[aria-label="Remove Work laptop"]') as HTMLButtonElement).click();
    });
    await flushReact();
    expect(mockAuthApi.deletePasskey).toHaveBeenCalledWith("pk-1");
  });

  it("shows a readable message when the browser cancels the passkey prompt", async () => {
    mockAuthApi.getSignInOptions.mockResolvedValue({ passkeyOrigin: window.location.origin });
    const cancelled = new Error("The operation either timed out or was not allowed.");
    cancelled.name = "NotAllowedError";
    mockAuthApi.addPasskey.mockRejectedValue(cancelled);
    await mount();

    await act(async () => {
      findButton(container, "Add a passkey")!.click();
    });
    await act(async () => {
      findButton(container, "Create passkey")!.click();
    });
    await flushReact();

    expect(mockAuthApi.addPasskey).toHaveBeenCalledWith({ name: "Passkey" });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The passkey request was cancelled or timed out.",
    );
  });
});
