// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasteConfigTab } from "./PasteConfigTab";
import { MCP_CONFIG_HELP_PROMPT } from "@paperclipai/shared";

const toolsApiMock = vi.hoisted(() => ({
  importMcpJson: vi.fn(),
  connectApp: vi.fn(),
  finishApp: vi.fn(),
}));
const copyTextToClipboardMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: toolsApiMock }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mockNavigate }));
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboardMock(text),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function helpTrigger(): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === "Get help creating an MCP config",
  );
  if (!button) throw new Error("help trigger not found");
  return button as HTMLButtonElement;
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

function promptTextarea(): HTMLTextAreaElement | undefined {
  return document.body.querySelector<HTMLTextAreaElement>("#mcp-config-help-prompt") ?? undefined;
}

/**
 * PAP-17087, plan 3A. Two things matter here beyond rendering: the control is
 * reachable by name for keyboard and screen-reader users, and opening or copying
 * it is inert — no connection, no import, no submit of whatever is in the box.
 */
describe("Paste a config — MCP config help", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    copyTextToClipboardMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
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

  async function openHelp() {
    await act(async () => {
      helpTrigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("offers a named help control beside the intro copy", async () => {
    await render();

    const trigger = helpTrigger();
    expect(trigger.getAttribute("aria-label")).toBe("Get help creating an MCP config");
    // It's a real button, so it is tabbable and Enter/Space activate it without
    // any extra key handling.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("disabled")).toBeNull();
  });

  it("shows the prompt read-only in a titled dialog", async () => {
    await render();
    await openHelp();

    expect(document.body.textContent).toContain("Ask an agent for an MCP config");
    const textarea = promptTextarea();
    expect(textarea).toBeTruthy();
    expect(textarea!.readOnly).toBe(true);
    expect(textarea!.value).toBe(MCP_CONFIG_HELP_PROMPT);
    // The prompt has an associated label, so a screen reader announces what the
    // focused field is.
    expect(document.body.querySelector('label[for="mcp-config-help-prompt"]')).toBeTruthy();
  });

  it("copies the prompt and confirms it", async () => {
    await render();
    await openHelp();

    await act(async () => {
      buttonWithText("Copy prompt")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(copyTextToClipboardMock).toHaveBeenCalledWith(MCP_CONFIG_HELP_PROMPT);
    expect(document.body.textContent).toContain("Copied to clipboard.");
  });

  it("tells the operator to copy by hand when the clipboard is unavailable", async () => {
    copyTextToClipboardMock.mockRejectedValue(new Error("Clipboard unavailable"));
    await render();
    await openHelp();

    await act(async () => {
      buttonWithText("Copy prompt")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("select the text above and copy it");
  });

  it("makes no connection or import request when opened or copied", async () => {
    await render();

    // Type something first: copying help must not submit it either.
    const configTextarea = Array.from(container.querySelectorAll("textarea"))[0]!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(configTextarea, '{"mcpServers":{"x":{"url":"https://example.test/mcp"}}}');
    configTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushReact();

    await openHelp();
    await act(async () => {
      buttonWithText("Copy prompt")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(toolsApiMock.importMcpJson).not.toHaveBeenCalled();
    expect(toolsApiMock.connectApp).not.toHaveBeenCalled();
    expect(toolsApiMock.finishApp).not.toHaveBeenCalled();
    // The operator's draft is untouched.
    expect(configTextarea.value).toBe('{"mcpServers":{"x":{"url":"https://example.test/mcp"}}}');
  });
});

/**
 * The prompt is the contract with the receiving agent. Assert the requirements the
 * plan enumerated, so a well-meaning copy edit cannot quietly drop one.
 */
describe("MCP_CONFIG_HELP_PROMPT contract", () => {
  it("asks for official-doc research and confirmation of the target", () => {
    expect(MCP_CONFIG_HELP_PROMPT).toContain("official documentation");
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/ask me for its name or a link to its documentation/i);
  });

  it("asks for one paste-ready mcpServers JSON object, first", () => {
    expect(MCP_CONFIG_HELP_PROMPT).toContain('"mcpServers"');
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/paste-ready JSON object FIRST/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/exactly one remote server entry/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/exact required header names/);
  });

  it("requires credential placeholders rather than live secrets", () => {
    expect(MCP_CONFIG_HELP_PROMPT).toContain("<YOUR_API_KEY>");
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/Do not ask me to paste a real token/);
  });

  it("asks for setup, scope, OAuth notes and source links", () => {
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/how I obtain each credential/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/scopes or permissions/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/which fields are optional/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/browser sign-in \(OAuth\)/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/official documentation links you actually used/);
  });

  it("asks for uncertainty disclosure and local-stdio guidance", () => {
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/Do not invent fields/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/say which part you are unsure about/);
    expect(MCP_CONFIG_HELP_PROMPT).toMatch(/only runs locally as a command \(stdio\)/);
  });

  it("interpolates nothing — it is a constant, so it cannot leak tenant data", () => {
    // A template hole is the only way company/config/secret data could reach the
    // clipboard from here.
    expect(MCP_CONFIG_HELP_PROMPT).not.toMatch(/\$\{/);
  });
});
