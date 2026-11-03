// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act } from "react";
import { i18n, t } from "@/i18n";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { AgentCommentary } from "./AgentCommentary";

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/api/agentCommentary", () => ({ agentCommentaryApi: mocks }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "TES" } }),
  useOptionalCompany: () => null,
}));

const entry = {
  id: "20000000-0000-4000-8000-000000000001",
  agent: { id: "10000000-0000-4000-8000-000000000001", name: "Writer", icon: null },
  runId: "30000000-0000-4000-8000-000000000001",
  kind: "suggestion", preview: "Preserve context", body: "Preserve context across retries.",
  createdAt: "2026-10-19T12:00:00Z", task: null,
};

describe("Commentary links and pagination", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/TES/activity/commentary");
    mocks.list.mockImplementation(async (_companyId, filters) => ({
      items: [entry], total: 51, limit: 50, offset: filters.offset,
    }));
    mocks.get.mockResolvedValue(entry);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });
  function render() {
    flushSync(() => root.render(
      <QueryClientProvider client={client}><ThemeProvider><BrowserRouter>
        <AgentCommentary companyId="company-1" />
      </BrowserRouter></ThemeProvider></QueryClientProvider>,
    ));
  }

  it("loads pages of 50 and preserves the page in a shareable message URL", async () => {
    render();
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Read suggestion from Writer"]')).not.toBeNull());
    expect(mocks.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ limit: 50, offset: 0 }), expect.anything());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click());
    await vi.waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ limit: 50, offset: 50 }), expect.anything()));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Read suggestion from Writer"]')).not.toBeNull());
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Read suggestion from Writer"]')!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(entry.body));
    expect(new URLSearchParams(window.location.search).get("entry")).toBe(entry.id);
    expect(new URLSearchParams(window.location.search).get("offset")).toBe("50");
    flushSync(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(new URLSearchParams(window.location.search).has("entry")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("offset")).toBe("50");
  });

  it("opens the full message directly from a copied URL", async () => {
    window.history.replaceState(null, "", `/TES/activity/commentary?kind=suggestion&entry=${entry.id}`);
    render();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(entry.body));
    expect(mocks.get).toHaveBeenCalledWith("company-1", entry.id, expect.anything());
    expect(mocks.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ kind: "suggestion", limit: 50 }), expect.anything());
  });

  it("keeps the open message, search, raw content and canonical URL across EN/RU/EN", async () => {
    const raw = { ...entry, agent: { ...entry.agent, name: "Writer {{RAW}}" }, body: "User {{BODY}} content", preview: "User {{PREVIEW}}" };
    mocks.list.mockResolvedValue({ items: [raw], total: 51, limit: 50, offset: 0 }); mocks.get.mockResolvedValue(raw);
    window.history.replaceState(null, "", `/TES/activity/commentary?q=raw-search&kind=suggestion&entry=${entry.id}`);
    render();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(raw.body));
    const dialog = document.querySelector('[role="dialog"]'), search = container.querySelector<HTMLInputElement>("input")!;
    const listCalls = mocks.list.mock.calls.length, getCalls = mocks.get.mock.calls.length, url = window.location.href;
    try {
      for (const language of ["ru", "en", "ru", "en"]) {
        await act(async () => { await i18n.changeLanguage(language); });
        expect(document.querySelector('[role="dialog"]')).toBe(dialog);
        expect(dialog?.textContent).toContain(raw.body); expect(dialog?.textContent).toContain(raw.agent.name);
        expect(container.querySelector('input')).toBe(search); expect(search.value).toBe("raw-search");
        expect(window.location.href).toBe(url);
        expect(container.querySelector(`button[aria-label="${t("oct26Audit.commentary.readSuggestion", { name: raw.agent.name })}"]`)).not.toBeNull();
        expect(container.textContent).toContain(t("oct26Audit.commentary.pageRange", { start: 1, end: 1, count: 51 }));
        expect(mocks.list).toHaveBeenCalledTimes(listCalls); expect(mocks.get).toHaveBeenCalledTimes(getCalls);
      }
    } finally { await act(async () => { await i18n.changeLanguage("en"); }); }
  });
});
