// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTranslationDomGuard } from "./translation-dom-guard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function translateTextNode(textNode: Text, translated: string) {
  document.documentElement.classList.add("translated-ltr");
  const font = document.createElement("font");
  font.appendChild(document.createTextNode(translated));
  textNode.parentNode!.replaceChild(font, textNode);
  return font;
}

function translateTextNodeInTwoSteps(textNode: Text, translated: string) {
  document.documentElement.classList.add("translated-ltr");
  const font = document.createElement("font");
  font.appendChild(document.createTextNode(translated));
  textNode.parentNode!.insertBefore(font, textNode);
  textNode.parentNode!.removeChild(textNode);
  return font;
}

function wrapTextNode(textNode: Text) {
  document.documentElement.classList.add("translated-ltr");
  const font = document.createElement("font");
  textNode.parentNode!.replaceChild(font, textNode);
  font.appendChild(textNode);
  return font;
}

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

function Pair({ showLeft }: { showLeft: boolean }) {
  return <p>{showLeft ? "Left" : null}{"Right"}</p>;
}

function textNodes(element: Element): Text[] {
  return Array.from(element.childNodes).filter((node): node is Text => node.nodeType === Node.TEXT_NODE);
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

  it("removes the translated replacement when React removes a detached text node", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Status done={false} />));
    const font = translateTextNode(firstTextNode(container.querySelector("p")!), "En curso");
    expect(() => act(() => root.render(<Status done />))).not.toThrow();
    expect(font.isConnected).toBe(false);
    expect(container.textContent).toBe("end");
    act(() => root.render(<Status done={false} />));
    expect(container.textContent).toBe("Runningend");
  });

  it("removes a replacement that translation inserted and detached in separate steps", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Status done={false} />));
    const font = translateTextNodeInTwoSteps(firstTextNode(container.querySelector("p")!), "En curso");
    act(() => root.render(<Status done />));
    expect(font.isConnected).toBe(false);
    expect(container.textContent).toBe("end");
  });

  it("keeps a neighbor's translation when adjacent text nodes are translated right to left", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Pair showLeft />));
    const [left, right] = textNodes(container.querySelector("p")!);
    const rightFont = translateTextNodeInTwoSteps(right, "Derecha");
    const leftFont = translateTextNodeInTwoSteps(left, "Izquierda");
    act(() => root.render(<Pair showLeft={false} />));
    expect(leftFont.isConnected).toBe(false);
    expect(rightFont.isConnected).toBe(true);
    expect(container.textContent).toBe("Derecha");
  });

  it("keeps a neighbor's translation when adjacent text nodes are translated left to right", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Pair showLeft />));
    const [left, right] = textNodes(container.querySelector("p")!);
    const leftFont = translateTextNodeInTwoSteps(left, "Izquierda");
    const rightFont = translateTextNodeInTwoSteps(right, "Derecha");
    act(() => root.render(<Pair showLeft={false} />));
    expect(leftFont.isConnected).toBe(false);
    expect(rightFont.isConnected).toBe(true);
    expect(container.textContent).toBe("Derecha");
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

  it("inserts before the translated replacement of a detached reference node", () => {
    stop = startTranslationDomGuard();
    act(() => root.render(<Toggle show={false} />));
    const paragraph = container.querySelector("p")!;
    const font = translateTextNode(firstTextNode(paragraph), "En curso");
    expect(() => act(() => root.render(<Toggle show />))).not.toThrow();
    expect(paragraph.firstChild).toBe(container.querySelector("i"));
    expect(paragraph.lastChild).toBe(font);
  });

  it("appends when a detached reference node has no translated replacement", () => {
    stop = startTranslationDomGuard();
    document.documentElement.classList.add("translated-ltr");
    const parent = document.createElement("div");
    parent.appendChild(document.createElement("span"));
    const detached = document.createTextNode("gone");
    const added = document.createElement("i");
    expect(parent.insertBefore(added, detached)).toBe(added);
    expect(parent.lastChild).toBe(added);
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
