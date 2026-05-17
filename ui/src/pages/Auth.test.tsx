// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockProceed = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("@/features/auth/adapters/unauthenticated-login.adapter", () => ({
  isUnauthenticatedDevelopmentLoginAvailable: () => true,
  unauthenticatedLoginAdapter: {
    proceed: mockProceed,
  },
}));

vi.mock("@/components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AuthPage unauthenticated action", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockAuthApi.getSession.mockResolvedValue(null);
    mockProceed.mockResolvedValue(undefined);
    root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthPage />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not trigger unauthenticated mode on page load", () => {
    expect(container.textContent).toContain("Sign in to Paperclip");
    expect(mockProceed).not.toHaveBeenCalled();
  });

  it("opens a warning modal and only proceeds after confirmation", async () => {
    const proceedButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Proceed without login");
    expect(proceedButton).not.toBeUndefined();

    await act(async () => {
      proceedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Continue without login?");
    expect(mockProceed).not.toHaveBeenCalled();

    const cancelButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel");
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).not.toContain("Continue without login?");
    expect(mockProceed).not.toHaveBeenCalled();

    await act(async () => {
      proceedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const confirmButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Continue without login");
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockProceed).toHaveBeenCalledWith({ nextPath: "/" });
  });
});
