// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueChatThread } from "./IssueChatThread";
import { TaskChatComposer } from "./task-chat/TaskChatComposer";
import { queryKeys } from "../lib/queryKeys";
import {
  loadDraftSubmission,
  saveDraft,
  saveDraftAttachments,
  saveDraftSubmission,
} from "../lib/composer-draft";

vi.mock("./MarkdownEditor", async () => {
  const { forwardRef, useImperativeHandle, useRef } = await import("react");
  return {
    MarkdownEditor: forwardRef(function Editor(
      { value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly?: boolean },
      ref,
    ) {
      const input = useRef<HTMLTextAreaElement>(null);
      useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), clear: () => onChange("") }));
      return <textarea ref={input} aria-label="Recovery draft" value={value} readOnly={readOnly}
        onChange={event => onChange(event.target.value)} />;
    }),
  };
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

describe.each(["task chat", "legacy thread"] as const)("%s composer recovery", surface => {
  it.each([false, true])("can send the retained draft after an already-reviewed unknown save (reload=%s)", async reload => {
    const key = "reviewed-unknown-save";
    const originalAttemptId = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
    const attachmentId = "5e5f9946-c706-4785-8988-d4d6f0f499ab";
    const body = "I enabled the connection. Please try again.";
    const contentPath = `/api/attachments/${attachmentId}/content`;
    saveDraft(key, body);
    saveDraftAttachments(key, [{ attachmentId, name: "notes.txt", inline: false, contentPath }]);
    // This is the old persisted state shown after Review conversation. It has
    // no replayable request snapshot, so recovery must not blindly resend it.
    saveDraftSubmission(key, { attemptId: originalAttemptId, reviewed: true });
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const composer: ReactElement = surface === "task chat"
      ? <TaskChatComposer onAdd={onAdd} draftKey={key} workMode="standard" />
      : <MemoryRouter><IssueChatThread onAdd={onAdd} draftKey={key}
          comments={[]} linkedRuns={[]} timelineEvents={[]} liveRuns={[]}
          enableLiveTranscriptPolling={false} /></MemoryRouter>;
    const element = <QueryClientProvider client={client}>{composer}</QueryClientProvider>;
    await act(async () => root.render(element));
    if (reload) {
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(element));
    }
    const editor = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Recovery draft"]')!;
    const send = () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')
      ?? Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Send")!;
    expect(editor().value).toBe(body);
    expect(onAdd).not.toHaveBeenCalled();
    const recover = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Cancel");
    expect(recover, "An unknown save must offer a non-destructive way back to the composer").toBeDefined();
    await act(async () => recover!.click());
    expect(editor().readOnly).toBe(false);
    expect(editor().value).toBe(body);
    expect(container.textContent).toContain("notes.txt");
    expect(loadDraftSubmission(key)).toBeNull();
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(`${body}\n\n[notes.txt](${contentPath})`,
      undefined, undefined, [attachmentId], expect.any(String));
    expect(onAdd.mock.calls[0]![4]).not.toBe(originalAttemptId);
    expect(editor().value).toBe("");
    expect(container.textContent).not.toContain("notes.txt");
    // Recovery must leave ordinary sending usable, including after a reload.
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), "One more message");
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(onAdd.mock.calls[1]![0]).toBe("One more message");
    expect(onAdd.mock.calls[1]![4]).not.toBe(onAdd.mock.calls[0]![4]);
  });
});
