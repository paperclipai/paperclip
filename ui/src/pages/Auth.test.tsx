// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
}));

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("../components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div>ASCII art</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderAuthPage(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthPage />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();

  return root;
}

describe("AuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue(null);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      features: {
        authDisableSignUp: false,
      },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the create-account path when sign-up is enabled", async () => {
    const root = await renderAuthPage(container);

    expect(container.textContent).toContain("Need an account?");
    expect(container.textContent).toContain("Create one");

    await act(async () => {
      root.unmount();
    });
  });

  it("hides the create-account path when sign-up is disabled", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      features: {
        authDisableSignUp: true,
      },
    });

    const root = await renderAuthPage(container);

    expect(container.textContent).toContain("Sign in to Paperclip");
    expect(container.textContent).not.toContain("Need an account?");
    expect(container.textContent).not.toContain("Create one");
    expect(container.textContent).not.toContain("Create your Paperclip account");

    await act(async () => {
      root.unmount();
    });
  });
});
