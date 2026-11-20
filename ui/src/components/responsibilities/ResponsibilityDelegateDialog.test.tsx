// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, ResponsibilityDelegationMode } from "@paperclipai/shared";
import { PrimaryAgentPresentationProvider } from "@/components/primary-agent/PrimaryAgentPresentation";
import { RESPONSIBILITY_DELEGATION_MODE_OPTIONS } from "@/lib/responsibilities";
import { orderDelegationAgents, ResponsibilityDelegateDialog } from "./ResponsibilityDelegateDialog";

const api = vi.hoisted(() => ({ delegate: vi.fn() }));
const agentsApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: api }));
vi.mock("@/api/agents", () => ({ agentsApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const agent = (id: string, name: string, status: Agent["status"] = "idle") =>
  ({ id, companyId: "company", name, status, role: "general", title: null }) as unknown as Agent;
const zed = agent("agent-zed", "Zed");
const ada = agent("agent-ada", "Ada");
const gone = agent("agent-gone", "Gone", "terminated");

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const buttonNamed = (label: string) =>
  [...dialog().querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement;

async function render(props: { defaultTitle?: string; projectId?: string | null } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PrimaryAgentPresentationProvider
          value={{ companyId: "company", primaryAgentId: ada.id, primaryAgent: ada, onChange: () => {} }}
        >
          <ResponsibilityDelegateDialog
            open
            onOpenChange={() => {}}
            companyId="company"
            responsibility={{ id: "resp-1", title: "Fundraising" }}
            {...props}
          />
        </PrimaryAgentPresentationProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  agentsApi.list.mockResolvedValue([zed, gone, ada]);
  api.delegate.mockResolvedValue({
    issue: { id: "issue-1", companyId: "company", identifier: "PAP-9", title: "Draft the update", status: "todo", assigneeAgentId: ada.id, projectId: null },
    link: { id: "link-1" },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe("orderDelegationAgents", () => {
  it("puts the primary agent first and leaves out terminated agents", () => {
    expect(orderDelegationAgents([zed, gone, ada], ada.id).map((item) => item.name)).toEqual(["Ada", "Zed"]);
    expect(orderDelegationAgents([zed, ada], null).map((item) => item.name)).toEqual(["Ada", "Zed"]);
  });
});

describe("ResponsibilityDelegateDialog", () => {
  it("offers three ways to work on a new task, each with its consequence, and never a whole responsibility", async () => {
    await render();
    expect(dialog().textContent).toContain("New task for an agent");
    const radios = [...dialog().querySelectorAll('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(
      RESPONSIBILITY_DELEGATION_MODE_OPTIONS.map((option) => `${option.title}${option.description}`),
    );
    expect(radios).toHaveLength(3);
    expect(dialog().textContent).not.toContain("Own it from now on");
    expect(dialog().querySelector('[aria-label="Agent"]')?.textContent).toContain("Ada");
  });

  it.each(RESPONSIBILITY_DELEGATION_MODE_OPTIONS.map((option) => [option.value, option.title] as const))(
    "sends mode %s to the primary agent by default",
    async (mode: ResponsibilityDelegationMode, title: string) => {
      await render({ defaultTitle: "Draft the update" });
      const radio = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((candidate) =>
        candidate.textContent?.startsWith(title),
      )!;
      await act(async () => radio.click());
      await act(async () => buttonNamed("Create task").click());
      await flush();
      expect(api.delegate).toHaveBeenCalledExactlyOnceWith("resp-1", {
        title: "Draft the update",
        assigneeAgentId: ada.id,
        mode,
      });
    },
  );

  it("sends instructions and the launching project, then shows the new task", async () => {
    await render({ defaultTitle: "", projectId: "project-1" });
    const titleInput = dialog().querySelector<HTMLInputElement>('input[placeholder="e.g. Draft the investor update"]')!;
    const instructions = dialog().querySelector("textarea")!;
    expect(buttonNamed("Create task").disabled).toBe(true);
    await act(async () => {
      setInputValue(titleInput, "Draft the update");
      setInputValue(instructions, "Use last month's numbers");
    });
    await act(async () => buttonNamed("Create task").click());
    await flush();
    expect(api.delegate).toHaveBeenCalledExactlyOnceWith("resp-1", {
      title: "Draft the update",
      instructions: "Use last month's numbers",
      assigneeAgentId: ada.id,
      mode: "prepare_i_decide",
      projectId: "project-1",
    });
    expect(dialog().textContent).toContain("Task created");
    expect(dialog().querySelector('a[href="/issues/PAP-9"]')?.textContent).toContain("Draft the update");
  });

  it("keeps the form and says what happened when the server refuses", async () => {
    api.delegate.mockRejectedValue(new Error("Confirm this responsibility before handing work to an agent under it"));
    await render({ defaultTitle: "Draft the update" });
    await act(async () => buttonNamed("Create task").click());
    await flush();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn’t create the task.");
    expect(buttonNamed("Create task")).toBeDefined();
  });
});
