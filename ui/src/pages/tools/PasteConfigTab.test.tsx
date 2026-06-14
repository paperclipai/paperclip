// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpJsonImportPreview } from "@paperclipai/shared";
import { PasteConfigTab } from "./PasteConfigTab";

const toolsApiMock = vi.hoisted(() => ({ importMcpJson: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: toolsApiMock }));
// The tab uses `useNavigate` from the app router (PAP-11088 draft hand-off),
// which needs CompanyProvider; stub it so the copy hint renders in isolation.
vi.mock("@/lib/router", () => ({ useNavigate: () => mockNavigate }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonStartingWith(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim().startsWith(text),
  ) as HTMLButtonElement | undefined;
}

describe("PasteConfigTab — discoverability copy (PAP-11091)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <PasteConfigTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("shows a hint linking back to the Connect-an-app link flow", async () => {
    await render();

    expect(container.textContent).toContain("Just a URL?");
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Connect with a link"),
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/apps/connect");
  });
});

describe("PasteConfigTab — activation handoff (PAP-11092)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <PasteConfigTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  async function pasteAndCheck(preview: McpJsonImportPreview, snippet: string) {
    toolsApiMock.importMcpJson.mockResolvedValue(preview);
    await render();
    const textarea = container.querySelector("textarea")!;
    await act(async () => setTextareaValue(textarea, snippet));
    await flushReact();
    await act(async () => {
      buttonStartingWith("Check config")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("renders a Continue button for a remote draft that navigates to the prefilled connect wizard", async () => {
    await pasteAndCheck(
      {
        drafts: [
          {
            name: "kv-demo",
            transport: "remote_http",
            status: "draft",
            config: { url: "http://127.0.0.1:8848/mcp" },
            credentialRefs: [],
            warnings: [],
          },
        ],
      },
      '{ "mcpServers": { "kv-demo": { "url": "http://127.0.0.1:8848/mcp" } } }',
    );

    expect(container.textContent).toContain("We found 1 app in that config");
    const continueButton = buttonStartingWith("Continue");
    expect(continueButton).toBeTruthy();

    await act(async () => {
      continueButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const target = mockNavigate.mock.calls[0][0] as string;
    expect(target).toContain("/apps/connect?");
    expect(target).toContain(`link=${encodeURIComponent("http://127.0.0.1:8848/mcp")}`);
    expect(target).toContain("name=kv-demo");
    // The dead-end "Next, you'll add the keys" copy is gone.
    expect(container.textContent).not.toContain("Next, you'll add the keys");
  });

  it("does not offer Continue for a stdio draft (draft-only, no link to hand off)", async () => {
    await pasteAndCheck(
      {
        drafts: [
          {
            name: "github",
            transport: "local_stdio",
            status: "draft",
            config: { importedCommand: "npx -y @modelcontextprotocol/server-github", importedArgs: [] },
            credentialRefs: [],
            warnings: ["Imported stdio commands stay draft-only unless mapped to an approved Paperclip template."],
          },
        ],
      },
      '{ "mcpServers": { "github": { "command": "npx -y @modelcontextprotocol/server-github" } } }',
    );

    expect(container.textContent).toContain("We found 1 app in that config");
    expect(buttonStartingWith("Continue")).toBeFalsy();
    expect(container.textContent).toContain("stay as drafts until an admin");
  });
});
