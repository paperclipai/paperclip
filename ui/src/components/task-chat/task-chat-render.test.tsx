// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_CHAT_STATES } from "./task-chat-states";
import { buildScenario } from "./task-chat-fixtures";
import { TaskChatThreadView } from "./TaskChatThreadView";
import type { TaskChatItem } from "./task-chat-model";
import { TaskChatPlanView } from "./TaskChatPlanView";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatPresentationProvider } from "./presentation-mode";

/**
 * Finish-line clause C: every state id in the inventory renders without error.
 * Iterates the canonical enum so a new state can never be added without a
 * fixture + a passing render here.
 */
describe("Task chat state inventory renders", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  for (const id of TASK_CHAT_STATES) {
    it(`renders state "${id}" without error`, () => {
      const scenario = buildScenario(id);
      const root = createRoot(container);
      expect(() => {
        flushSync(() => {
          root.render(
            // ThemeProvider: bubbles render markdown via MarkdownBody, which
            // reads the theme — mirror the real app's provider tree.
            <ThemeProvider>
              {scenario.surface === "plan" && scenario.plan ? (
                <TaskChatPlanView plan={scenario.plan} />
              ) : (
                <TaskChatThreadView items={scenario.items} scroll={false} />
              )}
            </ThemeProvider>,
          );
        });
      }).not.toThrow();
      expect(container.textContent && container.textContent.length).toBeTruthy();
      flushSync(() => root.unmount());
    });
  }
});

describe("Task chat thread rhythm", () => {
  it("keeps consecutive system events compact while preserving message separation", () => {
    const items: TaskChatItem[] = [
      { id: "human", kind: "message", author: "human", text: "Start", timestamp: "9:00 AM" },
      { id: "system-1", kind: "message", author: "system", text: "Workspace ready." },
      { id: "marker", kind: "marker", variant: "turn_boundary", label: "Plan created" },
      { id: "agent", kind: "message", author: "agent", authorName: "Builder", text: "Done", timestamp: "9:01 AM" },
    ];
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    const host = document.body.lastElementChild as HTMLDivElement;

    flushSync(() => root.render(
      <ThemeProvider>
        <TaskChatThreadView items={items} scroll={false} />
      </ThemeProvider>,
    ));

    const human = host.querySelector('[data-thread-item-kind="human"]');
    const system = host.querySelector('[data-thread-item-kind="system"]');
    const marker = host.querySelector('[data-thread-item-kind="marker"]');
    const agent = host.querySelector('[data-thread-item-kind="agent"]');
    expect(human?.className).not.toContain("mt-");
    expect(system?.className).toContain("mt-3");
    expect(marker?.className).toContain("mt-2");
    expect(agent?.className).toContain("mt-3");
    expect(system?.querySelector('[role="group"]')?.getAttribute("aria-label")).toContain("System update");
    expect(marker?.querySelector('[role="separator"]')?.getAttribute("aria-label")).toBe("Plan created");

    flushSync(() => root.unmount());
    host.remove();
  });
});

describe("Task chat thread order", () => {
  const orderProbeItems: TaskChatItem[] = [
    { id: "first", kind: "message", author: "human", text: "Earliest", timestamp: "9:00 AM" },
    { id: "second", kind: "message", author: "agent", authorName: "Builder", text: "Middle", timestamp: "9:01 AM" },
    { id: "third", kind: "message", author: "human", text: "Newest", timestamp: "9:02 AM" },
  ];

  function renderOrderProbe(threadOrder?: "oldest_first" | "newest_first") {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        <ThemeProvider>
          <TaskChatThreadView
            items={orderProbeItems}
            scroll={false}
            threadOrder={threadOrder}
            tail={<div data-testid="order-probe-tail">live</div>}
            footer={<div data-testid="order-probe-footer">older</div>}
          />
        </ThemeProvider>,
      ),
    );
    return { host, root };
  }

  function renderedAnchorIds(host: HTMLElement): string[] {
    return [...host.querySelectorAll("[data-thread-anchor]")].map(
      (el) => el.getAttribute("data-thread-anchor") ?? "",
    );
  }

  it("renders items chronologically by default", () => {
    const { host, root } = renderOrderProbe();
    expect(renderedAnchorIds(host)).toEqual(["first", "second", "third"]);
    flushSync(() => root.unmount());
    host.remove();
  });

  it("reverses items and lifts the live tail to the top for newest_first", () => {
    const { host, root } = renderOrderProbe("newest_first");
    expect(renderedAnchorIds(host)).toEqual(["third", "second", "first"]);
    const tail = host.querySelector('[data-testid="order-probe-tail"]');
    const newest = host.querySelector('[data-thread-anchor="third"]');
    const footer = host.querySelector('[data-testid="order-probe-footer"]');
    expect(tail && newest && footer).toBeTruthy();
    // Tail renders above the reversed history; the footer stays at the
    // chronological end (bottom) of the list.
    expect(
      tail!.compareDocumentPosition(newest!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      newest!.compareDocumentPosition(footer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    flushSync(() => root.unmount());
    host.remove();
  });

  it.each(["production", "streamlined"] as const)(
    "bounds render work for a 512-row newest-first thread in %s mode",
    async (mode) => {
      const { buildScenario: realScenario } = await vi.importActual<
        typeof import("./task-chat-fixtures")
      >("./task-chat-fixtures");
      const exchange = realScenario("agent-message").items;
      const source = Array.from({ length: 256 }, (_, index) =>
        exchange.map((item) => ({ ...item, id: `${index}-${item.id}` })),
      ).flat();
      const chronologicalIds = source.map((item) => item.id);
      let kindReads = 0;
      // Count discriminator reads throughout grouping, ordering and rendering.
      // Keep the guard on each item so copying the array cannot bypass it.
      // A nested full-list scan exceeds this linear budget and throws early.
      const workLimit = source.length * 32;
      const items = source.map((item) => new Proxy(item, {
        get(target, property, receiver) {
          if (property === "kind" && ++kindReads > workLimit) {
            throw new Error(`Thread render exceeded ${workLimit} item-kind reads`);
          }
          return Reflect.get(target, property, receiver);
        },
      }));
      const host = document.body.appendChild(document.createElement("div"));
      const root = createRoot(host);
      const render = (threadOrder: "oldest_first" | "newest_first", tail: string) => {
        flushSync(() => root.render(
          <ThemeProvider>
            <TaskChatPresentationProvider mode={mode}>
              <TaskChatThreadView
                items={items}
                scroll={false}
                threadOrder={threadOrder}
                tail={<div>{tail}</div>}
              />
            </TaskChatPresentationProvider>
          </ThemeProvider>,
        ));
      };
      try {
        expect(source).toHaveLength(512);
        render("newest_first", "Streaming");
        expect(renderedAnchorIds(host)).toEqual([...chronologicalIds].reverse());
        expect(kindReads).toBeGreaterThan(0);
        expect(kindReads).toBeLessThanOrEqual(workLimit);

        // Streaming updates must reuse the settled history's memoized work.
        const settledReads = kindReads;
        render("newest_first", "Streaming more");
        expect(host.textContent).toContain("Streaming more");
        expect(kindReads).toBe(settledReads);

        kindReads = 0;
        render("oldest_first", "Streaming more");
        expect(renderedAnchorIds(host)).toEqual(chronologicalIds);
        expect(kindReads).toBeLessThanOrEqual(workLimit);
        expect(source.map((item) => item.id)).toEqual(chronologicalIds);
      } finally {
        flushSync(() => root.unmount());
        host.remove();
      }
    },
  );
});
