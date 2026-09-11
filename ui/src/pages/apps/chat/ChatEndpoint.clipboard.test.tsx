// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEndpoint, ChatProvider } from "@/api/chatEndpoints";
import { ChatEndpointSetup } from "./ChatEndpointSetup";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { i18n } from "@/i18n";
import { chatUiErrorMessage, type ChatUiError } from "./chat-copy";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  generateSetupSecret: vi.fn(),
  listPrincipals: vi.fn(),
  createLinkIntent: vi.fn(),
  pushToast: vi.fn(),
  setBreadcrumbs: vi.fn(),
  search: "",
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: mocks }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-a" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mocks.pushToast }),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));
vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ endpointId: "endpoint-a", tab: "access" }),
  useSearchParams: () => [new URLSearchParams(mocks.search)],
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  Navigate: () => null,
}));

describe("chat setup and identity-link clipboard actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let copied: string[];
  let writeText: ReturnType<typeof vi.fn>;
  let execCommand: ReturnType<typeof vi.fn>;
  const secret = "synthetic-one-time-webhook-secret";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    copied = [];
    writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("isSecureContext", false);
    execCommand = vi.fn(() => {
      copied.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    mocks.generateSetupSecret.mockResolvedValue({ webhookSecret: secret });
    mocks.listPrincipals.mockResolvedValue([
      {
        id: "link-a",
        principalId: "principal-a",
        externalLabel: "Test person",
        status: "pending",
      },
    ]);
    mocks.createLinkIntent.mockResolvedValue({
      confirmationUrl:
        "/chat-identity/confirm?token=synthetic-private-confirmation-token",
    });
  });
  afterEach(async () => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    Reflect.deleteProperty(document, "execCommand");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });
  async function settle() {
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(button, text).toBeDefined();
    flushSync(() => button!.click());
    await settle();
  }
  async function render(provider: ChatProvider, detail = false) {
    const endpoint: ChatEndpoint = {
      id: "endpoint-a",
      companyId: "company-a",
      provider,
      status: "draft",
      assignedAgentId: "agent-a",
      assignedAgentName: "Maya",
      allowUnlinkedPeople: false,
      setup: {
        step: "provider_setup",
        webhookUrl: "https://example.test/api/chat-webhooks/test",
        webhookSecretConfigured: false,
      },
    };
    mocks.get.mockResolvedValue(endpoint);
    mocks.search = `provider=${provider}&purpose=chat&resume=endpoint-a`;
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          {detail ? <ChatEndpointDetail /> : <ChatEndpointSetup />}
        </QueryClientProvider>,
      ),
    );
    await settle();
  }

  it.each(["slack", "microsoft-teams"] as const)(
    "copies the %s manifest via the insecure-context fallback",
    async (provider) => {
      await render(provider);
      if (provider === "microsoft-teams") {
        const input = [...container.querySelectorAll("label")]
          .find((label) =>
            label.textContent?.includes("Application / Client ID"),
          )
          ?.querySelector("input");
        expect(input).toBeDefined();
        flushSync(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!.call(input, "11111111-1111-4111-8111-111111111111");
          input!.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      const expected = container.querySelector("textarea")!.value;
      await click(
        provider === "slack" ? "Copy manifest" : "Copy manifest settings",
      );
      expect(copied).toEqual([expected]);
      expect(writeText).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        provider === "slack" ? "Manifest copied" : "Manifest settings copied",
      );
    },
  );

  it("copies the one-time webhook secret through the same fallback", async () => {
    await render("github");
    await click("Generate webhook secret");
    await click("Copy webhook secret");
    expect(copied).toEqual([secret]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("switches setup EN → RU → EN without changing credentials, manifests, links, or connection requests", async () => {
    await render("slack");
    const credential = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(credential, "synthetic-token-kept-in-form");
      credential.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const manifest = container.querySelector<HTMLTextAreaElement>("textarea")!;
    const manifestValue = manifest.value;
    const reads = mocks.get.mock.calls.length;
    const localError: ChatUiError = { key: "chatUi.privateKeyEmpty" };
    const diagnostic = "Provider response: DO_NOT_TRANSLATE 403";
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      await settle();
      expect(container.querySelector('input[type="password"]')).toBe(credential);
      expect(credential.value).toBe("synthetic-token-kept-in-form");
      expect(container.querySelector("textarea")).toBe(manifest);
      expect(manifest.value).toBe(manifestValue);
      expect(container.textContent).toContain(language === "ru" ? "Подключить приложение Slack" : "Connect a Slack app");
      expect(container.querySelector("h1")?.textContent).toContain("Slack");
      expect(mocks.get).toHaveBeenCalledTimes(reads);
      expect(mocks.generateSetupSecret).not.toHaveBeenCalled();
      expect(chatUiErrorMessage(localError)).toContain(language === "ru" ? "Файл пуст" : "That file is empty");
      expect(chatUiErrorMessage(diagnostic)).toBe(diagnostic);
      expect(mocks.setBreadcrumbs.mock.calls.at(-1)?.[0]?.[1]?.label).toBe(i18n.t("chatUi.chatEndpointSetup.connectChat"));
    }
  });

  it("reports a failed secret copy without exposing the secret or an unhandled rejection", async () => {
    await render("github");
    await click("Generate webhook secret");
    execCommand.mockReturnValue(false);
    await click("Copy webhook secret");
    expect(mocks.pushToast).toHaveBeenLastCalledWith({
      title: "Couldn't copy to clipboard",
      body: "Select and copy the value manually.",
      tone: "error",
    });
    expect(JSON.stringify(mocks.pushToast.mock.calls)).not.toContain(secret);
  });

  it("preserves Telegram command text inside localized provider instructions", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render("telegram");
    for (const language of ["en", "ru", "en"]) {
      await i18n.changeLanguage(language);
      await settle();
      const commands = [...container.querySelectorAll("code")].map((node) => node.textContent);
      expect(commands).toContain("/newbot");
      expect(commands).toContain("bot");
      expect(commands).toContain("/task@bot_username <request>");
      const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("BotFather"));
      expect(button).toBeDefined();
      flushSync(() => button!.click());
      expect(open).toHaveBeenLastCalledWith("https://t.me/BotFather", "_blank", "noopener,noreferrer");
    }
  });

  it("copies the private identity link with fallback and preserves success feedback", async () => {
    await render("slack", true);
    await click("Create private link");
    await click("Copy link");
    expect(copied).toEqual([
      new URL(
        "/chat-identity/confirm?token=synthetic-private-confirmation-token",
        window.location.origin,
      ).toString(),
    ]);
    expect(writeText).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenLastCalledWith({
      title: "Confirmation link copied",
      tone: "success",
    });
  });
});
