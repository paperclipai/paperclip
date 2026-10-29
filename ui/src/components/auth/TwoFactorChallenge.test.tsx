// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwoFactorChallenge } from "./TwoFactorChallenge";

const mockAuthApi = vi.hoisted(() => ({
  verifyTotp: vi.fn(),
  verifyBackupCode: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

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
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === text);
}

describe("TwoFactorChallenge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAuthApi.verifyTotp.mockResolvedValue(undefined);
    mockAuthApi.verifyBackupCode.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function mount(onVerified: () => Promise<void>, onCancel = vi.fn(), onExpired = vi.fn()) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TwoFactorChallenge onVerified={onVerified} onCancel={onCancel} onExpired={onExpired} />
        </QueryClientProvider>,
      );
    });
  }

  async function submitCode(code: string) {
    await act(async () => {
      setInputValue(container.querySelector('input[name="code"]') as HTMLInputElement, code);
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
  }

  it("puts Back to sign in and Verify in one footer row, with the backup toggle apart", async () => {
    await mount(vi.fn().mockResolvedValue(undefined));

    const back = findButton(container, "Back to sign in")!;
    const verify = findButton(container, "Verify")!;
    const toggle = findButton(container, "Use a backup code")!;
    expect(back.parentElement).toBe(verify.parentElement);
    expect(back.compareDocumentPosition(verify) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.parentElement).not.toBe(verify.parentElement);
  });

  it("offers a retry, not another code, when finishing sign-in fails after verification", async () => {
    const onVerified = vi.fn()
      .mockRejectedValueOnce(new Error("Failed to load companies"))
      .mockResolvedValueOnce(undefined);
    await mount(onVerified);

    await submitCode("123 456");

    expect(mockAuthApi.verifyTotp).toHaveBeenCalledWith({ code: "123456", trustDevice: false });
    expect(container.querySelector('input[name="code"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Failed to load companies");

    await act(async () => {
      findButton(container, "Try again")!.click();
    });
    await flushReact();

    expect(onVerified).toHaveBeenCalledTimes(2);
    expect(mockAuthApi.verifyTotp).toHaveBeenCalledTimes(1);
  });

  it("sends the user back to the password step once the challenge cookie has expired", async () => {
    mockAuthApi.verifyTotp.mockRejectedValue(
      Object.assign(new Error("Invalid two factor cookie"), { code: "INVALID_TWO_FACTOR_COOKIE" }),
    );
    const onVerified = vi.fn();
    const onExpired = vi.fn();
    await mount(onVerified, vi.fn(), onExpired);

    await submitCode("123456");

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith("Your sign-in timed out. Enter your password again.");
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("sends the user back to the password step after too many wrong codes spend the challenge", async () => {
    mockAuthApi.verifyTotp.mockRejectedValue(
      Object.assign(new Error("Too many attempts. Please request a new code."), {
        code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
      }),
    );
    const onExpired = vi.fn();
    await mount(vi.fn(), vi.fn(), onExpired);

    await submitCode("000000");

    expect(onExpired).toHaveBeenCalledWith("Too many incorrect codes. Enter your password again.");
  });

  it("keeps the challenge open for a wrong code", async () => {
    mockAuthApi.verifyTotp.mockRejectedValue(
      Object.assign(new Error("Invalid code"), { code: "INVALID_CODE" }),
    );
    const onExpired = vi.fn();
    await mount(vi.fn(), vi.fn(), onExpired);

    await submitCode("000000");

    expect(onExpired).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid code");
  });
});
