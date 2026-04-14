// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteLandingPage } from "./InviteLanding";
import { I18nProvider } from "../context/I18nContext";
import { ThemeProvider } from "../context/ThemeContext";

const navigateMock = vi.fn();
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storage.delete(key);
  }),
};

const getInviteMock = vi.fn();
const acceptInviteMock = vi.fn();
const getSessionMock = vi.fn();
const getHealthMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
  useParams: () => ({ token: "invite-token" }),
  useNavigate: () => navigateMock,
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getInvite: (token: string) => getInviteMock(token),
    acceptInvite: (token: string, body: unknown) => acceptInviteMock(token, body),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("../api/health", () => ({
  healthApi: {
    get: () => getHealthMock(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderInvitePage(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  const root = createRoot(container);

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <InviteLandingPage />
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });

  return root;
}

describe("InviteLandingPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    storage.clear();
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    localStorage.setItem("paperclip.locale", "zh-CN");
    getSessionMock.mockResolvedValue({ userId: "user-1" });
    getHealthMock.mockResolvedValue({ deploymentMode: "authenticated" });
  });

  afterEach(() => {
    localStorage.removeItem("paperclip.locale");
    navigateMock.mockReset();
    getInviteMock.mockReset();
    acceptInviteMock.mockReset();
    getSessionMock.mockReset();
    getHealthMock.mockReset();
    container.remove();
  });

  it("renders zh-CN copy for the agent invite form", async () => {
    getInviteMock.mockResolvedValue({
      inviteType: "join_company",
      companyName: "Acme",
      allowedJoinTypes: "agent",
      expiresAt: "2026-04-15T10:00:00.000Z",
    });
    const root = renderInvitePage(container);

    await flush();
    await flush();

    expect(container.textContent).toContain("加入 Acme");
    expect(container.textContent).toContain("以智能体身份加入");
    expect(container.textContent).toContain("智能体名称");
    expect(container.textContent).toContain("适配器类型");
    expect(container.textContent).toContain("能力（可选）");
    expect(container.textContent).toContain("提交加入请求");
    expect(container.textContent).not.toContain("Agent name");
    expect(container.textContent).not.toContain("Adapter type");
    expect(container.textContent).not.toContain("Submit join request");

    act(() => {
      root.unmount();
    });
  });

  it("renders zh-CN copy after a human join request is submitted", async () => {
    getInviteMock.mockResolvedValue({
      inviteType: "join_company",
      companyName: "Acme",
      allowedJoinTypes: "human",
      expiresAt: "2026-04-15T10:00:00.000Z",
    });
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      claimSecret: "secret-123",
      claimApiKeyPath: "/api/claim",
      onboarding: {
        skill: {
          url: "/skill/bootstrap",
          installPath: "/tmp/skill",
        },
        textInstructions: {
          url: "/onboarding/text",
        },
      },
      diagnostics: [
        {
          code: "net-1",
          level: "warn",
          message: "Tunnel unavailable",
          hint: "Retry locally",
        },
      ],
    });

    const root = renderInvitePage(container);

    await flush();
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("提交加入请求"),
    );
    expect(submitButton).toBeDefined();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await flush();
    await flush();

    expect(container.textContent).toContain("加入请求已提交");
    expect(container.textContent).toContain("一次性领取密钥（请立即保存）");
    expect(container.textContent).toContain("Paperclip 技能引导");
    expect(container.textContent).toContain("面向智能体的引导文本");
    expect(container.textContent).toContain("连通性诊断");
    expect(container.textContent).toContain("请求 ID");
    expect(container.textContent).not.toContain("Join request submitted");
    expect(container.textContent).not.toContain("One-time claim secret");

    act(() => {
      root.unmount();
    });
  });
});
