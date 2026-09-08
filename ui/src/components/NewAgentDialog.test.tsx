// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";
import { queryKeys } from "@/lib/queryKeys";
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: async () => ({ enableNativeRunner: true }),
  },
}));
const invites = vi.hoisted(() => ({ createCompanyInvite: vi.fn(), getInviteOnboarding: vi.fn(), copy: vi.fn() }));
vi.mock("../api/access", () => ({ accessApi: invites }));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: invites.copy }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
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
  invites.createCompanyInvite.mockResolvedValue({ token: "one-time-token", onboardingTextPath: "/api/invites/one-time-token/onboarding.txt" });
  invites.getInviteOnboarding.mockResolvedValue({ onboarding: { connectivity: {} } });
  invites.copy.mockResolvedValue(undefined);
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

it.each([false, undefined])(
  "hides the runner unless explicitly enabled (%s)",
  async (enableNativeRunner) => {
    await act(async () => {
      cache.setQueryData(queryKeys.instance.experimentalSettings, {
        enableNativeRunner,
      });
    });
    await name();
    expect(
      document.querySelector('input[value="paperclip_runner"]'),
    ).toBeNull();
    expect(document.querySelector('input[value="codex_local"]')).not.toBeNull();
  },
);

it("offers only Claude, Codex, and OpenCode on Cloud, even with the runner enabled", async () => {
  await act(async () => {
    cache.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: { managed: true },
    });
    cache.setQueryData(
      queryKeys.adapters.all,
      [
        "claude_local",
        "codex_local",
        "opencode_local",
        "cursor",
        "cursor_cloud",
        "gemini_local",
        "grok_local",
        "kimi_local",
        "pi_local",
        "hermes_local",
        "paperclip_runner",
      ].map((type) => ({ type, loaded: true })),
    );
  });
  await name();
  expect(
    [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
      (input) => input.value,
    ),
  ).toEqual(["claude_local", "codex_local", "opencode_local"]);
  expect(document.body.textContent).not.toContain("CLI harness");
});

it("keeps agent-only invitations reachable from the new-agent flow", async () => {
  await click("Invite an external agent");
  const message = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Help with research");
    message.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Generate onboarding prompt");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(invites.createCompanyInvite).toHaveBeenCalledWith("company-1", {
    allowedJoinTypes: "agent", humanRole: null, agentMessage: "Help with research",
  });
  expect(document.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toContain("/api/invites/one-time-token/onboarding.txt");
  expect(invites.copy).toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});

it("keeps the generated invitation readable when clipboard access fails", async () => {
  invites.copy.mockRejectedValue(new Error("Clipboard unavailable"));
  invites.getInviteOnboarding.mockRejectedValue(new Error("Manifest unavailable"));
  await click("Invite an external agent");
  await click("Generate onboarding prompt");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.body.textContent).toContain("Copy the prompt manually");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toContain("/api/invites/one-time-token/onboarding.txt");
});
