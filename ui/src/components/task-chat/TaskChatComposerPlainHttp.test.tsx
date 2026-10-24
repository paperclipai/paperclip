// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskChatComposer } from "./TaskChatComposer";

const editorProps = vi.hoisted(() => ({
  imageUploadHandler: null as ((file: File) => Promise<string>) | null,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    { value, imageUploadHandler }: { value: string; imageUploadHandler?: (file: File) => Promise<string> },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {}, clear: () => {} }));
    editorProps.imageUploadHandler = imageUploadHandler ?? null;
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
  editorProps.imageUploadHandler = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("uploads an inline image on plain HTTP when randomUUID is unavailable", async () => {
  const originalCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
  const id = "5e5f9946-c706-4785-8988-d4d6f0f499ab";
  const onAttachImage = vi.fn().mockResolvedValue({
    id,
    contentPath: `/api/attachments/${id}/content`,
    originalFilename: "image.png",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(
    <TaskChatComposer onAdd={vi.fn()} workMode="standard" onAttachImage={onAttachImage} />,
  ));

  let url: string | undefined;
  await act(async () => {
    url = await editorProps.imageUploadHandler!(new File(["png"], "image.png", { type: "image/png" }));
  });

  expect(onAttachImage).toHaveBeenCalledTimes(1);
  expect(url).toBe(`/api/attachments/${id}/content`);
});
