// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatThreadView } from "./TaskChatThreadView";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

describe("TaskChatMarker", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:05:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  it("renders a failed run as a timestamped disclosure without divider rules", () => {
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatMarker
            item={{
              id: "run-1:failure",
              kind: "marker",
              variant: "interrupted",
              label: "Run failed",
              detail: "The runner stopped before returning an answer (runner_exited).",
              collapsible: true,
              createdAtIso: "2026-09-01T12:00:00.000Z",
              runHref: "/agents/codex/runs/run-1",
            }}
          />
        </ThemeProvider>,
      ),
    );

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-collapsible-marker"] button[aria-expanded]',
    )!;
    expect(toggle.textContent).toContain("Run failed");
    expect(toggle.textContent).toContain("5m ago");
    expect(
      container
        .querySelector('[data-testid="task-chat-collapsible-marker"]')
        ?.classList.contains("items-start"),
    ).toBe(true);
    expect(container.querySelector(".border-dashed")).toBeNull();
    expect(container.textContent).not.toContain("runner_exited");

    flushSync(() => toggle.click());

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("runner_exited");
    expect(
      container.querySelector('a[href="/agents/codex/runs/run-1"]')?.textContent,
    ).toBe("View run");
  });

  it("keeps Try again available without retry instructions in the detail", async () => {
    const onTryAgain = vi.fn();
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatMarker
            item={{
              id: "run-1:failure",
              kind: "marker",
              variant: "interrupted",
              label: "Run failed",
              detail: "The runner stopped before returning an answer.",
              collapsible: true,
            }}
            onTryAgain={onTryAgain}
          />
        </ThemeProvider>,
      ),
    );

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-run-failed-try-again"]',
    )!;
    expect(container.textContent).not.toContain("You can retry this message now");
    flushSync(() => retry.click());
    await Promise.resolve();
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it("routes Try again to the failed run retry callback", async () => {
    const onRetryFailedRun = vi.fn();
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatThreadView
            scroll={false}
            items={[
              {
                id: "run-1:failure",
                kind: "marker",
                variant: "interrupted",
                label: "Run failed",
                detail: "The runner stopped before returning an answer.",
                collapsible: true,
                runId: "run-1",
              },
            ]}
            onRetryFailedRun={onRetryFailedRun}
          />
        </ThemeProvider>,
      ),
    );

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-run-failed-try-again"]',
    )!;
    expect(retry).not.toBeNull();
    flushSync(() => retry.click());
    await Promise.resolve();
    expect(onRetryFailedRun).toHaveBeenCalledWith("run-1");
  });
});
