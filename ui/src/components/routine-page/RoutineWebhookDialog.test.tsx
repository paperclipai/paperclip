// @vitest-environment jsdom

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { RoutineDetail, RoutineTrigger } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutinePage } from "./RoutinePage";
import { RoutineWebhookDialog } from "./RoutineWebhookDialog";
import { useRoutineWebhookDialog } from "./useRoutineWebhookDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/routines", () => ({ routinesApi: { updateTrigger: vi.fn(), createTrigger: vi.fn(), rotateTriggerSecret: vi.fn() } }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/TaskSummaryList", () => ({ TaskSummaryList: () => null }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => <a>{children as never}</a> }));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const keyless = {
  id: "webhook-1",
  kind: "webhook",
  label: null,
  enabled: true,
  signingMode: "none",
  setupPending: false,
  webhookUrl: "https://paperclip.example/api/routine-triggers/public/abc/fire",
  lastWebhookDelivery: null,
} as RoutineTrigger;

describe("routine webhook dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("gives a keyless webhook its request instructions without a key", async () => {
    await act(async () => {
      root.render(
        <RoutineWebhookDialog open onOpenChange={() => {}} routineTitle="Digest" trigger={keyless}
          onCreate={() => {}} onReplaceKey={() => {}} onSetPaused={() => {}} onRemove={() => {}} />,
      );
      await flush();
    });
    expect(document.body.textContent).toContain("Its URL is the shared secret");
    // The copyable agent instructions show even though there is no key (their text is covered in webhook-instructions.test.ts).
    expect(document.querySelector('section[aria-label="Agent instructions"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Replace key");
  });

  async function renderRestored(signingMode: string | null) {
    function Harness() {
      const webhook = useRoutineWebhookDialog({ routineId: "routine-1", triggers: [], onChanged: () => {} });
      const { showKeys } = webhook;
      useEffect(() => {
        showKeys([{ triggerId: "webhook-9", webhookUrl: "https://paperclip.example/hook/9", webhookSecret: "restored-secret", signingMode }]);
      }, [showKeys]);
      return <RoutineWebhookDialog {...webhook.dialogProps} routineTitle="Digest" />;
    }
    await act(async () => { root.render(<Harness />); await flush(); });
  }

  it("shows a restored webhook's new key, with instructions for its real signing mode, before the refresh lists it", async () => {
    await renderRestored("hmac_sha256");
    expect(document.body.textContent).not.toContain("Add webhook");
    expect(document.body.textContent).toContain("https://paperclip.example/hook/9");
    expect(document.body.textContent).toContain("Copy it now");
    expect(document.body.textContent).toContain("X-Paperclip-Timestamp");
    expect(document.querySelector('section[aria-label="Agent instructions"]')).not.toBeNull();
  });

  it("withholds signing instructions for a restored webhook whose signing mode is unknown", async () => {
    await renderRestored(null);
    expect(document.body.textContent).toContain("Copy it now");
    expect(document.querySelector('section[aria-label="Agent instructions"]')).toBeNull();
  });
});

describe("routine page instructions", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it("only lets comments anchor to the instructions once the whole text shows", async () => {
    const wrap = vi.fn((body: unknown) => <div data-testid="comment-layer">{body as never}</div>);
    const routine = {
      id: "routine-1", title: "Digest", description: "First paragraph.\n\nSecond paragraph.", status: "active",
      assigneeAgentId: null, triggers: [], variables: [], env: null, concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed", activityGatePolicy: "always", activityGateScope: "company", managedByPlugin: null,
    } as unknown as RoutineDetail;
    const render = (expanded: boolean) => act(async () => {
      root.render(
        <RoutinePage routine={routine} agent={null} project={null} responsibleUser={null} history={[]}
          onToggleActive={() => {}} onEdit={() => {}} onSaveSchedule={() => {}} onRemoveSchedule={() => {}} onOpenWebhook={() => {}}
          renderInstructionsBody={wrap} instructionsExpanded={expanded} />,
      );
      await flush();
    });
    await render(false);
    expect(container.querySelector('[data-testid="comment-layer"]')).toBeNull();
    expect(container.textContent).not.toContain("Second paragraph.");
    await render(true);
    expect(container.querySelector('[data-testid="comment-layer"]')?.textContent).toContain("Second paragraph.");
  });
});
