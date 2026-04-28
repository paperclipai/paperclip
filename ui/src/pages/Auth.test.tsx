// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const getSessionMock = vi.hoisted(() => vi.fn());
const signInEmailMock = vi.hoisted(() => vi.fn());
const signUpEmailMock = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: (input: unknown) => signInEmailMock(input),
    signUpEmail: (input: unknown) => signUpEmailMock(input),
  },
}));

vi.mock("@/components/AsciiArtAnimation", () => ({
  AsciiArtAnimation: () => <div data-testid="ascii-art-animation" />,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AuthPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getSessionMock.mockResolvedValue(null);
    signInEmailMock.mockReset();
    signUpEmailMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("turns sign-in failures into actionable guidance", async () => {
    signInEmailMock.mockRejectedValue(
      Object.assign(new Error("Invalid email or password"), {
        code: "INVALID_EMAIL_OR_PASSWORD",
        status: 401,
      }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/auth"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/auth" element={<AuthPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();

    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");

    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "wrongpass");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "wrongpass",
    });
    expect(container.textContent).toContain(
      "That email and password did not match a Paperclip account. Check both fields, or create an account if you are new here.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("turns sign-up conflicts into actionable guidance", async () => {
    signUpEmailMock.mockRejectedValue(
      Object.assign(new Error("User already exists"), {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        status: 422,
      }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/auth"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/auth" element={<AuthPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();

    const createOneButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create one",
    );
    expect(createOneButton).not.toBeNull();

    await act(async () => {
      createOneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement | null;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();

    await act(async () => {
      inputValueSetter!.call(nameInput, "Jane Example");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(signUpEmailMock).toHaveBeenCalledWith({
      name: "Jane Example",
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(container.textContent).toContain("An account already exists for that email. Sign in instead.");

    await act(async () => {
      root.unmount();
    });
  });
});
