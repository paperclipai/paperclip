// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailEndpointSummary, EmailMessage, EmailPublicationSummary } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { formatDateTime } from "@/lib/utils";
import { EmailEndpointSetup, EmailEndpointSettings } from "@/pages/apps/chat/EmailEndpointSetup";
import { EmailMessageCard } from "./EmailMessageCard";
import { EmailTaskActivity } from "./EmailTaskActivity";
import { EmailConnectionAccess } from "./EmailConnectionAccess";
import { EmailSafetyNotice } from "./EmailSafetyNotice";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), connect: vi.fn(), reconnect: vi.fn(), control: vi.fn(), resolve: vi.fn(),
  thread: vi.fn(), listAttachments: vi.fn(), listAgents: vi.fn(), navigate: vi.fn(),
  listConnectionGrants: vi.fn(), getConnectionInstalls: vi.fn(), putConnectionInstalls: vi.fn(),
}));
vi.mock("@/api/email", () => ({ emailApi: mocks }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: vi.fn(), listAttachments: mocks.listAttachments } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("@/api/tools", () => ({ toolsApi: mocks }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-raw" }) }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams()],
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({
  AccessStep: ({ onContinue, submitLabel }: { onContinue: () => void; submitLabel: string }) => <button onClick={onContinue}>{submitLabel}</button>,
}));
vi.mock("@/components/TrustPresetSection", () => ({ TrustPresetSection: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inbox: EmailEndpointSummary = {
  id: "endpoint-raw", companyId: "company-raw", connectionId: "connection-raw", assignedAgentId: "agent-raw",
  address: "raw.inbox@agentmail.to", status: "active", receiveMode: "websocket",
  lastError: "Provider raw diagnostic: webhook_secret", lastSyncAt: "2026-09-10T12:34:56.000Z",
};
const message: EmailMessage = {
  id: "email-raw", providerMessageId: "provider-message-raw", direction: "inbound",
  from: "Board <sender@example.test>", to: ["target@example.test"], cc: ["copy@example.test"], bcc: ["hidden@example.test"],
  subject: "Email received", text: "User text: Continue, Pause, Resume", fullText: "Raw complete body with quoted original",
  commentId: null, attachmentIds: ["attachment-raw"], timestamp: "2026-09-10T12:34:56.000Z", automatic: false,
};
const publication: EmailPublicationSummary = {
  id: "publication-raw", issueId: "issue-raw", conversationId: "conversation-raw", outcome: "uncertain",
  error: "Provider delivery diagnostic: raw_status", providerMessageId: null,
  request: {
    endpointId: "endpoint-raw", parentIssueId: "issue-raw", idempotencyKey: "request-raw", replyAll: false,
    attachmentIds: [], to: ["target@example.test"], subject: "User subject", text: "Raw pending body",
  },
};

let root: Root | undefined;
let container: HTMLDivElement;
let cache: QueryClient;

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function mount(node: ReactNode) {
  await act(async () => root!.render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>));
  await flush();
  await flush();
}
async function language(locale: "en" | "ru") {
  await act(async () => { await i18n.changeLanguage(locale); });
}
function button(label: string) {
  const node = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(node, `button ${label}`).toBeDefined();
  return node!;
}
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  mocks.list.mockResolvedValue([inbox]);
  mocks.listAgents.mockResolvedValue([]);
  mocks.listAttachments.mockResolvedValue([{ id: "attachment-raw", originalFilename: "Original attachment name.txt" }]);
  mocks.connect.mockRejectedValue(new Error("Raw provider key error"));
  mocks.reconnect.mockRejectedValue(new Error("Raw reconnect diagnostic"));
  mocks.resolve.mockResolvedValue({});
  mocks.control.mockResolvedValue({ status: "paused" });
  mocks.listConnectionGrants.mockResolvedValue({
    grants: [{ status: "active", kind: "organization" }], capabilities: { canConfigure: true }, currentUserId: "user-raw",
  });
  mocks.getConnectionInstalls.mockResolvedValue({ installs: [] });
  mocks.putConnectionInstalls.mockRejectedValue(new Error("Raw access diagnostic"));
  cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  cache.clear();
  container.remove();
  await i18n.changeLanguage("en");
});

describe("Email localization boundaries", () => {
  it("translates safety guidance and preserves provider documentation destinations", async () => {
    await mount(<EmailSafetyNotice />);
    for (const locale of ["en", "ru", "en"] as const) {
      await language(locale);
      expect(container.textContent).toContain(locale === "ru" ? "Paperclip не проверяет ограничения для отправителей." : "Paperclip does not verify sender restrictions.");
      const consoleLink = container.querySelector<HTMLAnchorElement>('a[href="https://console.agentmail.to"]')!;
      const docsLink = container.querySelector<HTMLAnchorElement>('a[href="https://docs.agentmail.to/knowledge-base/allowlists-blocklists"]')!;
      expect(consoleLink.textContent?.trim()).toBe(locale === "ru" ? "Открыть AgentMail ↗" : "Open AgentMail ↗");
      expect(docsLink.textContent?.trim()).toBe(locale === "ru" ? "Настроить списки разрешённых отправителей ↗" : "Set up allowlists ↗");
      expect(consoleLink.target).toBe("_blank");
      expect(docsLink.rel).toBe("noreferrer");
    }
  });

  it("translates access controls without mutating grants and submits the raw company target", async () => {
    await mount(<EmailConnectionAccess companyId="company-raw" connectionId="connection-raw" agents={[]} />);
    for (const locale of ["en", "ru", "en"] as const) {
      await language(locale);
      expect(container.textContent).toContain(locale === "ru" ? "Любой пользователь в организации" : "Any human in the company");
      expect(container.textContent).toContain(locale === "ru" ? "Какие агенты могут использовать это подключение?" : "Which agents can use this connection?");
      const selected = container.querySelector('[role="radio"][aria-checked="true"]');
      expect(selected?.textContent).toBe(locale === "ru" ? "Только выбранные агенты" : "Just agents I pick");
      expect(mocks.putConnectionInstalls).not.toHaveBeenCalled();
    }
    await language("ru");
    const all = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((node) => node.textContent === "Любой агент")!;
    await act(async () => all.click());
    await flush();
    expect(mocks.putConnectionInstalls).toHaveBeenCalledExactlyOnceWith("connection-raw", [{ targetType: "company", targetId: "company-raw" }]);
    await language("en");
    expect(container.textContent).toContain("Raw access diagnostic");
    expect(mocks.putConnectionInstalls).toHaveBeenCalledTimes(1);
  });

  it("preserves an unsaved API key and setup step across EN/RU/EN without connecting", async () => {
    await mount(<EmailEndpointSetup />);
    await act(async () => button("Continue").click());
    const input = container.querySelector<HTMLInputElement>("#email-api-key")!;
    await typeInto(input, "raw-api-key-test-fixture");
    for (const locale of ["ru", "en"] as const) {
      await language(locale);
      expect(container.querySelector<HTMLInputElement>("#email-api-key")).toBe(input);
      expect(input.value).toBe("raw-api-key-test-fixture");
      expect(input.placeholder).toBe(locale === "ru" ? "Вставьте API-ключ AgentMail" : "Paste your AgentMail API key");
      expect(container.textContent).toContain(locale === "ru" ? "Добавьте API-ключ AgentMail" : "Add your AgentMail API key");
      const help = container.querySelector<HTMLAnchorElement>('a[href="https://console.agentmail.to"]');
      expect(help?.textContent?.trim()).toBe(locale === "ru" ? "Получить ключ в AgentMail ↗" : "Get a key in AgentMail ↗");
      expect(mocks.connect).not.toHaveBeenCalled();
    }
    await act(async () => button("Connect AgentMail").click());
    await flush();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledWith("company-raw", {
      apiKey: "raw-api-key-test-fixture", grantKind: "user", allAgents: false, agentIds: [], idempotencyKey: expect.any(String),
    });
    await language("ru");
    expect(container.textContent).toContain("Raw provider key error");
    expect(input.value).toBe("raw-api-key-test-fixture");
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("retains reconnect drafts, protocol enum values, and provider diagnostics across EN/RU/EN", async () => {
    const original = JSON.stringify(inbox);
    await mount(<EmailEndpointSettings endpointId="endpoint-raw" companyId="company-raw" />);
    const input = container.querySelector<HTMLInputElement>("#email-reconnect-key")!;
    const select = container.querySelector<HTMLSelectElement>("#email-reconnect-mode")!;
    await typeInto(input, "raw-replacement-key");
    await act(async () => {
      select.value = "webhook";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const locale of ["ru", "en"] as const) {
      await language(locale);
      expect(input.value).toBe("raw-replacement-key");
      expect(select.value).toBe("webhook");
      expect(container.textContent).toContain(inbox.address);
      expect(container.textContent).toContain(inbox.lastError);
      expect(container.textContent).toContain(formatDateTime(inbox.lastSyncAt!, { includeSeconds: true }));
      expect(container.textContent).toContain(locale === "ru" ? "Повторно подключить ящик" : "Reconnect inbox");
      expect(mocks.reconnect).not.toHaveBeenCalled();
      expect(mocks.control).not.toHaveBeenCalled();
    }
    await language("ru");
    await act(async () => button("Повторно подключить ящик").click());
    await flush();
    expect(mocks.reconnect).toHaveBeenCalledExactlyOnceWith("endpoint-raw", "raw-replacement-key", "webhook");
    await language("en");
    expect(container.textContent).toContain("Raw reconnect diagnostic");
    expect(input.value).toBe("raw-replacement-key");
    await act(async () => button("Pause").click());
    expect(mocks.control).toHaveBeenCalledExactlyOnceWith("endpoint-raw", "pause");
    expect(JSON.stringify(inbox)).toBe(original);
  });

  it("translates received mail chrome and dates while preserving message data and attachment links", async () => {
    const original = JSON.stringify({ message, publication });
    await mount(<EmailMessageCard message={message} publication={publication} issueId="issue-raw" />);
    const details = container.querySelector("details")!;
    details.open = true;
    for (const locale of ["ru", "en"] as const) {
      await language(locale);
      expect(container.querySelector("article")?.getAttribute("aria-label")).toBe(locale === "ru" ? "Письмо получено" : "Email received");
      expect(container.textContent).toContain(locale === "ru" ? "Доставка не подтверждена" : "Delivery uncertain");
      expect(container.textContent).toContain(formatDateTime(message.timestamp, { includeSeconds: true }));
      for (const raw of [message.from, ...message.to, ...message.cc!, ...message.bcc!, message.subject, message.text, message.fullText, message.providerMessageId, publication.error!]) {
        expect(container.textContent).toContain(raw);
      }
      const attachment = container.querySelector<HTMLAnchorElement>('a[href="/api/attachments/attachment-raw/content"]');
      expect(attachment?.textContent?.trim()).toBe("Original attachment name.txt");
      expect(details.open).toBe(true);
    }
    expect(JSON.stringify({ message, publication })).toBe(original);
    expect(mocks.listAttachments).toHaveBeenCalledTimes(1);
  });

  it("preserves the provider message ID while translating an uncertain delivery and submits raw outcome", async () => {
    mocks.thread.mockResolvedValue({ messages: [], publications: [publication] });
    await mount(<EmailTaskActivity companyId="company-raw" issueId="issue-raw" />);
    const details = container.querySelector("details")!;
    details.open = true;
    const input = container.querySelector<HTMLInputElement>("input")!;
    await typeInto(input, "raw-verified-provider-id");
    for (const locale of ["ru", "en"] as const) {
      await language(locale);
      expect(input.value).toBe("raw-verified-provider-id");
      expect(input.getAttribute("aria-label")).toBe(locale === "ru" ? "ID письма у провайдера" : "Provider message ID");
      expect(container.textContent).toContain(locale === "ru" ? "Результат отправки письма не подтверждён" : "Email uncertain");
      expect(container.textContent).toContain("User subject");
      expect(container.textContent).toContain("Raw pending body");
      expect(container.textContent).toContain(publication.error);
      expect(details.open).toBe(true);
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
    await language("ru");
    await act(async () => button("Подтвердить отправку").click());
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith("company-raw", "publication-raw", "sent", "raw-verified-provider-id");
  });
});
