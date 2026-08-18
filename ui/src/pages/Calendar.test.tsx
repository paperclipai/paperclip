// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, CalendarResult } from "@paperclipai/shared";
import { Calendar } from "./Calendar";

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
const calendarApiMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => breadcrumbState }));
vi.mock("../api/calendar", () => ({ calendarApi: calendarApiMock }));

function event(overrides: Partial<CalendarEvent> & { id: string; at: string }): CalendarEvent {
  return {
    kind: "routine_scheduled",
    tense: "projected",
    status: "scheduled",
    title: "Daily sweep",
    endAt: null,
    agentId: null,
    agentName: null,
    routineId: "routine-1",
    routineTitle: "Daily sweep",
    issueId: null,
    issueIdentifier: null,
    projectId: null,
    scheduleTimezone: "UTC",
    cronExpression: "0 9 * * *",
    href: "/routines/routine-1",
    ...overrides,
  };
}

function result(overrides: Partial<CalendarResult> = {}): CalendarResult {
  return {
    events: [],
    window: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T00:00:00.000Z", capped: false },
    counts: {
      routine_scheduled: 0,
      routine_run: 0,
      task_monitor: 0,
      task_activity: 0,
      agent_run: 0,
    },
    truncated: null,
    unschedulable: [],
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The toolbar only exists once the first fetch has resolved past the skeleton. */
async function waitForToolbar(container: HTMLElement) {
  await waitForAssertion(() => {
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderCalendar(container: HTMLDivElement, initialEntries: string[] = ["/calendar"]) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <Calendar />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

function clickByText(container: HTMLElement, text: string) {
  const target = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (!target) throw new Error(`No button labelled "${text}"`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Calendar page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0));
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    calendarApiMock.get.mockReset();
    calendarApiMock.get.mockResolvedValue(result());
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("opens on the month view and asks for a window spanning the future", async () => {
    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(calendarApiMock.get).toHaveBeenCalled();
    });
    const [companyId, filters] = calendarApiMock.get.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    // The point of the page: the requested window runs past now, which the
    // work timeline's window normaliser structurally cannot do.
    expect(new Date(filters.to).getTime()).toBeGreaterThan(Date.now());

    act(() => root.unmount());
  });

  it("renders projected and recorded entries with a distinguishable marker", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({
        events: [
          event({ id: "future", at: new Date(2026, 7, 6, 9, 0).toISOString() }),
          event({
            id: "past",
            at: new Date(2026, 7, 4, 9, 0).toISOString(),
            kind: "routine_run",
            tense: "actual",
            status: "succeeded",
          }),
        ],
      }),
    );

    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-tense="projected"]')).not.toBeNull();
      expect(container.querySelector('[data-tense="actual"]')).not.toBeNull();
    });

    act(() => root.unmount());
  });

  it("counts what is still ahead", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({
        events: [
          event({ id: "ahead-1", at: new Date(2026, 7, 6, 9, 0).toISOString() }),
          event({ id: "ahead-2", at: new Date(2026, 7, 7, 9, 0).toISOString() }),
          event({
            id: "behind",
            at: new Date(2026, 7, 4, 9, 0).toISOString(),
            tense: "actual",
            kind: "routine_run",
          }),
        ],
      }),
    );

    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("2 scheduled ahead");
    });

    act(() => root.unmount());
  });

  it("switches views from the toolbar and records it in the URL", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({ events: [event({ id: "a", at: new Date(2026, 7, 6, 9, 0).toISOString() })] }),
    );
    const { root } = renderCalendar(container);
    await waitForToolbar(container);

    clickByText(container, "Week");

    await waitForAssertion(() => {
      expect(container.querySelector('[aria-label="Week view"]')).not.toBeNull();
    });

    act(() => root.unmount());
  });

  it("restores the view and date named in the URL", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({ events: [event({ id: "a", at: new Date(2026, 7, 9, 9, 0).toISOString() })] }),
    );
    const { root } = renderCalendar(container, ["/calendar?view=day&date=2026-08-09"]);

    await waitForAssertion(() => {
      expect(container.querySelector('[aria-label="Day view"]')).not.toBeNull();
      // Asserted piecewise because the heading is rendered through
      // `toLocaleDateString`, whose field order varies by locale.
      const heading = container.querySelector('[role="toolbar"] h2')!;
      expect(heading.textContent).toContain("August");
      expect(heading.textContent).toContain("9");
    });

    act(() => root.unmount());
  });

  it("moves through periods with the keyboard", async () => {
    const { root } = renderCalendar(container, ["/calendar?view=month&date=2026-08-05"]);
    await waitForAssertion(() => expect(container.textContent).toContain("August 2026"));

    act(() => {
      globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("September 2026");
    });

    act(() => {
      globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("August 2026");
    });

    act(() => root.unmount());
  });

  it("ignores view shortcuts typed into a field", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({ events: [event({ id: "a", at: new Date(2026, 7, 6, 9, 0).toISOString() })] }),
    );
    const { root } = renderCalendar(container, ["/calendar?view=month"]);
    await waitForToolbar(container);

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[aria-label="Week view"]')).toBeNull();
    input.remove();

    act(() => root.unmount());
  });

  it("filters by kind and never lets every kind be switched off", async () => {
    const { root } = renderCalendar(container);
    await waitForToolbar(container);

    for (const label of ["Scheduled", "Runs", "Monitors", "Tasks", "Agents"]) {
      clickByText(container, label);
      await flush();
    }

    // Turning the last one off would leave a calendar that looks empty for a
    // reason the user cannot see, so the filter resets to everything instead.
    const lastCall = calendarApiMock.get.mock.calls.at(-1)!;
    expect(lastCall[1].kinds).toHaveLength(5);

    act(() => root.unmount());
  });

  it("says when a schedule was too dense to draw in full", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({
        events: [event({ id: "a", at: new Date(2026, 7, 6, 9, 0).toISOString() })],
        truncated: {
          series: [
            {
              routineId: "routine-1",
              routineTitle: "Every five minutes",
              triggerId: "trigger-1",
              cronExpression: "*/5 * * * *",
              returned: 500,
            },
          ],
          droppedEvents: 0,
          sources: [],
        },
      }),
    );

    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Every five minutes");
      expect(container.textContent).toContain("too often to draw in full");
    });

    act(() => root.unmount());
  });

  it("says when a source held more rows than it loads at once", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({
        events: [event({ id: "a", at: new Date(2026, 7, 6, 9, 0).toISOString() })],
        truncated: { series: [], droppedEvents: 0, sources: ["agent_run"] },
      }),
    );

    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("more agent runs");
      expect(container.textContent).toContain("Narrow the window");
    });

    act(() => root.unmount());
  });

  it("surfaces a routine whose schedule cannot be read", async () => {
    calendarApiMock.get.mockResolvedValue(
      result({
        events: [event({ id: "a", at: new Date(2026, 7, 6, 9, 0).toISOString() })],
        unschedulable: [
          {
            routineId: "routine-2",
            routineTitle: "Broken schedule",
            triggerId: "trigger-2",
            reason: "Cron expression must have exactly 5 fields",
          },
        ],
      }),
    );

    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Broken schedule");
    });

    act(() => root.unmount());
  });

  it("explains an empty calendar instead of showing a blank grid", async () => {
    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Nothing scheduled in this window");
    });

    act(() => root.unmount());
  });

  it("reports a failed load rather than pretending nothing is scheduled", async () => {
    calendarApiMock.get.mockRejectedValue(new Error("boom"));

    const { root } = renderCalendar(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("could not be loaded");
    });

    act(() => root.unmount());
  });
});
