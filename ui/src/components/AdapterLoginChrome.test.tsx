// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type React from "react";
import {
  OnboardingLoginCard,
  OnboardingCardField,
  OnboardingLoginCodeRow,
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

/**
 * The displayed-code card puts the code on the clipboard the moment it is
 * readable, so the customer can paste it wherever they are being asked for it
 * without reaching for the button. That convenience is only worth anything if
 * it actually happened — a card claiming "Copied!" over an empty clipboard is
 * worse than one that never claimed it, because the customer stops checking.
 */
describe("the displayed code's auto-copy", () => {
  function stubClipboard() {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  function stubFocus(focused: boolean) {
    const original = document.hasFocus;
    document.hasFocus = () => focused;
    return () => {
      document.hasFocus = original;
    };
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("writes nothing when there is no code yet", async () => {
    // The row renders before the server's one-time prompt carries a value on
    // some paths. The latch used to be taken on that first run, so the copy
    // that mattered never ran and the clipboard kept whatever it already had.
    const writeText = stubClipboard();
    const restore = stubFocus(true);
    try {
      await render(<OnboardingLoginCodeRow code="" autoCopy />);
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("copies the code once it arrives", async () => {
    const writeText = stubClipboard();
    const restore = stubFocus(true);
    try {
      await render(<OnboardingLoginCodeRow code="WFK7-4GA3U" autoCopy />);
      expect(writeText).toHaveBeenCalledWith("WFK7-4GA3U");
    } finally {
      restore();
    }
  });

  it("asks once while a write is still in flight", async () => {
    // The success latch is only taken when the write resolves, so it cannot
    // also mean "already running" — without a separate guard a focus event
    // arriving mid-write started a second attempt.
    let settle: () => void = () => {};
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const restore = stubFocus(true);
    try {
      await render(<OnboardingLoginCodeRow code="WFK7-4GA3U" autoCopy />);
      expect(writeText).toHaveBeenCalledTimes(1);

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
      });
      expect(writeText).toHaveBeenCalledTimes(1);

      await act(async () => {
        settle();
      });
    } finally {
      restore();
    }
  });

  it("waits for the document rather than spending its one attempt unfocused", async () => {
    // A write from an unfocused document is refused, and the first attempt is
    // the most likely to be refused, since it fires while the card is still
    // arriving. Latching before the attempt made that refusal permanent.
    const writeText = stubClipboard();
    const restore = stubFocus(false);
    try {
      await render(<OnboardingLoginCodeRow code="WFK7-4GA3U" autoCopy />);
      expect(writeText).not.toHaveBeenCalled();

      document.hasFocus = () => true;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(writeText).toHaveBeenCalledWith("WFK7-4GA3U");
    } finally {
      restore();
    }
  });
});
