// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePageEnterMotion } from "./usePageEnterMotion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Page({ motionKey }: { motionKey: string }) {
  const ref = useRef<HTMLElement | null>(null);
  usePageEnterMotion(ref, motionKey);
  return <main ref={ref} />;
}

let root: Root;
let container: HTMLDivElement;
const render = (key: string) => act(async () => root.render(<Page motionKey={key} />));
const entering = () => container.querySelector("main")!.hasAttribute("data-page-enter");

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("does not animate the first page load", async () => {
  await render("issues");
  expect(entering()).toBe(false);
});

it("marks the page while a new page enters, then clears the mark", async () => {
  await render("issues");
  await render("agents");
  expect(entering()).toBe(true);
  await act(async () => vi.runAllTimers());
  expect(entering()).toBe(false);
});

it("does not animate when the page stays the same", async () => {
  await render("issues");
  await render("issues");
  expect(entering()).toBe(false);
});

it("gives a second quick navigation its full entry time", async () => {
  await render("issues");
  await render("agents");
  await act(async () => vi.advanceTimersByTime(1000));
  await render("goals");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(entering()).toBe(true);
});
