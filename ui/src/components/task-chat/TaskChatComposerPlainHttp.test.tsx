// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskChatComposer } from "./TaskChatComposer";

const editorCallbacks = vi.hoisted(() => ({ change: null as ((value: string) => void) | null }));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    { value, onChange }: { value: string; onChange: (value: string) => void },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {}, clear: () => {} }));
    editorCallbacks.change = onChange;
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("sends from the send button on plain HTTP when randomUUID is unavailable", async () => {
  const originalCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
  const onAdd = vi.fn().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TaskChatComposer onAdd={onAdd} workMode="standard" draftKey="plain-http-task" />));

  act(() => editorCallbacks.change?.("please continue"));
  const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!;
  expect(send.disabled).toBe(false);
  await act(async () => {
    send.click();
    await Promise.resolve();
  });

  expect(onAdd).toHaveBeenCalledWith(
    "please continue", undefined, undefined, undefined,
    expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  );
});
