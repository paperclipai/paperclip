// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatThreadView } from "./TaskChatThreadView";
import { TaskChatPresentationProvider } from "./presentation-mode";

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

  it.each(["production", "streamlined"] as const)("renders old failure markers without divider rules in %s mode", (mode) => {
    flushSync(() => root!.render(
      <ThemeProvider>
        <TaskChatPresentationProvider mode={mode}>
          <TaskChatMarker item={{ id: "old", kind: "marker", variant: "interrupted", label: "Run failed", detail: "Saved diagnostic", runHref: "/agents/coder/runs/old" }} />
        </TaskChatPresentationProvider>
      </ThemeProvider>,
    ));
    expect(container.querySelector(".border-dashed, .h-px")).toBeNull();
    expect(container.textContent).toContain("Run failed");
    expect(container.textContent).toContain("Saved diagnostic");
  });

  it.each(["production", "streamlined"] as const)("shows only the last adjacent error and retains retry in %s mode", async (mode) => {
    const retry = vi.fn();
    flushSync(() => root!.render(
      <ThemeProvider>
        <TaskChatPresentationProvider mode={mode}>
          <TaskChatThreadView scroll={false} onRetryFailedRun={retry} items={[
            { id: "notice", kind: "message", author: "system", text: "Paperclip retried continuation, but it still has no live execution path." },
            { id: "failed", kind: "marker", variant: "interrupted", label: "Run failed", collapsible: true, runId: "latest", detail: "Latest failure details" },
          ]} />
        </TaskChatPresentationProvider>
      </ThemeProvider>,
    ));
    expect(container.textContent).toContain("Run failed");
    expect(container.querySelector('[data-testid="task-chat-system-notice"]')).toBeNull();
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]')!.click());
    await Promise.resolve();
    expect(retry).toHaveBeenCalledWith("latest");
  });

  it.each(["production", "streamlined"] as const)("keeps the permitted run retry and its pending state on a later recovery notice in %s mode", async (mode) => {
    const retry = vi.fn();
    const renderNotice = (pending: boolean) => flushSync(() => root!.render(
      <ThemeProvider>
        <TaskChatPresentationProvider mode={mode}>
          <TaskChatThreadView scroll={false} onRetryFailedRun={retry} retryFailedRunId={pending ? "latest" : null} items={[
            { id: "failed", kind: "marker", variant: "interrupted", label: "Run failed", collapsible: true, runId: "latest" },
            { id: "notice", kind: "message", author: "system", text: "Paperclip retried continuation, but it still has no live execution path." },
          ]} />
        </TaskChatPresentationProvider>
      </ThemeProvider>,
    ));
    renderNotice(true);
    expect(container.textContent).not.toContain("Run failed");
    let button = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-no-live-path-try-again"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Trying again...");
    flushSync(() => button.click());
    expect(retry).not.toHaveBeenCalled();
    renderNotice(false);
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    button = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-no-live-path-try-again"]')!;
    expect(button.disabled).toBe(false);
    flushSync(() => button.click());
    await Promise.resolve();
    expect(retry).toHaveBeenCalledExactlyOnceWith("latest");
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
              detail:
                "The runner stopped before returning an answer (runner_exited).",
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
      container.querySelector('a[href="/agents/codex/runs/run-1"]')
        ?.textContent,
    ).toBe("View run");
  });

  it("keeps expected cancellation neutral when collapsed and expanded", () => {
    flushSync(() =>
      root!.render(
        <ThemeProvider>
          <TaskChatMarker
            item={{
              id: "cancelled",
              kind: "marker",
              variant: "interrupted",
              tone: "neutral",
              label: "Run cancelled",
              detail: "Cancelled by you.",
              collapsible: true,
            }}
          />
        </ThemeProvider>,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      "button[aria-expanded]",
    )!;
    expect(toggle.classList).toContain("text-muted-foreground");
    expect(container.querySelector(".text-destructive")).toBeNull();
    flushSync(() => toggle.click());
    expect(container.textContent).toContain("Cancelled by you.");
    expect(container.querySelector(".text-destructive")).toBeNull();
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
    expect(container.textContent).not.toContain(
      "You can retry this message now",
    );
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
