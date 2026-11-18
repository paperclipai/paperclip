// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { defaultRoutineAgentId, MakeRoutineDialog, type RoutineTaskTarget } from "./MakeRoutineDialog";

const api = vi.hoisted(() => ({ repeatAsRoutine: vi.fn() }));
vi.mock("@/api/routine-suggestions", () => ({ routineSuggestionsApi: api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string, createdAt: string, status = "idle") =>
  ({ id, name, status, createdAt: new Date(createdAt), companyId: "company-storybook" }) as unknown as Agent;
const AGENTS = [
  agent("agent-late", "Analyst", "2026-10-05"),
  agent("agent-first", "Chief of staff", "2026-10-01"),
  agent("agent-gone", "Retired", "2026-09-01", "terminated"),
];

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const dialog = () => document.body.querySelector<HTMLElement>("[data-make-routine-dialog]")!;
const select = (label: string) => dialog().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const button = (label: string) => [...dialog().querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
const preview = () => dialog().querySelector("[data-cadence-preview]")?.textContent ?? "";

function choose(element: HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function render(task: RoutineTaskTarget, onOpenChange = vi.fn()) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MakeRoutineDialog
          open
          onOpenChange={onOpenChange}
          companyId="company-storybook"
          task={task}
          agents={AGENTS}
          filedUnder={["Seed extension", "Investor relations"]}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
  return onOpenChange;
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("Make it a routine", () => {
  it("defaults to the task's agent, else the organization's first agent that can work", () => {
    expect(defaultRoutineAgentId(AGENTS, "agent-late")).toBe("agent-late");
    expect(defaultRoutineAgentId(AGENTS, null)).toBe("agent-first");
    expect(defaultRoutineAgentId(AGENTS, "agent-gone")).toBe("agent-first");
    expect(defaultRoutineAgentId([], null)).toBe("");
  });

  it("starts on the cadence the title names, says it in the words that will run, and where the routine goes", async () => {
    await render({ issueId: "task-1", identifier: "PAP-1", title: "Thursday pipeline review", assigneeAgentId: null });
    expect(dialog().querySelector("h2")?.textContent).toBe("Make it a routine");
    expect(select("How often")?.value).toBe("weekly");
    expect(select("Day of the week")?.value).toBe("thursday");
    expect(preview()).toContain("Every Thursday at 9 AM, your time");
    expect(preview()).toContain("Suggested from the title.");
    expect(select("Who runs it")?.value).toBe("agent-first");
    expect([...select("Who runs it")!.options].map((option) => option.textContent)).toEqual(["Analyst", "Chief of staff"]);
    expect(dialog().querySelector("[data-routine-filing-note]")?.textContent).toBe(
      "The task itself stays as it is. The routine is filed under Seed extension and Investor relations, like the task.",
    );
    // One footer row: the quiet way out on the left, the action on the right.
    const footer = button("Cancel").parentElement!;
    expect([...footer.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Cancel", "Make it a routine"]);

    await act(async () => choose(select("How often")!, "monthly"));
    expect(select("Day of the week")).toBeNull();
    await act(async () => choose(select("Day of the month")!, "15"));
    expect(preview()).toContain("On the 15th of every month at 9 AM");
    await act(async () => choose(select("How often")!, "weekdays"));
    expect(preview()).toContain("Every weekday at 9 AM");
  });

  it("starts on an agent's offered cadence and sends the person's choices with their time zone", async () => {
    api.repeatAsRoutine.mockResolvedValue({
      routine: { id: "routine-1", title: "Monthly investor update", assigneeAgentId: "agent-late", projectId: null, status: "active" },
      cadenceLabel: "On the 1st of every month at 9 AM",
      timezone: "UTC",
      responsibilityIds: [],
      acceptedOfferId: "interaction-1",
    });
    const onOpenChange = await render({
      issueId: "task-2",
      identifier: "PAP-2",
      title: "Monthly investor update",
      assigneeAgentId: "agent-late",
      suggestedCadence: { frequency: "monthly", dayOfMonth: 1, time: "09:00" },
      cadenceSource: "offer",
    });
    expect(preview()).toContain("The agent suggested this.");
    expect(select("Who runs it")?.value).toBe("agent-late");
    await act(async () => button("Make it a routine").click());
    await flush();
    expect(api.repeatAsRoutine).toHaveBeenCalledWith("task-2", {
      title: "Monthly investor update",
      cadence: { frequency: "monthly", dayOfWeek: null, dayOfMonth: 1, time: "09:00" },
      assigneeAgentId: "agent-late",
      timezone: expect.any(String),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says what went wrong and stays open", async () => {
    api.repeatAsRoutine.mockRejectedValue(new ApiError("A routine already repeats this", 409, { error: "A routine already repeats this" }));
    const onOpenChange = await render({ issueId: "task-3", identifier: null, title: "Send the update", assigneeAgentId: null });
    await act(async () => button("Make it a routine").click());
    await flush();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn’t make the routine.");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
