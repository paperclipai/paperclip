// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTranslationDomGuard } from "./translation-dom-guard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Do what Chrome page translation does to a React text node: mark the page as
 * translated, then replace the text node with a `<font>` wrapper that holds
 * the translated text. React still owns the original, now detached, node.
 */
function translateTextNode(textNode: Text, translated: string) {
  document.documentElement.classList.add("translated-ltr");
  const font = document.createElement("font");
  font.appendChild(document.createTextNode(translated));
  textNode.parentNode!.replaceChild(font, textNode);
  return font;
}

/** Chrome can also move the original node into its wrapper. */
function wrapTextNode(textNode: Text) {
  document.documentElement.classList.add("translated-ltr");
  const font = document.createElement("font");
  textNode.parentNode!.replaceChild(font, textNode);
  font.appendChild(textNode);
  return font;
}

/** jsdom and browsers word NotFoundError differently; the name is the contract. */
function expectNotFound(action: () => unknown) {
  expect(action).toThrow(expect.objectContaining({ name: "NotFoundError" }));
}

function firstTextNode(element: Element): Text {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) return node as Text;
  }
  throw new Error("no text node");
}

function Status({ done }: { done: boolean }) {
  return <p>{done ? null : "Running"}<b>end</b></p>;
}

function Toggle({ show }: { show: boolean }) {
  return <p>{show ? <i>new</i> : null}{"Running"}</p>;
}

describe("startTranslationDomGuard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stop?.();
    stop = undefined;
    document.documentElement.classList.remove("translated-ltr", "translated-rtl");
  });

  it("reproduces the translated-page removeChild crash without the guard", () => {
    act(() => root.render(<Status done={false} />));
    translateTextNode(firstTextNode(container.querySelector("p")!), "En curso");
    expect(() => act(() => root.render(<Status done />))).toThrow(/not a child of this node/);
  });

  it("lets React remove a text node that translation already detached", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Status done={false} />));
    translateTextNode(firstTextNode(container.querySelector("p")!), "En curso");
    expect(() => act(() => root.render(<Status done />))).not.toThrow();
    expect(container.querySelector("b")?.textContent).toBe("end");
  });

  it("removes a text node that translation moved into its wrapper", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Status done={false} />));
    const font = wrapTextNode(firstTextNode(container.querySelector("p")!));
    act(() => root.render(<Status done />));
    expect(font.textContent).toBe("");
    expect(container.textContent).toBe("end");
  });

  it("inserts before a reference node that translation moved into its wrapper", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Toggle show={false} />));
    const paragraph = container.querySelector("p")!;
    const font = wrapTextNode(firstTextNode(paragraph));
    act(() => root.render(<Toggle show />));
    expect(paragraph.firstChild).toBe(container.querySelector("i"));
    expect(paragraph.lastChild).toBe(font);
  });

  it("appends when translation detached the reference node", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Toggle show={false} />));
    const paragraph = container.querySelector("p")!;
    translateTextNode(firstTextNode(paragraph), "En curso");
    expect(() => act(() => root.render(<Toggle show />))).not.toThrow();
    expect(paragraph.querySelector("i")?.textContent).toBe("new");
  });

  it("keeps the native errors when the page is not translated", () => {
    stop = startTranslationDomGuard();
    const parent = document.createElement("div");
    const stray = document.createElement("span");
    expectNotFound(() => parent.removeChild(stray));
    expectNotFound(() => parent.insertBefore(document.createElement("i"), stray));
  });

  it("keeps the native errors for nodes outside the parent on a translated page", () => {
    stop = startTranslationDomGuard();
    document.documentElement.classList.add("translated-rtl");
    const parent = document.createElement("div");
    const elsewhere = document.createElement("section");
    const stray = elsewhere.appendChild(document.createElement("span"));
    expectNotFound(() => parent.removeChild(stray));
    expectNotFound(() => parent.insertBefore(document.createElement("i"), stray));
    expect(stray.parentNode).toBe(elsewhere);
  });

  it("installs once and restores the native methods when stopped", () => {
    const nativeRemove = Node.prototype.removeChild;
    const nativeInsert = Node.prototype.insertBefore;
    const first = startTranslationDomGuard();
    const second = startTranslationDomGuard();
    const guardedRemove = Node.prototype.removeChild;
    expect(guardedRemove).not.toBe(nativeRemove);
    second();
    expect(Node.prototype.removeChild).toBe(guardedRemove);
    first();
    expect(Node.prototype.removeChild).toBe(nativeRemove);
    expect(Node.prototype.insertBefore).toBe(nativeInsert);
  });
});
