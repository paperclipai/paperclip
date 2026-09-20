// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEndpoint, ChatProvider } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatSetupSidebarProvider } from "@/context/ChatSetupSidebarContext";
import { ChatSetupSidebar } from "@/components/chat/ChatSetupNavigation";
import { ChatEndpointSetup } from "./ChatEndpointSetup";
import { ChatEndpointDetail } from "./ChatEndpointDetail";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  tab: "access",
  listActivityPage: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setup: vi.fn(),
  setupTestStatus: vi.fn(),
  finishSlackSetup: vi.fn(),
  generateSetupSecret: vi.fn(),
  listPrincipals: vi.fn(),
  createLinkIntent: vi.fn(),
  confirmIdentityLink: vi.fn(),
  pushToast: vi.fn(),
  setBreadcrumbs: vi.fn(),
  search: "",
  setParams: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: mocks }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "owner-user", name: "Owner" } }) } }));
vi.mock("@/api/health", () => ({ healthApi: { get: async () => ({ deploymentMode: "authenticated" }) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableIsolatedWorkspaces: true }) } }));
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
  useParams: () => ({ endpointId: "endpoint-a", tab: mocks.tab }),
  useSearchParams: () => [new URLSearchParams(mocks.search), mocks.setParams],
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

  beforeEach(() => {
    mocks.tab = "access";
    mocks.listActivityPage.mockReset();
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
    mocks.setupTestStatus.mockResolvedValue({ messageReceivedAt: null });
    mocks.finishSlackSetup.mockResolvedValue({ id: "endpoint-a", status: "active" });
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
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
    Reflect.deleteProperty(document, "execCommand");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  async function settle() {
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  async function click(text: string) {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(button, text).toBeDefined();
    flushSync(() => button!.click());
    await settle();
  }
  async function render(provider: ChatProvider, detail = false, publicHttps = true) {
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
        webhookUrl: publicHttps ? "https://example.test/api/chat-webhooks/test" : null,
        webhookSecretConfigured: false,
      },
    };
    mocks.get.mockResolvedValue(endpoint);
    mocks.search = `provider=${provider}&purpose=chat&resume=endpoint-a`;
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          {detail ? <ChatEndpointDetail /> : (
            <TooltipProvider>
            <ChatSetupSidebarProvider>
              <ChatSetupSidebar />
              <main><ChatEndpointSetup /></main>
            </ChatSetupSidebarProvider>
            </TooltipProvider>
          )}
        </QueryClientProvider>,
      ),
    );
    await settle();
    return endpoint;
  }

  it("pages older activity and lets users return after a page fails", async () => {
    mocks.tab = "activity";
    const item = (id: string) => ({ id, kind: "delivery", status: "processed", summary: id, createdAt: "2026-01-01T00:00:00Z" });
    mocks.listActivityPage.mockImplementation(async (_id, cursor) => cursor
      ? { items: [item("Older message")], nextCursor: null }
      : { items: [item("Newest message")], nextCursor: "older-cursor" });
    await render("slack", true);
    expect(container.textContent).toContain("Newest message");
    await click("Next");
    expect(mocks.listActivityPage).toHaveBeenLastCalledWith("endpoint-a", "older-cursor");
    expect(container.textContent).toContain("Older message");
    expect(container.textContent).toContain("Page 2");
    await click("Previous");
    expect(container.textContent).toContain("Newest message");
    client.removeQueries({ queryKey: [...queryKeys.chatEndpoints.activity("endpoint-a"), "older-cursor"] });
    mocks.listActivityPage.mockRejectedValue(new Error("Offline"));
    await click("Next");
    expect(container.textContent).toContain("Connection activity could not be loaded");
    await click("Previous");
    expect(container.textContent).toContain("Page 1");
  });

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
      if (provider === "slack") await click("View Slack App Manifest");
      const expected = document.querySelector("textarea")!.value;
      await click(
        provider === "slack" ? "Copy manifest" : "Copy manifest settings",
      );
      expect(copied).toEqual([expected]);
      expect(writeText).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        provider === "slack" ? "Manifest copied" : "Manifest settings copied",
      );
    },
  );

  it("keeps the Slack manifest in a modal and generates the creation link from saved edits", async () => {
    const endpoint = await render("slack");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    const edited = { appName: 'Research & "Ops"', botName: "research-ops", command: "/research" };
    mocks.update.mockImplementation(async (_id, input) => ({
      ...endpoint,
      setup: { ...endpoint.setup, slackApp: input.slackApp, command: input.slackApp.command },
    }));
    for (const [label, value] of [
      ["Slack app name", edited.appName],
      ["Bot display name", edited.botName],
      ["Slash command", edited.command],
    ]) {
      const fieldLabel = [...container.querySelectorAll("label")].find((node) => node.textContent === label)!;
      const input = document.getElementById(fieldLabel.htmlFor) as HTMLInputElement;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      flushSync(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      await settle();
    }
    expect(mocks.update).toHaveBeenLastCalledWith("endpoint-a", { slackApp: edited });
    await click("View Slack App Manifest");
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    expect(document.querySelector("textarea")!.readOnly).toBe(true);
    const manifest = document.querySelector("textarea")!.value;
    expect(manifest).toContain(`name: ${JSON.stringify(edited.appName)}`);
    expect(manifest).toContain(`display_name: "research-ops"`);
    expect(manifest).toContain(`command: "/research"`);
    await click("Copy manifest");
    expect(copied).toEqual([manifest]);
    await click("Close");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers();
    const createButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create Slack app")!;
    flushSync(() => createButton.click());
    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(url.searchParams.get("manifest_yaml")).toBe(manifest);
    expect(open.mock.calls[0].slice(1)).toEqual(["_blank", "noopener,noreferrer"]);
    expect(container.querySelector("h1")?.textContent).toBe("Create a Slack app");
    expect(createButton.disabled).toBe(true);
    flushSync(() => createButton.click());
    expect(open).toHaveBeenCalledTimes(1);
    flushSync(() => vi.advanceTimersByTime(999));
    expect(container.querySelector("h1")?.textContent).toBe("Create a Slack app");
    flushSync(() => vi.advanceTimersByTime(1));
    vi.useRealTimers();
    expect(container.querySelector("h1")?.textContent).toBe("Add Slack credentials");
    expect(document.querySelector("textarea")).toBeNull();
    const token = container.querySelector<HTMLInputElement>("#slack-bot-token")!;
    expect(token.closest("[hidden]")).toBeNull();
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(token, "synthetic-token");
      token.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mocks.setParams.mock.calls.at(-1)?.[0].get("stage")).toBe("credentials");
    await click("2Create Slack app");
    expect(container.querySelector("h1")?.textContent).toBe("Create a Slack app");
    expect(token.closest("[hidden]")).not.toBeNull();
    await click("View Slack App Manifest");
    expect(document.querySelector("textarea")!.value).toBe(manifest);
    await click("Close");
    await click("3Add credentials");
    expect(token.closest("[hidden]")).toBeNull();
    expect(token.value).toBe("synthetic-token");
    const finalStep = container.querySelectorAll("aside button")[4] as HTMLButtonElement;
    expect(finalStep.disabled).toBe(true);

  });


  it.each(["xapp-", "xoxb-", "xoxp-"])("warns about a %s token in the Slack signing secret field and clears after correction", async (prefix) => {
    await render("slack");
    await click("I already created the app");
    const inputFor = (name: string) => document.getElementById([...container.querySelectorAll("label")]
      .find((label) => label.textContent === name)!.htmlFor) as HTMLInputElement;
    const setValue = (input: HTMLInputElement, value: string) => flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const signingSecret = inputFor("Signing Secret");
    const connect = [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect Slack app")!;
    setValue(inputFor("Bot User OAuth Token"), "xoxb-synthetic-token");
    setValue(signingSecret, `  ${prefix}synthetic-private-token  `);
    expect(signingSecret.getAttribute("aria-invalid")).toBe("true");
    const warning = document.getElementById("slack-signing-secret-warning")!;
    expect(signingSecret.getAttribute("aria-describedby")?.split(" ")).toContain(warning.id);
    expect(warning.textContent).toContain("Signing Secret, NOT an app or bot token");
    expect(warning.textContent).not.toContain("synthetic-private-token");
    expect(connect.disabled).toBe(true);
    setValue(signingSecret, "synthetic-signing-secret");
    expect(document.getElementById("slack-signing-secret-warning")).toBeNull();
    expect(signingSecret.getAttribute("aria-invalid")).toBeNull();
    expect(connect.disabled).toBe(false);
    const botToken = inputFor("Bot User OAuth Token");
    for (const value of ["xapp-synthetic-token", "xoxp-synthetic-token", "not-a-bot-token"]) {
      setValue(botToken, value);
      expect(botToken.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById("slack-bot-token-warning")!.textContent).toContain("must start with xoxb-");
      expect(connect.disabled).toBe(true);
    }
    setValue(botToken, "  xoxb-synthetic-token  ");
    expect(document.getElementById("slack-bot-token-warning")).toBeNull();
    expect(connect.disabled).toBe(false);
    setValue(signingSecret, "");
    expect(connect.disabled).toBe(true);
    expect(container.querySelector("img")).toBeNull();
  });

  it("separates saved credentials, finishing Slack setup, and the message test", async () => {
    const endpoint = await render("slack");
    await click("I already created the app");
    const configured: ChatEndpoint = {
      ...endpoint,
      status: "verifying",
      providerAccountId: "workspace-a",
      botExternalId: "bot-a",
      setup: { ...endpoint.setup!, command: "/maya-test" },
    };
    mocks.get.mockResolvedValue(configured);
    mocks.setup.mockResolvedValueOnce(configured);
    for (const [id, value] of [["slack-bot-token", "xoxb-synthetic-token"], ["slack-signing-secret", "synthetic-secret"]]) {
      const input = document.getElementById(id)!;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await click("Connect Slack app");
    expect(container.querySelector("h1")?.textContent).toBe("Verify Slack connection");
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("4Verify Slack connection");
    await click("3Add credentials");
    expect(container.querySelector("h1")?.textContent).toBe("Add Slack credentials");
    expect(container.querySelector<HTMLInputElement>("#slack-bot-token")!.value).toBe("");
    await click("Continue");
    expect(container.querySelector("h1")?.textContent).toBe("Verify Slack connection");
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Continue")!.disabled).toBe(true);
    expect(container.querySelector("details")?.open).toBe(false);
    const verified = { ...configured, setup: { ...configured.setup, webhookVerifiedAt: new Date().toISOString() } };
    mocks.get.mockResolvedValue(verified);
    mocks.setup.mockResolvedValueOnce({ ...verified, setup: { ...verified.setup, step: "test" } });
    await client.invalidateQueries({ queryKey: ["chat-endpoint-slack-webhook-verification", endpoint.id] });
    await settle();
    expect(mocks.setup).toHaveBeenLastCalledWith(endpoint.id, { action: "verify", credentials: undefined });
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("5Connect your Slack account");
    expect(container.textContent).toContain("/maya-test connect");
    await click("4Verify Slack connection");
    expect(container.querySelector("h1")?.textContent).toBe("Verify Slack connection");
    expect(container.textContent).toContain("Slack verified your connection.");
    await click("Continue");
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("5Connect your Slack account");
    expect(mocks.setup).toHaveBeenCalledTimes(2);
    await click("3Add credentials");
    expect(container.querySelector("h1")?.textContent).toBe("Add Slack credentials");
  });

  it("skips verification when Slack has already verified the URL", async () => {
    const endpoint = await render("slack");
    const verified: ChatEndpoint = {
      ...endpoint, status: "verifying", providerAccountId: "workspace-a",
      setup: { ...endpoint.setup!, webhookVerifiedAt: new Date().toISOString() },
    };
    mocks.setup.mockResolvedValueOnce({ ...verified, setup: { ...verified.setup, step: "test" } });
    flushSync(() => client.setQueryData(["chat-endpoint-setup-resume", endpoint.id], verified));
    await settle();
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(mocks.setup).toHaveBeenCalledWith(endpoint.id, { action: "verify", credentials: undefined });
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("5Connect your Slack account");
  });

  it("picks up verification completed in another tab", async () => {
    const endpoint = await render("slack");
    const verified: ChatEndpoint = {
      ...endpoint, status: "verifying", providerAccountId: "workspace-a",
      setup: { ...endpoint.setup!, webhookVerifiedAt: new Date().toISOString() },
    };
    mocks.setup.mockRejectedValueOnce(new Error("Provider verification is not available at this setup step"));
    mocks.get.mockResolvedValue({ ...verified, setup: { ...verified.setup, step: "test" } });
    flushSync(() => client.setQueryData(["chat-endpoint-setup-resume", endpoint.id], verified));
    await settle();
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("5Connect your Slack account");
    expect(container.textContent).not.toContain("Connection failed");
  });

  it("allows retrying a failed automatic transition without looping", async () => {
    const endpoint = await render("slack");
    const verified: ChatEndpoint = {
      ...endpoint, status: "verifying", providerAccountId: "workspace-a",
      setup: { ...endpoint.setup!, webhookVerifiedAt: new Date().toISOString() },
    };
    mocks.setup.mockRejectedValueOnce(new Error("Connection interrupted"));
    flushSync(() => client.setQueryData(["chat-endpoint-setup-resume", endpoint.id], verified));
    await settle();
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Connection interrupted");
    mocks.setup.mockResolvedValueOnce({ ...verified, setup: { ...verified.setup, step: "test" } });
    await click("Continue");
    expect(mocks.setup).toHaveBeenCalledTimes(2);
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("5Connect your Slack account");
  });

  async function renderSlackIdentityStep() {
    const endpoint = await render("slack");
    flushSync(() => client.setQueryData(["chat-endpoint-setup-resume", endpoint.id], {
      ...endpoint, status: "verifying", providerAccountId: "workspace-a",
      setup: { ...endpoint.setup, step: "test", command: "/maya-test", testStartedAt: "2026-09-18T20:00:00Z" },
    }));
    await settle();
    return endpoint;
  }

  it("waits for a fresh connect command and links the selected identity inside the wizard", async () => {
    mocks.listPrincipals.mockResolvedValue([
      { id: "old", principalId: "old", externalLabel: "Old workspace member", status: "pending", lastConnectAt: "2026-09-17T20:00:00Z" },
      { id: "unrelated", principalId: "unrelated", externalLabel: "Other workspace member", status: "pending" },
    ]);
    await renderSlackIdentityStep();
    expect(container.textContent).toContain("/maya-test connect");
    expect(container.textContent).toContain("Waiting for your connect command");
    expect(container.textContent).not.toContain("Other workspace member");
    expect(container.textContent).not.toContain("Old workspace member");
    expect(mocks.createLinkIntent).not.toHaveBeenCalled();
    await click("Copy command");
    expect(copied).toContain("/maya-test connect");
    const identity = { id: "link-a", principalId: "principal-a", externalLabel: "My Slack identity", externalDetail: "@my-slack", status: "pending", lastConnectAt: "2026-09-18T20:01:00Z" };
    mocks.listPrincipals.mockResolvedValue([identity]);
    client.setQueryData(queryKeys.chatEndpoints.principals("endpoint-a"), [identity]);
    await settle();
    expect(container.textContent).toContain("My Slack identity");
    expect(container.textContent).toContain("Owner");
    expect(mocks.confirmIdentityLink).not.toHaveBeenCalled();
    mocks.confirmIdentityLink.mockImplementationOnce(async () => {
      mocks.listPrincipals.mockResolvedValue([{ ...identity, status: "linked", paperclipUserId: "owner-user" }]);
      return { ok: true };
    });
    await click("This is my Slack account");
    expect(mocks.createLinkIntent).toHaveBeenCalledWith("endpoint-a", "principal-a");
    expect(mocks.confirmIdentityLink).toHaveBeenCalledWith("synthetic-private-confirmation-token");
    expect(container.textContent).toContain("Linked to you");
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("5Connect your Slack account");
    await click("Continue to message test");
    expect(container.querySelector('aside button[aria-current="step"]')?.textContent).toBe("6Try it");
    expect(container.textContent).toContain("@Maya you there?");
    await click("Copy message");
    expect(copied).toContain("@Maya you there?");
    expect(container.textContent).not.toContain("Review identity access");
    expect(container.textContent).not.toContain("Complete this real conversation");
    expect(container.textContent).toContain("Continue the conversation in the thread.");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "I've sent the test message")!.disabled).toBe(false);
    mocks.finishSlackSetup.mockImplementationOnce(async () => ({
      ...client.getQueryData<ChatEndpoint>(["chat-endpoint-setup-resume", "endpoint-a"]),
      status: "active", setup: { step: "complete", command: "/maya-test" },
    }));
    await click("I've sent the test message");
    expect(mocks.finishSlackSetup).toHaveBeenCalledWith("endpoint-a");
    client.setQueryData(["chat-endpoint-setup-test-status", "endpoint-a"], { messageReceivedAt: "2026-09-18T20:02:00Z" });
    await settle();
    expect(container.textContent).toContain("Received your Slack message.");
    await click("5Connect your Slack account");
    expect([...container.querySelectorAll("h1")].find((heading) => !heading.closest("[hidden]"))?.textContent).toBe("Connect your Slack account");
    expect(container.textContent).toContain("Linked to you");
    await click("6Try it");
    expect([...container.querySelectorAll("h1")].find((heading) => !heading.closest("[hidden]"))?.textContent).toBe("Try Maya in Slack");
  });

  it("keeps failed identity linking in the wizard and allows retry", async () => {
    mocks.listPrincipals.mockResolvedValue([{ id: "link-a", principalId: "principal-a", externalLabel: "My Slack identity", status: "pending", lastConnectAt: "2026-09-18T20:01:00Z" }]);
    mocks.confirmIdentityLink.mockRejectedValueOnce(new Error("Expired"));
    await renderSlackIdentityStep();
    await click("This is my Slack account");
    expect(container.textContent).toContain("Couldn't link");
    expect(container.textContent).not.toContain("Continue to message test");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "This is my Slack account")!.disabled).toBe(false);
  });

  it("does not offer to claim a Slack identity linked to someone else", async () => {
    mocks.listPrincipals.mockResolvedValue([{ id: "link-a", principalId: "principal-a", externalLabel: "Someone else", status: "linked", paperclipUserId: "another-user", paperclipUserLabel: "Another Person", lastConnectAt: "2026-09-18T20:01:00Z" }]);
    await renderSlackIdentityStep();
    expect(container.textContent).toContain("Linked to Another Person");
    expect(container.textContent).not.toContain("This is my Slack account");
    expect(container.textContent).not.toContain("Continue to message test");
    expect(mocks.createLinkIntent).not.toHaveBeenCalled();
  });

  it("links the missing HTTPS warning to the setup guide", async () => {
    await render("slack", false, false);
    const warning = container.querySelector('[role="alert"]')!;
    expect(warning.textContent).toContain("Public HTTPS URL required");
    const link = warning.querySelector("a")!;
    expect(link.textContent).toBe("Learn how to set up HTTPS");
    expect(link.href).toBe("https://docs.paperclip.ing/reference/deploy/https/");
  });

  it("cancels the delayed Slack advance when returning to the agent step", async () => {
    await render("slack");
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers();
    const buttons = [...container.querySelectorAll("button")];
    flushSync(() => buttons.find((button) => button.textContent?.trim() === "Create Slack app")!.click());
    flushSync(() => buttons.find((button) => button.textContent?.trim() === "1Choose agent")!.click());
    flushSync(() => vi.advanceTimersByTime(1000));
    expect(container.querySelector('input[aria-label="Assigned agent"]')).not.toBeNull();
    expect(mocks.setParams).not.toHaveBeenCalled();
    vi.useRealTimers();
    await click("2Create Slack app");
    await click("I already created the app");
    expect(container.querySelector("h1")?.textContent).toBe("Add Slack credentials");
  });

  it.each(["slack", "github", "discord", "telegram", "microsoft-teams"] as const)(
    "lets %s setup revisit the agent without duplicating the connection or losing provider fields",
    async (provider) => {
      await render(provider);
      const nav = container.querySelector('aside nav[aria-label="Connection setup progress"]')!;
      expect(nav).not.toBeNull();
      expect(container.querySelector("main nav")).toBeNull();
      const steps = [...nav.querySelectorAll("button")];
      expect(steps[1].getAttribute("aria-current")).toBe("step");
      expect(steps[2].disabled).toBe(true);
      const fields = [...container.querySelectorAll("main input")];
      await click("1Choose agent");
      expect(container.querySelector('input[aria-label="Assigned agent"]')?.getAttribute("readonly")).not.toBeNull();
      expect(steps[0].getAttribute("aria-current")).toBe("step");
      expect(steps[1].disabled).toBe(false);
      await click("Continue");
      expect(steps[1].getAttribute("aria-current")).toBe("step");
      expect([...container.querySelectorAll("main input")]).toEqual(fields);
      expect(mocks.create).not.toHaveBeenCalled();
      await click("1Choose agent");
      await click(provider === "slack" ? "2Create Slack app" : "2Connect provider");
      expect(steps[1].getAttribute("aria-current")).toBe("step");
    },
  );

  it("copies the one-time webhook secret through the same fallback", async () => {
    await render("github");
    await click("Generate webhook secret");
    await click("Copy webhook secret");
    expect(copied).toEqual([secret]);
    expect(writeText).not.toHaveBeenCalled();
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

  // The toast provider drops an identical toast raised inside 3.5 seconds, so
  // a reader clicking twice against a blocked clipboard would see the failure
  // once and then nothing. The inline state has to answer every click.
  it("still shows a repeated copy failure the toast would have deduplicated", async () => {
    await render("github");
    await click("Generate webhook secret");
    execCommand.mockReturnValue(false);

    await click("Copy webhook secret");
    expect(container.textContent).toContain("Couldn’t copy");

    // Same failure again, well inside the dedupe window: the second toast is
    // suppressed, so the button itself is the only thing left to say so.
    const toastsAfterFirst = mocks.pushToast.mock.calls.length;
    await click("Couldn’t copy — select it manually");
    expect(container.textContent).toContain("Couldn’t copy");
    expect(container.textContent).not.toContain("Webhook secret copied");
    expect(mocks.pushToast.mock.calls.length).toBeGreaterThanOrEqual(
      toastsAfterFirst,
    );
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
