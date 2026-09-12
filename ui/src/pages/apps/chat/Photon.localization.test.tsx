// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { i18n } from "@/i18n";
import { PhotonConnectStep } from "./PhotonConnectStep";
import { ChatEndpointSetup } from "./ChatEndpointSetup";
import { ChatEndpointDetail, connectionHealthPresentation } from "./ChatEndpointDetail";
import { photonBotLabel, photonHealthMessage, photonResourceType } from "./photon-copy";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), inspectPhoton: vi.fn(), setup: vi.fn(), update: vi.fn(), updateResources: vi.fn(),
  listPrincipals: vi.fn(), listResources: vi.fn(), listActivity: vi.fn(), listConversations: vi.fn(),
  copy: vi.fn(), setBreadcrumbs: vi.fn(), pushToast: vi.fn(),
  tab: "settings", search: "provider=imessage-photon&purpose=chat&resume=photon-endpoint",
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: mocks }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableIsolatedWorkspaces: false }) } }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-a" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.pushToast }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ endpointId: "photon-endpoint", tab: mocks.tab }),
  useSearchParams: () => [new URLSearchParams(mocks.search), vi.fn()],
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>, Navigate: () => null,
}));

const endpoint = (changes: Partial<ChatEndpoint> = {}): ChatEndpoint => ({
  id: "photon-endpoint", companyId: "company-a", provider: "imessage-photon", status: "draft",
  assignedAgentId: "agent-a", assignedAgentName: "Original agent name", allowUnlinkedPeople: false,
  setup: { step: "provider_setup" }, ...changes,
});

