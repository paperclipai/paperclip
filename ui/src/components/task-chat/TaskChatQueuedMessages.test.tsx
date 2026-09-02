// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import { TaskChatQueuedMessages } from "./TaskChatQueuedMessages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const queue: IssueQueuedCommentQueue = {
  issueId: "issue-1",
  queueId: "wake-1",
  state: "deferred",
  targetRunId: "run-1",
  revision: "rev-1",
  protocol: "paperclip_runner_v1",
  steeringDisposition: "available",
  entries: ["First queued message", "Second queued message"].map((body, position) => ({
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
  })),
};

describe("TaskChatQueuedMessages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function render(overrides: Partial<ComponentProps<typeof TaskChatQueuedMessages>> = {}) {
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

  it("renders each queued message once as a compact one-line row", () => {
    render();
    const pane = container.querySelector('[data-testid="task-chat-queued-messages"]');
    expect(pane?.classList).toContain("mx-3");
    expect(pane?.classList).toContain("rounded-b-none");
    expect(pane?.classList).toContain("border-b-0");
    expect(pane?.classList).toContain("-mb-px");
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(2);
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain("Second queued message");
  });

  it("removes only the acknowledged steering row", async () => {
    const props = render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')?.click();
    });
    expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-2"]')).not.toBeNull();
  });

  it("keeps a row queued when steering fails and announces the retryable state", async () => {
    render({ onSteer: vi.fn().mockRejectedValue(new Error("steering_timeout")) });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')?.click();
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn’t steer. Message is still queued.");
  });

  it("disables steering when the provider does not advertise it", () => {
    render({ queue: { ...queue, steeringDisposition: "unsupported" } });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')?.disabled)
      .toBe(true);
  });

  it("waits for authoritative discard acknowledgement before removing the row", async () => {
    const acknowledgement = deferred<void>();
    render({ onDiscard: vi.fn().mockReturnValue(acknowledgement.promise) });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Queued message discarded.");

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
    expect(container.textContent).toContain("Queued message discarded.");
  });

  it("keeps a too-late discard visible with an explicit error", async () => {
    render({
      onDiscard: vi.fn().mockRejectedValue({
        body: { details: { code: "queued_comment_already_dispatching" } },
      }),
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')?.click();
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).not.toBeNull();
    expect(container.textContent).toContain("Too late to discard: this message is already being sent.");
  });

  it("shows stale revisions without announcing a discard", async () => {
    render({
      onDiscard: vi.fn().mockRejectedValue({
        body: { details: { code: "queued_comment_revision_conflict" } },
      }),
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')?.click();
    });
    expect(container.textContent).toContain("The queue changed in another session. Review it and try again.");
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

});
