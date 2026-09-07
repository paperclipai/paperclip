// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";
const state = vi.hoisted(() => ({
  adapters: [] as object[],
  navigate: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ newAgentOpen: true, closeNewAgent: state.close }),
}));
vi.mock("@/api/adapters", () => ({
  adaptersApi: { list: async () => state.adapters },
}));
vi.mock("./onboarding/PillGuy", () => ({ PillGuy: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(async () => {
  vi.clearAllMocks();
  state.adapters = [
    { type: "codex_local", loaded: true },
    { type: "paperclip_runner", loaded: true },
    { type: "claude_local", loaded: true, disabled: true },
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <NewAgentDialog />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  cache.clear();
  container.remove();
});
async function name() {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Ada & Co");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Choose adapter");
}
it("requires a name and an enabled adapter before navigating", async () => {
  await click("Choose adapter");
  expect(document.body.textContent).toContain("Agent name");
  await name();
  expect(document.querySelector('input[value="claude_local"]')).toBeNull();
  await click("Configure agent");
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () =>
    (
      document.querySelector('input[value="codex_local"]') as HTMLInputElement
    ).click(),
  );
  await click("Configure agent");
  expect(state.close).toHaveBeenCalledTimes(1);
  const query = new URL(state.navigate.mock.calls[0][0], "http://local")
    .searchParams;
  expect(query.get("name")).toBe("Ada & Co");
  expect(query.get("adapterType")).toBe("codex_local");
});
it("offers native Codex, Claude ACPX, and OpenCode runners", async () => {
  await name();
  await act(async () =>
    (
      document.querySelector(
        'input[value="paperclip_runner"]',
      ) as HTMLInputElement
    ).click(),
  );
  const options = [...document.querySelectorAll("option")].map(
    (option) => option.textContent,
  );
  expect(options).toContain("Codex (app server)");
  expect(options).toContain("Claude (ACPX)");
  expect(options).toContain("OpenCode");
  expect(options.join(" ")).not.toContain("ACPX Codex");
});