describe("Photon UI locale boundaries", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const projectId = "project-kept-verbatim";
  const projectName = "Users (DM only) — Original project";
  const projectSecret = "synthetic-Photon-secret+/=";
  const phoneNumber = "+15555550111";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mocks.tab = "settings";
    mocks.copy.mockResolvedValue(undefined);
    mocks.listPrincipals.mockResolvedValue([]);
    mocks.listResources.mockResolvedValue([]);
    mocks.listActivity.mockResolvedValue([]);
    mocks.listConversations.mockResolvedValue([]);
  });
  afterEach(async () => {
    flushSync(() => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });
  async function settle() {
    for (let n = 0; n < 6; n++) await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  async function render(node: ReactNode) {
    flushSync(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
    await settle();
  }
  async function language(locale: string) { await i18n.changeLanguage(locale); await settle(); }
  function inputValue(input: HTMLInputElement, value: string) {
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
    expect(button, text).toBeDefined(); expect(button!.disabled).toBe(false);
    flushSync(() => button!.click()); await settle();
  }
  async function connectForm() {
    const action = vi.fn();
    await render(<PhotonConnectStep endpoint={endpoint()} agentName="Original agent name" repairing={false} pending={false} onAction={action} />);
    const [projectInput, secretInput] = [...container.querySelectorAll("input")];
    inputValue(projectInput, ` ${projectId} `); inputValue(secretInput, projectSecret);
    await settle();
    return { action, projectInput, secretInput };
  }

  it.each(["en", "ru"])("uses a complete reconnect message when the dedicated number is absent (%s)", async (locale) => {
    const action = vi.fn();
    await language(locale);
    await render(<PhotonConnectStep endpoint={endpoint({ photonAllocation: "dedicated" })} agentName="Original agent name" repairing pending={false} onAction={action} />);
    expect(container.textContent).toContain(i18n.t("communityPhoton.repairDedicatedWithoutNumber"));
    expect(container.textContent).not.toContain("номер выделенный номер");
    expect(mocks.inspectPhoton).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it.each(["en", "ru"])("uses a complete test instruction when the dedicated destination is absent (%s)", async (locale) => {
    mocks.get.mockResolvedValue(endpoint({ status: "verifying", photonAllocation: "dedicated", setup: { step: "test" } }));
    await language(locale);
    await render(<ChatEndpointSetup />);
    expect(container.textContent).toContain(i18n.t("communityPhoton.tryDedicatedWithoutNumber"));
    expect(container.textContent).not.toContain("номер выделенный номер");
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("keeps credential drafts and inspected dedicated lines through EN → RU → EN without repeating requests", async () => {
    const inspection = { projectId, projectName, allocation: "dedicated", eligible: true, lines: [
      { lineId: "line-a", phoneNumber, eligible: true },
      { lineId: "line-b", phoneNumber: "+15555550222", eligible: false, unavailableReason: "This number already belongs to another channel" },
      { lineId: "line-c", phoneNumber: "+15555550333", eligible: false, unavailableReason: "Provider diagnostic — DO_NOT_TRANSLATE" },
    ] };
    const original = JSON.stringify(inspection);
    mocks.inspectPhoton.mockResolvedValue(inspection);
    const { action, projectInput, secretInput } = await connectForm();
    await language("ru");
    expect(container.querySelectorAll("input")[0]).toBe(projectInput);
    expect(secretInput.value).toBe(projectSecret);
    expect(mocks.inspectPhoton).not.toHaveBeenCalled();
    await click("Проверить проект Photon");
    expect(mocks.inspectPhoton).toHaveBeenCalledWith("photon-endpoint", { projectId, projectSecret });
    for (const locale of ["en", "ru", "en"]) {
      await language(locale);
      expect(projectInput.value).toBe(` ${projectId} `); expect(secretInput.value).toBe(projectSecret);
      expect(container.querySelector('input[value="line-a"]')?.getAttribute("name")).toBe("photon-line");
      expect((container.querySelector('input[value="line-a"]') as HTMLInputElement).checked).toBe(true);
      expect(container.textContent).toContain(projectName); expect(container.textContent).toContain(phoneNumber);
      expect(container.textContent).toContain(locale === "ru" ? "Этот номер уже используется другим каналом" : "This number already belongs to another channel");
      expect(container.textContent).toContain("Provider diagnostic — DO_NOT_TRANSLATE");
      expect(container.querySelector('a[href="https://app.photon.codes/"]')).not.toBeNull();
      expect(mocks.inspectPhoton).toHaveBeenCalledTimes(1); expect(action).not.toHaveBeenCalled();
      expect(JSON.stringify(inspection)).toBe(original);
    }
    await click("Connect selected number");
    expect(action).toHaveBeenCalledExactlyOnceWith("configure", { projectId, projectSecret, lineId: "line-a", allocation: "dedicated" });
  });

  it("retains shared allocation and requires both Photon enrollment and Paperclip linking", async () => {
    mocks.inspectPhoton.mockResolvedValue({ projectId, projectName, allocation: "shared", eligible: true, lines: [] });
    const { action } = await connectForm();
    await click("Inspect Photon project");
    await language("ru");
    expect(container.textContent).toContain("Отправителя также необходимо привязать к пользователю Paperclip");
    expect(container.textContent).toContain("Включить группы в этом канале нельзя");
    expect(container.textContent).toContain("Users");
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(mocks.inspectPhoton).toHaveBeenCalledTimes(1);
    await click("Подключить личные сообщения через общую линию");
    expect(action).toHaveBeenCalledExactlyOnceWith("configure", { projectId, projectSecret, allocation: "shared" });
  });

  it("submits unchanged Photon protocol fields after changing the setup language", async () => {
    mocks.get.mockResolvedValue(endpoint());
    mocks.inspectPhoton.mockResolvedValue({ projectId, projectName, allocation: "dedicated", eligible: true, lines: [{ lineId: "line-a", phoneNumber, eligible: true }] });
    mocks.setup.mockResolvedValue(endpoint({ status: "verifying", setup: { step: "test" } }));
    await render(<ChatEndpointSetup />);
    const [projectInput, secretInput] = [...container.querySelectorAll("input")];
    inputValue(projectInput, ` ${projectId} `); inputValue(secretInput, projectSecret);
    await settle(); await click("Inspect Photon project"); await language("ru");
    expect(mocks.setup).not.toHaveBeenCalled();
    await click("Подключить выбранный номер");
    expect(mocks.setup).toHaveBeenCalledExactlyOnceWith("photon-endpoint", {
      action: "configure", credentials: { projectSecret },
      photon: { allocation: "dedicated", projectId, lineId: "line-a" },
    });
    await language("en"); expect(mocks.setup).toHaveBeenCalledTimes(1);
  });

  it("preserves sanitized provider errors and translates only the local fallback without retrying", async () => {
    mocks.inspectPhoton.mockRejectedValueOnce(new Error(`Provider says DO_NOT_TRANSLATE ${projectSecret} ${encodeURIComponent(projectSecret)}`));
    await connectForm(); await click("Inspect Photon project");
    for (const locale of ["ru", "en"]) {
      await language(locale);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Provider says DO_NOT_TRANSLATE [redacted] [redacted]");
      expect(container.textContent).not.toContain(projectSecret); expect(mocks.inspectPhoton).toHaveBeenCalledTimes(1);
    }
    mocks.inspectPhoton.mockRejectedValueOnce({ unexpected: true });
    await click("Inspect Photon project"); await language("ru");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("chatUi.setupErrorFallback"));
    expect(mocks.inspectPhoton).toHaveBeenCalledTimes(2);
  });

  it("retranslates the identity warning, fresh-message instruction, and failed copy without replaying setup", async () => {
    mocks.get.mockResolvedValue(endpoint({ status: "verifying", photonAllocation: "dedicated", botUsername: phoneNumber, botExternalId: phoneNumber, setup: { step: "test" } }));
    mocks.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await render(<ChatEndpointSetup />);
    await click(`Copy ${phoneNumber}`);
    for (const locale of ["ru", "en"]) {
      await language(locale);
      expect(container.textContent).toContain(locale === "ru" ? "Привязать отправителя из «Сообщений»" : "Link your Messages identity");
      expect(container.textContent).toContain(locale === "ru" ? "прежние сообщения не запускают работу" : "earlier messages do not start work");
      expect(container.textContent).toContain(i18n.t("chatUi.freshConversation.imessage-photon"));
      expect(container.textContent).toContain(i18n.t("communityPhoton.copySetupFailed"));
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(phoneNumber);
      expect(mocks.setup).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("chatUi.freshConversation.");
    }
  });

  it("keeps copy success and raw participant names when locale changes", async () => {
    const record = endpoint({ status: "active", botExternalId: phoneNumber, photonAllocation: "dedicated", setup: { step: "complete" } });
    mocks.get.mockResolvedValue(record);
    mocks.listResources.mockResolvedValue([{ id: "group-a", type: "group_chat", label: "Original group", participants: ["Alice", "+15555550123"], availability: "available", enabled: false }]);
    await render(<ChatEndpointDetail />); await click("Copy number");
    for (const locale of ["ru", "en"]) {
      await language(locale);
      expect(container.textContent).toContain(i18n.t("communityPhoton.numberCopied"));
      expect(container.textContent).toContain(i18n.t("communityPhoton.settingsDedicated"));
      expect(container.textContent).toContain("Alice, +15555550123");
      expect(container.querySelector(`button[aria-label="${i18n.t("communityPhoton.copyDedicatedNumber")}"]`)).not.toBeNull();
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(phoneNumber);
      expect(mocks.setup).not.toHaveBeenCalled(); expect(mocks.updateResources).not.toHaveBeenCalled();
    }
  });

  it("keeps shared groups disabled and enrollment guidance visible in both languages", async () => {
    mocks.get.mockResolvedValue(endpoint({ status: "active", photonAllocation: "shared", setup: { step: "complete" } }));
    mocks.listResources.mockResolvedValue([{ id: "group-a", type: "group_chat", label: "Original group", availability: "available", enabled: false }]);
    await render(<ChatEndpointDetail />);
    for (const locale of ["ru", "en"]) {
      await language(locale);
      expect(container.textContent).toContain(i18n.t("communityPhoton.settingsShared"));
      const groupToggle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((button) => button.getAttribute("aria-label")?.includes("Original group"));
      expect(groupToggle?.disabled).toBe(true);
      expect(mocks.updateResources).not.toHaveBeenCalled(); expect(mocks.setup).not.toHaveBeenCalled();
    }
  });

  it("maps only exact first-party Photon labels and health copy without changing canonical data", async () => {
    const record = endpoint({ status: "active", photonAllocation: "shared", providerAccountLabel: projectName, botLabel: `${projectName} (DM only)`, healthMessage: "Photon receiver connected", lastError: "RAW provider error" });
    const original = JSON.stringify(record);
    for (const locale of ["en", "ru", "en"]) {
      await language(locale);
      expect(photonBotLabel(record)).toBe(i18n.t("communityPhoton.sharedBotLabel", { projectName }));
      expect(photonBotLabel({ ...record, botLabel: "Custom label (DM only)" })).toBe("Custom label (DM only)");
      expect(photonBotLabel({ ...record, provider: "slack" })).toBe(record.botLabel);
      expect(connectionHealthPresentation(record).message).toBe(i18n.t("communityPhoton.receiverConnected"));
      expect(connectionHealthPresentation(record).error).toBe("RAW provider error");
      expect(photonHealthMessage("slack", "Photon receiver connected")).toBe("Photon receiver connected");
      expect(photonHealthMessage("imessage-photon", "Provider text")).toBe("Provider text");
      expect(photonResourceType("future_resource")).toBe("future_resource");
      expect(JSON.stringify(record)).toBe(original);
    }
  });

  it("updates lifecycle guidance in an open confirmation without disconnecting or replaying work", async () => {
    mocks.tab = "activity";
    mocks.get.mockResolvedValue(endpoint({ status: "active", photonAllocation: "shared", healthMessage: "Photon receiver connected", setup: { step: "complete" } }));
    await render(<ChatEndpointDetail />);
    await click(i18n.t("localizationApps.removeConnection91"));
    for (const locale of ["ru", "en"]) {
      await language(locale);
      expect(container.textContent).toContain(i18n.t("communityPhoton.reconnectGuidance"));
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(i18n.t("communityPhoton.disconnectGuidance"));
      expect(container.textContent).toContain(i18n.t("communityPhoton.receiverConnected"));
      expect(mocks.setup).not.toHaveBeenCalled(); expect(mocks.inspectPhoton).not.toHaveBeenCalled();
    }
  });
});
