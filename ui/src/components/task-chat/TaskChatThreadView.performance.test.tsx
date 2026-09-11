// @vitest-environment jsdom

import { memo } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskChatThreadView } from "./TaskChatThreadView";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import type { TaskChatItem, TaskChatMessageItem } from "./task-chat-model";

const renders = vi.hoisted(() => vi.fn());
vi.mock("@/components/MarkdownBody", () => ({
  // Preserve the real markdown component's memo contract while counting work.
  MarkdownBody: memo((props: { children: string; onImageClick?: (src: string) => void }) => {
    renders(props.children);
    return <button onClick={() => props.onImageClick?.("image.png")}>{props.children}</button>;
  }),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  renders.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const history: TaskChatMessageItem[] = Array.from({ length: 200 }, (_, index) => ({
  id: `message-${index}`, kind: "message", author: "agent", text: `Response ${index}`,
}));

it("does no historical render work for a live-tail-only update", () => {
  const actions = vi.fn(() => null);
  const render = (tick: number) => flushSync(() => root.render(
    <TaskChatThreadView items={history} scroll={false} renderMessageActions={actions} tail={<p>Live {tick}</p>} />,
  ));
  render(0);
  renders.mockClear();
  actions.mockClear();
  for (let tick = 1; tick <= 10; tick++) render(tick);
  expect(renders).not.toHaveBeenCalled();
  expect(actions).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Live 10");
});

it("does not reparse unchanged markdown when transcript projection recreates rows", () => {
  const render = (items: TaskChatItem[]) => flushSync(() => root.render(
    <TaskChatThreadView items={items} scroll={false} />,
  ));
  render(history);
  renders.mockClear();
  for (let tick = 0; tick < 10; tick++) render(history.map((item) => ({ ...item })));
  expect(renders).not.toHaveBeenCalled();
  render(history.map((item, index) => index === 199 ? { ...item, text: "Edited response" } : item));
  expect(renders).toHaveBeenCalledExactlyOnceWith("Edited response");
  expect(host.textContent).toContain("Edited response");
});

it("uses the current gallery callback after the provider changes", () => {
  const firstGallery = vi.fn(() => true);
  const nextGallery = vi.fn(() => true);
  const render = (gallery: (src: string) => boolean) => flushSync(() => root.render(
    <IssueGalleryContext.Provider value={gallery}>
      <TaskChatThreadView items={history.slice(0, 1)} scroll={false} />
    </IssueGalleryContext.Provider>,
  ));
  render(firstGallery);
  flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click());
  render(nextGallery);
  flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(firstGallery).toHaveBeenCalledExactlyOnceWith("image.png");
  expect(nextGallery).toHaveBeenCalledExactlyOnceWith("image.png");
});
