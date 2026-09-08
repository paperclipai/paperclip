// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";

import type React from "react";
import {
  OnboardingLoginCard,
  OnboardingCardField,
  onboardingCardInputClass,
} from "./AdapterLoginChrome";

/**
 * The connect step's canvas holds one of two cards, and the credential switch
 * above trades between them. They are two answers to one question, so they have
 * to be built the same way — and the last time they were only *matched*, by
 * restating each other's measurements, they drifted the moment one was redrawn.
 *
 * These tests pin the sharing rather than the appearance. A colour or a radius
 * is the design's to change; what must not change is that both cards get it
 * from the same declaration.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let roots: Root[] = [];

afterEach(async () => {
  for (const root of roots) {
    await act(async () => root.unmount());
  }
  roots = [];
  document.body.innerHTML = "";
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

describe("the connect step's cards", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(node));
  }

  it("gives every card field the same input, from one declaration", () => {
    // The step asks for three different things in this row — a browser code, a
    // key — and they sit one toggle apart in the same canvas, so a divergence
    // between them is visible by flipping a switch. Sharing the declaration is
    // what stops that; this is the assertion that the sharing is real.
    render(
      <>
        <OnboardingCardField value="" onChange={() => {}} onSubmit={() => {}} />
        <OnboardingCardField
          label="API key"
          placeholder="Enter API key here"
          masked
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
        />
      </>,
    );

    const [code, key] = [...container.querySelectorAll("input")];
    expect(code!.className).toBe(onboardingCardInputClass);
    expect(key!.className).toBe(code!.className);
  });

  it("masks a key and does not mask a one-time code", () => {
    // A provider key is a credential that goes on living; a browser code is
    // single-use and about to be pasted somewhere the customer can see.
    render(
      <>
        <OnboardingCardField value="" onChange={() => {}} onSubmit={() => {}} />
        <OnboardingCardField
          label="API key"
          masked
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
        />
      </>,
    );

    const [code, key] = [...container.querySelectorAll("input")];
    expect(code!.getAttribute("type")).toBe("text");
    expect(code!.getAttribute("aria-label")).toBe("Authorization code");
    expect(key!.getAttribute("type")).toBe("password");
    expect(key!.getAttribute("aria-label")).toBe("API key");
  });

  it("holds one height across the card's waiting and ready states", () => {
    // The card opens on a spinner and then fills. Both states share a floor, so
    // the footer below is pushed down once for one event rather than twice —
    // the loaded card growing into place would be a second shove.
    render(
      <OnboardingLoginCard loading instruction="Starting…">
        <div />
      </OnboardingLoginCard>,
    );
    const waiting = container.firstElementChild!.className;

    flushSync(() => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    render(
      <OnboardingLoginCard instruction="Ready">
        <OnboardingCardField value="" onChange={() => {}} onSubmit={() => {}} />
      </OnboardingLoginCard>,
    );
    const ready = container.firstElementChild!.className;

    expect(waiting).toContain("min-h-(--sz-108px)");
    expect(ready).toContain("min-h-(--sz-108px)");
  });
});
