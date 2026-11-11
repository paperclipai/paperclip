// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import { mergePendingIssueQueuedComments } from "@/lib/issue-queued-comment-queue";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
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

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
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
    flushSync(() => root.render(<MemoryRouter><ThemeProvider><TaskChatQueuedMessages {...props} /></ThemeProvider></MemoryRouter>));
    return props;
  }

  it("keeps saved input visible without duplicating the task status", () => {
    const message = "Waiting for the previous environment to stop. Your message will start automatically.";
    render({ queue: { ...queue, executionWait: { reason: "remote_cleanup", message } } });
    expect(container.textContent).not.toContain(message);
    expect(container.textContent).toContain("First queued message");
    render();
    expect(container.textContent).not.toContain(message);
  });

  it("says why a chat message held in the outbox waits, without offering queue actions", () => {
    const message = "CEO reached its daily run limit. Your message is saved and sends automatically when the limit resets at 00:00 UTC.";
    render({ queue: { ...queue, queueId: null, targetRunId: null, steeringDisposition: "unsupported",
      executionWait: { reason: "heartbeat.daily_run_limit", message },
      entries: queue.entries.slice(0, 1).map(entry => ({ ...entry, canEdit: false, canDiscard: false })) } });
    expect([...container.querySelectorAll('p[role="status"]')].map(node => node.textContent)).toEqual([message]);
    expect(container.textContent).toContain("First queued message");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')?.disabled ?? true).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')?.disabled).toBe(true);
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

  it("renders queued Markdown and screenshot thumbnails without showing image syntax", () => {
    const body = "Check **mobile** and *desktop* with `pnpm verify`.\n\n![mobile.png](/api/attachments/mobile/content)\n![desktop.png](/api/attachments/desktop/content)";
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')!;
    expect(row.querySelector("strong")?.textContent).toBe("mobile");
    expect(row.querySelector("em")?.textContent).toBe("desktop");
    expect(row.querySelector("code")?.textContent).toBe("pnpm verify");
    expect([...row.querySelectorAll("img")].map(img => [img.alt, img.getAttribute("src")])).toEqual([
      ["mobile.png", "/api/attachments/mobile/content"],
      ["desktop.png", "/api/attachments/desktop/content"],
    ]);
    expect(row.textContent).not.toContain("![");
    expect(row.textContent).not.toContain("/api/attachments");
  });

  it("shows a thumbnail for an image-only queued message", () => {
    const body = "![screen.png](/api/attachments/screen/content)";
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    expect(container.querySelector('img[alt="screen.png"]')?.getAttribute("src")).toBe("/api/attachments/screen/content");
    expect(container.textContent).not.toContain(body);
  });

  it("only loads local attachment images and counts the remaining screenshots", () => {
    const urls = [
      "/api/attachments/first/content", "/api/assets/second/content?download=0",
      "/api/attachments/third/content", "/api/attachments/fourth/content",
      "https://other.example/api/attachments/pixel/content", "//other.example/pixel.png",
      "javascript:alert", "data:image/png;base64,AAAA", "/other/pixel.png",
      "/api/attachments/first/content/extra", "/api/attachments/first/content#fragment",
    ];
    const body = urls.map((url, index) => `![screen-${index}](${url})`).join("\n");
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')!;
    expect([...row.querySelectorAll("img")].map(image => image.getAttribute("src"))).toEqual(urls.slice(0, 3));
    expect(row.querySelector('[aria-label="Queued images"]')?.textContent).toBe("+1");
  });

  it("omits inline images from the compact text without exposing their URLs", () => {
    const body = "Check ![inline](/api/attachments/inline/content) then **retry**.";
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')!;
    expect(row.querySelector("strong")?.textContent).toBe("retry");
    expect(row.textContent).toContain("Check  then retry.");
    expect(row.textContent).not.toContain("/api/attachments");
    expect(row.querySelector("img")).toBeNull();
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

  it("shows a declined connection request as readable text, never its raw JSON receipt (BUG-08)", () => {
    const receipt = JSON.stringify({ interactionId: "slack-1", kind: "connection_intent", status: "rejected",
      payload: { serviceSlug: "slack", serviceName: "Slack" }, result: { outcome: "declined" } }, null, 2);
    const entry = { ...queue.entries[0], canEdit: false, canDiscard: false,
      comment: { ...queue.entries[0].comment, id: "slack-1", body: `Rejected: Connect Slack\n\n${receipt}` },
      source: { kind: "interaction" as const, interactionId: "slack-1", interactionKind: "connection_intent",
        summary: "Declined: Slack connection" } };
    render({ queue: { ...queue, entries: [entry], steeringDisposition: "temporarily_unavailable" } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-slack-1"]')!;
    const hoverAndLabels = [...row.querySelectorAll("[title], [aria-label]")]
      .flatMap((element) => [element.getAttribute("title"), element.getAttribute("aria-label")])
      .filter((text): text is string => Boolean(text));
    expect(hoverAndLabels.length).toBeGreaterThan(0);
    for (const text of hoverAndLabels) {
      expect(text).not.toContain("{");
      expect(text).not.toContain("interactionId");
    }
    expect(row.textContent).toContain("Declined: Slack connection");
    expect(row.querySelector('[title="Declined: Slack connection"]')).not.toBeNull();
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

  it.each(["temporarily_unavailable", "unsupported"] as const)(
    "offers an explicit interrupt fallback when native steering is %s",
    async (steeringDisposition) => {
      const props = render({
        queue: { ...queue, steeringDisposition },
        onInterrupt: vi.fn().mockResolvedValue(undefined),
      });
      const interrupt = container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-queued-interrupt-comment-1"]',
      );
      expect(interrupt).not.toBeNull();
      expect(interrupt!.disabled).toBe(false);
      expect(interrupt!.textContent).toContain("Interrupt");
      await act(async () => { interrupt!.click(); });
      expect(props.onInterrupt).toHaveBeenCalledOnce();
      expect(props.onSteer).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    },
  );

  it("keeps same-turn steering when the provider is available, even with an interrupt callback", async () => {
    const props = render({ onInterrupt: vi.fn().mockResolvedValue(undefined) });
    expect(container.querySelector('[data-testid="task-chat-queued-interrupt-comment-1"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')!.click();
    });
    expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(props.onInterrupt).not.toHaveBeenCalled();
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

  it.each(["wake-1", null])("keeps a too-late discard visible with an explicit error (queue=%s)", async (queueId) => {
    render({
      queue: { ...queue, queueId },
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

  it("can discard a saved message while queue acknowledgement is pending", async () => {
    const merged = mergePendingIssueQueuedComments({
      issueId: queue.issueId,
      authoritativeQueue: queue,
      pendingComments: [{
        comment: { ...queue.entries[0].comment, id: "optimistic-next" },
        targetRunId: queue.targetRunId,
      }],
      fallbackProtocol: queue.protocol,
    })!;
    expect(merged.queueId).toBeNull();
    const props = render({ queue: merged });
    const discard = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-discard-comment-1"]',
    );
    expect(discard?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-steer-comment-1"]',
    )?.disabled).toBe(true);
    await act(async () => { discard!.click(); });
    expect(props.onDiscard).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
  });

  it("keeps another author's saved message protected while acknowledgement is pending", () => {
    const props = render({
      queue: {
        ...queue,
        queueId: null,
        entries: [{ ...queue.entries[0], canDiscard: false }],
      },
    });
    const discard = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-discard-comment-1"]',
    );
    expect(discard?.disabled).toBe(true);
    discard!.click();
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

  it("delivers legacy queued messages to a live target", async () => {
    const targetRunId = "run-1";
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
  it("keeps deferred sends visible and explains their current wait", async () => {
    const saved = { ...queue, targetRunId: null, executionWait: { reason: "decision_pending", message: "Resolve the pending approval before sending." } };
    const onInterrupt = vi.fn().mockResolvedValue(saved);
    render({ queue: saved, onInterrupt });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click(); });
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain(saved.executionWait.message);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')?.disabled).toBe(false);
  });
  it("clears a deferred wait message when a refreshed queue finishes sending", async () => {
    const saved = { ...queue, targetRunId: null, executionWait: { reason: "decision_pending", message: "Resolve the pending approval before sending." } };
    render({ queue: saved, onInterrupt: vi.fn().mockResolvedValue(saved) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click(); });
    expect(container.textContent).toContain(saved.executionWait.message);
    render({ queue: { ...saved, queueId: null, entries: [], state: null, executionWait: null } });
    await act(async () => {});
    expect(container.textContent).not.toContain(saved.executionWait.message);
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
  });
  it.each(["legacy", "paperclip_runner_v1"] as const)("sends a saved %s queue explicitly after Stop", async (protocol) => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    render({ queue: { ...queue, targetRunId: null, protocol, steeringDisposition: "temporarily_unavailable" }, onInterrupt });
    expect(onInterrupt).not.toHaveBeenCalled();
    const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]');
    expect(send?.textContent).toBe("Send");
    expect(send?.getAttribute("aria-label")).toBe("Send queued messages");
    expect(send?.disabled).toBe(false);
    await act(async () => { send!.click(); });
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="task-chat-queued-steer-comment-1"]')).toBeNull();
  });


  describe("automatic steering", () => {
    const delay = 5_000;
    const fresh = (overrides: Partial<IssueQueuedCommentQueue> = {}): IssueQueuedCommentQueue => {
      const at = new Date(Date.now());
      return { ...queue, ...overrides, entries: queue.entries.slice(0, 1).map(entry => ({
        ...entry, comment: { ...entry.comment, createdAt: at, updatedAt: at } })) };
    };
    const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
    const countdown = () => container.querySelector('[data-testid="task-chat-queued-auto-steer-comment-1"]');

    beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-11-07T12:00:00Z") }); });
    afterEach(() => { vi.useRealTimers(); });

    it("shows a countdown with Edit and Cancel, then steers into the live turn", async () => {
      const props = render({ queue: fresh(), autoSteerDelayMs: delay });
      expect(countdown()?.textContent).toContain("Sending in 5s");
      expect(container.querySelector('[data-testid="task-chat-queued-steer-comment-1"]')).toBeNull();
      await advance(2_100);
      expect(countdown()?.textContent).toContain("Sending in 3s");
      expect(props.onSteer).not.toHaveBeenCalled();
      await advance(3_000);
      expect(props.onSteer).toHaveBeenCalledOnce();
      expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    });

    it("gives a saved edit a full window while another row's countdown keeps the clock running", async () => {
      const start = Date.now();
      const twoRows: IssueQueuedCommentQueue = { ...queue, entries: queue.entries.slice(0, 2).map((entry, index) => {
        const at = new Date(start + index * 4_000);
        return { ...entry, comment: { ...entry.comment, createdAt: at, updatedAt: at } };
      }) };
      // comment-1 counts down first; the person opens it for editing at 1 s.
      const props = render({ queue: twoRows, autoSteerDelayMs: delay });
      await advance(1_000);
      await act(async () => { render({ ...props, editingCommentId: "comment-1" }); });
      // comment-2 counts down to start + 9 s and keeps the clock ticking past
      // comment-1's old deadline.
      await advance(5_000);
      expect(props.onSteer).not.toHaveBeenCalled();
      const saved = { ...twoRows, revision: "rev-2", entries: twoRows.entries.map((entry, index) => index === 0
        ? { ...entry, comment: { ...entry.comment, body: "Edited", updatedAt: new Date(Date.now()) } } : entry) };
      await act(async () => { render({ ...props, queue: saved, editingCommentId: null }); });
      await advance(500);
      expect(props.onSteer).not.toHaveBeenCalledWith("comment-1", expect.anything());
      expect(countdown()?.textContent).toContain("Sending in");
      await advance(5_000);
      expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-2");
    });

    it("keeps a cancelled message in the queue with its explicit Steer button", async () => {
      const props = render({ queue: fresh(), autoSteerDelayMs: delay });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-auto-steer-cancel-comment-1"]')?.click();
        await Promise.resolve();
      });
      await advance(10_000);
      expect(props.onSteer).not.toHaveBeenCalled();
      expect(countdown()).toBeNull();
      expect(container.querySelector('[data-testid="task-chat-queued-steer-comment-1"]')).not.toBeNull();
    });

    it("waits while the message is being edited and restarts from the saved revision", async () => {
      const queued = fresh();
      const props = render({ queue: queued, autoSteerDelayMs: delay });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-auto-steer-edit-comment-1"]')?.click();
        await Promise.resolve();
      });
      expect(props.onEdit).toHaveBeenCalledWith("comment-1");
      render({ ...props, editingCommentId: "comment-1" });
      await advance(10_000);
      expect(props.onSteer).not.toHaveBeenCalled();
      // The save changes the comment; its countdown starts again from that change.
      const saved = { ...queued, revision: "rev-2", entries: queued.entries.map(entry => ({
        ...entry, comment: { ...entry.comment, body: "Edited", updatedAt: new Date(Date.now()) } })) };
      await act(async () => { render({ ...props, queue: saved, editingCommentId: null }); });
      expect(countdown()?.textContent).toContain("Sending in 5s");
      await advance(5_100);
      expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-2");
    });

    it("keeps the ordinary queue while steering is unavailable or unsupported", async () => {
      for (const steeringDisposition of ["temporarily_unavailable", "unsupported"] as const) {
        const props = render({ queue: fresh({ steeringDisposition }), autoSteerDelayMs: delay });
        expect(countdown()).toBeNull();
        await advance(10_000);
        expect(props.onSteer).not.toHaveBeenCalled();
      }
    });

    it("tries each message revision once, then leaves it queued after a failure", async () => {
      const props = render({ queue: fresh(), autoSteerDelayMs: delay, onSteer: vi.fn().mockRejectedValue(new Error("rejected")) });
      await advance(5_100);
      await advance(10_000);
      expect(props.onSteer).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Couldn’t steer. Message is still queued.");
      expect(countdown()).toBeNull();
    });

    it("never sends someone else’s message or a saved card response automatically", async () => {
      const notMine = fresh();
      notMine.entries = notMine.entries.map(entry => ({ ...entry, canEdit: false }));
      const card = fresh();
      card.entries = card.entries.map(entry => ({ ...entry, source: { kind: "interaction", summary: "Approved" } as never }));
      for (const candidate of [notMine, card]) {
        const props = render({ queue: candidate, autoSteerDelayMs: delay });
        await advance(10_000);
        expect(props.onSteer).not.toHaveBeenCalled();
      }
    });

    it("stays off unless the caller enables it", async () => {
      const props = render({ queue: fresh() });
      expect(countdown()).toBeNull();
      await advance(10_000);
      expect(props.onSteer).not.toHaveBeenCalled();
    });
  });
});
