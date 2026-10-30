// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstructionsBundleSettings } from "./InstructionsBundleSettings";

const mockAgentsApi = vi.hoisted(() => ({
  updateInstructionsBundle: vi.fn(),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));

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

function setNativeValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`Button not found: ${text}`);
  return match as HTMLButtonElement;
}

describe("InstructionsBundleSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAgentsApi.updateInstructionsBundle.mockReset();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  async function renderAndLoad(rootPath: string, entryFile: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <InstructionsBundleSettings agentId="agent-1" companyId="company-1" mode="managed" rootPath="" entryFile="AGENTS.md" blocked={false} />
        </QueryClientProvider>,
      ),
    );
    await act(() => button(container, "Advanced settings").click());
    const [rootInput, entryInput] = Array.from(container.querySelectorAll("input"));
    await act(() => setNativeValue(rootInput, rootPath));
    await act(() => setNativeValue(entryInput, entryFile));
    await act(() => button(container, "Load profile").click());
    await flushReact();
  }

  it("asks the server to switch only when the entry file already exists", async () => {
    mockAgentsApi.updateInstructionsBundle.mockResolvedValue({});

    await renderAndLoad("/srv/prompts/atlas", "AGENTS");

    expect(mockAgentsApi.updateInstructionsBundle).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.updateInstructionsBundle).toHaveBeenCalledWith(
      "agent-1",
      { mode: "external", rootPath: "/srv/prompts/atlas", entryFile: "AGENTS", requireExistingEntry: true },
      "company-1",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loaded AGENTS from /srv/prompts/atlas");
  });

  it("shows the server's reason and leaves the loading state when the entry file is missing", async () => {
    mockAgentsApi.updateInstructionsBundle.mockRejectedValue(new Error("AGENTS.md was not found in /srv/prompts/atlas"));

    await renderAndLoad("/srv/prompts/atlas", "AGENTS.md");

    expect(mockAgentsApi.updateInstructionsBundle).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("AGENTS.md was not found in /srv/prompts/atlas");
    expect(button(container, "Load profile").disabled).toBe(false);
    expect(Array.from(container.querySelectorAll("input")).every((input) => !input.disabled)).toBe(true);
  });
});
