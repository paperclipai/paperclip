// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeAssetNamespace } from "@paperclipai/shared";
import { ProfileSettings } from "./ProfileSettings";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
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
      },
    });
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

  it("localizes only the empty-name placeholder while preserving and submitting the user's draft", async () => {
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const session = { session: { id: "raw-session", userId: "raw-user" }, user: { id: "raw-user", name: "", email: "raw@example.test", image: null } };
    client.setQueryData(queryKeys.auth.session, session);
    client.setQueryData(queryKeys.agents.list("company-1"), []);
    client.setQueryData(queryKeys.inboxAgentPolicy.mine("company-1"), { mode: "disabled", allowedAgentIds: [] });
    try {
      await act(async () => { await i18n.changeLanguage("en"); root.render(<QueryClientProvider client={client}><ProfileSettings /></QueryClientProvider>); });
      const input = container.querySelector<HTMLInputElement>("#profile-name")!;
      const email = container.querySelector<HTMLInputElement>("#profile-email")!;
      expect(input.value).toBe("");
      expect(input.placeholder).toBe("Board");
      await act(async () => { await i18n.changeLanguage("ru"); });
      expect(input.placeholder).toBe("Руководство");
      expect(input.value).toBe("");
      const draft = "Board — customer-owned name";
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, draft);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      for (const [locale, placeholder] of [["en", "Board"], ["ru", "Руководство"], ["en", "Board"]] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(container.querySelector("#profile-name")).toBe(input);
        expect(input.placeholder).toBe(placeholder);
        expect(input.value).toBe(draft);
        expect(email.value).toBe("raw@example.test");
        expect(client.getQueryData(queryKeys.auth.session)).toEqual(session);
        expect(mockAuthApi.updateProfile).not.toHaveBeenCalled();
        expect(mockAssetsApi.uploadImage).not.toHaveBeenCalled();
      }
      await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(mockAuthApi.updateProfile).toHaveBeenCalledExactlyOnceWith({ name: draft, image: null });
    } finally {
      await act(async () => root.unmount()); client.clear(); await i18n.changeLanguage("en");
    }
  });
});
