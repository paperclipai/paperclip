// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import {
  reorderQueuedMessageEntries,
  TaskChatQueuedMessages,
} from "./TaskChatQueuedMessages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const queue: IssueQueuedCommentQueue = {
  issueId: "issue-1",
  queueId: "wake-1",
  state: "deferred",
  targetRunId: "run-1",
  revision: "rev-1",
  protocol: "paperclip_runner_v1",
  steeringDisposition: "available",
  entries: ["First queued message", "Second queued message"].map(
    (body, position) => ({
      comment: {
        id: `comment-${position + 1}`,
        companyId: "company-1",
        issueId: "issue-1",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        body,
        presentation: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      position,
      canEdit: true,
      canDiscard: true,
    }),
  ),
};

describe("TaskChatQueuedMessages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    flushSync(() => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  function render(
    overrides: Partial<ComponentProps<typeof TaskChatQueuedMessages>> = {},
  ) {
    const props = {
      queue,
      onEdit: vi.fn(),
      onReorder: vi.fn().mockResolvedValue(undefined),
      onSteer: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    flushSync(() => root.render(<TaskChatQueuedMessages {...props} />));
    return props;
  }

  it("shows the saved message's wait reason and removes it when admission succeeds", () => {
    const message = "Waiting for the previous environment to stop. Your message will start automatically.";
    render({ queue: { ...queue, executionWait: { reason: "remote_cleanup", message } } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(message);
    expect(container.textContent).toContain("First queued message");
    render();
    expect(container.textContent).not.toContain(message);
  });

  it("renders each queued message once as a compact one-line row", () => {
    render();
    const pane = container.querySelector(
      '[data-testid="task-chat-queued-messages"]',
    );
    expect(pane?.classList).toContain("mx-3");
    expect(pane?.classList).toContain("rounded-b-none");
    expect(pane?.classList).toContain("border-b-0");
    expect(pane?.classList).toContain("-mb-px");
    expect(
      container.querySelectorAll('[data-testid^="task-chat-queued-message-"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain("Second queued message");
  });

  it.each(["legacy", "native", "native-plan"] as const)("shows a read-only response and sends it only on click for %s", async (runtime) => {
    const entry = { ...queue.entries[0], canEdit: false, canDiscard: false,
      comment: { ...queue.entries[0].comment, body: 'Accepted: Build the app\n\n{"revision": "v1"}' },
      source: { kind: "interaction" as const, interactionId: "confirmation-1", interactionKind: "request_confirmation",
        requiresFreshSession: runtime === "native-plan" } };
    const props = render({ queue: { ...queue, entries: [entry],
      protocol: runtime === "legacy" ? "legacy" : "paperclip_runner_v1" },
      onInterrupt: vi.fn().mockResolvedValue(undefined) });
    expect(props.onSteer).not.toHaveBeenCalled();
    expect(props.onInterrupt).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Accepted: Build the app");
    expect(container.textContent).not.toContain('"revision"');
    expect(container.querySelector<HTMLButtonElement>('[aria-label^="Reorder"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid^="task-chat-queued-discard-"]')?.disabled).toBe(true);
    expect(reorderQueuedMessageEntries([entry, queue.entries[1]], "comment-1", "comment-2")).toBeNull();
    const action = runtime === "native" ? "steer" : "interrupt";
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-${action}-comment-1"]`)!.click(); });
    if (action === "steer") expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    else expect(props.onInterrupt).toHaveBeenCalledOnce();
  });

  it("reorders the complete queue and rewrites contiguous positions", () => {
    const next = reorderQueuedMessageEntries(
      queue.entries,
      "comment-2",
      "comment-1",
    );

    expect(next?.map((entry) => entry.comment.id)).toEqual([
      "comment-2",
      "comment-1",
    ]);
    expect(next?.map((entry) => entry.position)).toEqual([0, 1]);
  });

  it("removes the selected steering row before the provider acknowledges it", async () => {
    const acknowledgement = deferred<void>();
    const props = render({
      onSteer: vi.fn().mockReturnValue(acknowledgement.promise),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-steer-comment-1"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain("Steering queued message.");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-2"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      render({ ...props, queue: { ...queue, entries: [...queue.entries] } });
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
  });

  it("clears the entire interrupt queue immediately and restores it inline on failure", async () => {
    let rejectInterrupt!: (error: Error) => void;
    const interrupted = new Promise<void>((_, reject) => { rejectInterrupt = reject; });
    const props = render({ queue: { ...queue, protocol: "legacy", steeringDisposition: "unsupported" },
      onInterrupt: vi.fn().mockReturnValue(interrupted) });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click();
    });
    expect(props.onInterrupt).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    await act(async () => { rejectInterrupt(new Error("Connection lost")); await interrupted.catch(() => undefined); });
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(2);
    expect(container.textContent).toContain("Couldn’t interrupt. Message is still queued.");
  });

  it.each(["steer", "interrupt"] as const)("shows a delivery error even when the queue becomes empty while %s is pending", async action => {
    const delivery = deferred<void>();
    const props = render({ queue: { ...queue, protocol: action === "interrupt" ? "legacy" : "paperclip_runner_v1" },
      onSteer: vi.fn().mockReturnValue(delivery.promise), onInterrupt: vi.fn().mockReturnValue(delivery.promise) });
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-${action}-comment-1"]`)!.click(); });
    await act(async () => { render({ ...props, queue: { ...props.queue, revision: "empty-poll", entries: [] } }); });
    await act(async () => { delivery.reject(new Error("Connection lost")); await delivery.promise.catch(() => undefined); });
    const error = action === "steer" ? "Couldn’t steer." : "Couldn’t interrupt.";
    expect([...container.querySelectorAll('[role="status"]')].some(status => status.textContent?.includes(error))).toBe(true);
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
  });

  it("does not restore a message discarded elsewhere while steering was pending", async () => {
    let rejectSteer!: (error: Error) => void;
    const delivery = new Promise<void>((_, reject) => { rejectSteer = reject; });
    const props = render({ onSteer: vi.fn().mockReturnValue(delivery) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')!.click(); });
    await act(async () => { render({ ...props, queue: { ...queue, revision: "rev-2", entries: [queue.entries[1]] } }); });
    await act(async () => { rejectSteer(new Error("Queue changed")); await delivery.catch(() => undefined); });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-2"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn’t steer.");
  });

  it("keeps a row queued when steering fails and announces the retryable state", async () => {
    render({
      onSteer: vi.fn().mockRejectedValue(new Error("steering_timeout")),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-steer-comment-1"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Couldn’t steer. Message is still queued.",
    );
  });

  it("disables steering when the provider does not advertise it", () => {
    render({ queue: { ...queue, steeringDisposition: "unsupported" } });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-queued-steer-comment-1"]',
      )?.disabled,
    ).toBe(true);
  });

  it("waits for authoritative discard acknowledgement before removing the row", async () => {
    const acknowledgement = deferred<void>();
    render({ onDiscard: vi.fn().mockReturnValue(acknowledgement.promise) });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-comment-1"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Queued message discarded.");

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain("Queued message discarded.");
  });

  it("keeps a too-late discard visible with an explicit error", async () => {
    render({
      onDiscard: vi.fn().mockRejectedValue({
        body: { details: { code: "queued_comment_already_dispatching" } },
      }),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-comment-1"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Too late to discard: this message is already being sent.",
    );
  });

  it("shows stale revisions without announcing a discard", async () => {
    render({
      onDiscard: vi.fn().mockRejectedValue({
        body: { details: { code: "queued_comment_revision_conflict" } },
      }),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-comment-1"]',
        )
        ?.click();
    });
    expect(container.textContent).toContain(
      "The queue changed in another session. Review it and try again.",
    );
    expect(container.textContent).not.toContain("Queued message discarded.");
  });

  it("does not expose queue controls before a real queue id is acknowledged", () => {
    const props = render({ queue: { ...queue, queueId: null, state: null } });
    const discard = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-discard-comment-1"]',
    );
    expect(discard?.disabled).toBe(true);
    discard?.click();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("can discard a local optimistic row before the queue id is acknowledged", async () => {
    const optimisticQueue = {
      ...queue,
      queueId: null,
      state: "deferred" as const,
      entries: [
        {
          ...queue.entries[0],
          comment: {
            ...queue.entries[0].comment,
            id: "optimistic-local-1",
          },
        },
      ],
    };
    const props = render({ queue: optimisticQueue });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-optimistic-local-1"]',
        )
        ?.click();
    });

    expect(props.onDiscard).toHaveBeenCalledWith("optimistic-local-1", "rev-1");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-optimistic-local-1"]',
      ),
    ).toBeNull();
  });

  it.each(["run-1", null])("delivers legacy queued messages with target %s", async (targetRunId) => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    render({
      queue: {
        ...queue,
        targetRunId,
        protocol: "legacy",
        steeringDisposition: "unsupported",
      },
      onInterrupt,
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-interrupt-comment-1"]',
        )
        ?.click();
    });

    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-steer-comment-1"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).toBeNull();
  });

  it("retranslates a stopped queue's wait without changing messages or sending them", async () => {
    const onInterrupt = vi.fn();
    const props = render({ queue: { ...queue, protocol: "legacy", targetRunId: null,
      executionWait: { reason: "remote_cleanup", message: "Waiting for the previous environment to stop. Your message will start automatically." } }, onInterrupt });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]');
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBe(row);
      expect(row?.textContent).toContain("First queued message");
      expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')?.title)
        .toBe(locale === "ru" ? "Отправить сообщения из очереди сейчас" : "Send queued messages now");
      const message = container.querySelector('[role="status"]')?.textContent;
      expect(message).toBe(locale === "en"
        ? "Waiting for the previous environment to stop. Your message will start automatically."
        : i18n.t("sep13QueueMetadata.remoteCleanup"));
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(props.onSteer).not.toHaveBeenCalled();
      expect(props.onDiscard).not.toHaveBeenCalled();
    }
  });

  it("keeps the optimistically sent queue absent across locale changes without repeating the action", async () => {
    const acknowledgement = deferred<void>();
    const onInterrupt = vi.fn().mockReturnValue(acknowledgement.promise);
    const originalQueue = JSON.stringify(queue);
    const props = render({ queue: { ...queue, protocol: "legacy", steeringDisposition: "unsupported" }, onInterrupt });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]');
    const interrupt = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!;
    await act(async () => interrupt.click());
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.contains(row)).toBe(false);
    expect(container.querySelector('[data-testid="task-chat-queued-interrupt-comment-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    await act(async () => { acknowledgement.resolve(); await acknowledgement.promise; });
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
      expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
      expect(row?.textContent).toContain("First queued message");
      expect(JSON.stringify(queue)).toBe(originalQueue);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(props.onReorder).not.toHaveBeenCalled();
      expect(props.onSteer).not.toHaveBeenCalled();
      expect(props.onDiscard).not.toHaveBeenCalled();
    }
  });

  it("retranslates a retained discard announcement without replaying the action or rebuilding unaffected rows", async () => {
    const acknowledgement = deferred<void>();
    const onDiscard = vi.fn().mockReturnValue(acknowledgement.promise);
    const originalQueue = JSON.stringify(queue);
    const props = render({ onDiscard });
    const unaffected = container.querySelector('[data-testid="task-chat-queued-message-comment-2"]');
    const discard = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')!;
    await act(async () => discard.click());
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(discard.disabled).toBe(true);
    expect(container.querySelector(".sr-only")?.textContent).toBe("Сообщение удаляется из очереди.");
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-2"]')).toBe(unaffected);
    await act(async () => { acknowledgement.resolve(); await acknowledgement.promise; });
    for (const language of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
      expect(container.querySelector('[data-testid="task-chat-queued-message-comment-2"]')).toBe(unaffected);
      expect(container.querySelector(".sr-only")?.textContent).toBe(language === "ru"
        ? "Сообщение удалено из очереди." : "Queued message discarded.");
      expect(unaffected?.textContent).toContain("Second queued message");
      expect(JSON.stringify(queue)).toBe(originalQueue);
      expect(onDiscard).toHaveBeenCalledExactlyOnceWith("comment-1", "rev-1");
      expect(props.onReorder).not.toHaveBeenCalled();
      expect(props.onSteer).not.toHaveBeenCalled();
    }
  });
});
