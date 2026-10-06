// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { CreateStatusCardDialog } from "./CreateStatusCardDialog";

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/api/statusCards", () => ({ statusCardsApi: api }));
vi.mock("./SummarizerAgentSelect", () => ({
  SummarizerAgentSelect: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="summarizer-id" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CreateStatusCardDialog locale boundary", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalLanguage: string;

  beforeEach(() => {
    originalLanguage = i18n.language;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    api.create.mockResolvedValue({ id: "created-card" });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); await i18n.changeLanguage(originalLanguage); });
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>
        <CreateStatusCardDialog companyId="company-1" open onOpenChange={() => {}} />
      </QueryClientProvider>);
    });
  }

  it("preserves a user prompt when switching language and submits unchanged execution settings", async () => {
    await i18n.changeLanguage("en");
    await render();
    const textarea = document.querySelector<HTMLTextAreaElement>("#status-card-prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Keep the release notes in English.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(textarea.value).toBe("Keep the release notes in English.");
    expect(document.body.textContent).toContain("За чем нужно следить?");
    expect(api.create).not.toHaveBeenCalled();
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Создать карточку");
    expect(button).toBeDefined();
    await act(async () => { button!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(api.create).toHaveBeenCalledWith("company-1", {
      interestPrompt: "Keep the release notes in English.",
      titlePinned: false,
      agentId: null,
      refreshPolicy: defaultStatusCardRefreshPolicy,
    });
  });

  it("localizes example labels without rewriting the bundled execution prompt", async () => {
    await i18n.changeLanguage("ru");
    await render();
    const example = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "задачи по оценке качества");
    expect(example).toBeDefined();
    await act(async () => { example!.click(); });
    expect(document.querySelector<HTMLTextAreaElement>("#status-card-prompt")?.value).toBe("issues about evals");
    expect(api.create).not.toHaveBeenCalled();
  });
});
