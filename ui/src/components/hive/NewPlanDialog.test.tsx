// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewPlanDialog } from "./NewPlanDialog";

const mockPlansApi = vi.hoisted(() => ({ create: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../api/plans", () => ({ plansApi: mockPlansApi }));
vi.mock("../../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

// Drive a controlled React input/textarea by value, the way a user typing would.
function setControlledValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function createButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Create draft"),
  ) as HTMLButtonElement | null;
}

function render() {
  const root = createRoot(document.createElement("div"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewPlanDialog open onOpenChange={() => {}} companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("NewPlanDialog manual-mode task guard", () => {
  beforeEach(() => {
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("disables Create until a title AND at least one task line are present", async () => {
    const root = render();
    await flushReact();

    // Empty form → disabled.
    expect(createButton()?.disabled).toBe(true);

    // Title only, tasks still empty → still disabled.
    const title = document.querySelector<HTMLInputElement>("#plan-title");
    setControlledValue(title!, "Build billing");
    await flushReact();
    expect(createButton()?.disabled).toBe(true);

    // Whitespace-only tasks → still disabled.
    const tasks = document.querySelector<HTMLTextAreaElement>("#plan-tasks");
    setControlledValue(tasks!, "   \n  ");
    await flushReact();
    expect(createButton()?.disabled).toBe(true);

    // A real task line → enabled.
    setControlledValue(tasks!, "Set up Stripe webhook");
    await flushReact();
    expect(createButton()?.disabled).toBe(false);

    flushSync(() => root.unmount());
  });
});
