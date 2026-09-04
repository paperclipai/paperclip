// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";

import {
  OnboardingLoginCard,
  OnboardingLoginCodeInput,
  onboardingCardInputClass,
} from "./AdapterLoginChrome";
import { ApiKeyField } from "./onboarding/ConnectInputCanvas";

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

describe("the connect step's two cards", () => {
  it("gives the key field and the sign-in field the same input, from one declaration", async () => {
    // The assertion that would have caught the drift this file exists for: not
    // "both look like X", which passes right up until one of them is restyled,
    // but that the two carry the byte-identical class string.
    const signIn = await render(
      <OnboardingLoginCard instruction="Open Claude link then come back and enter code">
        <OnboardingLoginCodeInput value="" onChange={() => {}} onSubmit={() => {}} />
      </OnboardingLoginCard>,
    );
    const keyCard = await render(
      <ApiKeyField envKey="ANTHROPIC_API_KEY" value="" onChange={() => {}} />,
    );

    const codeInput = signIn.querySelector("input")!;
    const keyInput = keyCard.querySelector("input")!;
    expect(codeInput.className).toBe(onboardingCardInputClass);
    expect(keyInput.className).toBe(codeInput.className);
  });

  it("wraps the key field in the same card shell as the sign-in", async () => {
    // The shell, not just the input. The key field used to draw its own
    // bordered box, so flipping the credential switch changed the shape of the
    // step rather than its content.
    const signIn = await render(
      <OnboardingLoginCard instruction="Open Claude link then come back and enter code">
        <OnboardingLoginCodeInput value="" onChange={() => {}} onSubmit={() => {}} />
      </OnboardingLoginCard>,
    );
    const keyCard = await render(
      <ApiKeyField envKey="ANTHROPIC_API_KEY" value="" onChange={() => {}} />,
    );

    expect(keyCard.firstElementChild!.className).toBe(signIn.firstElementChild!.className);
  });

  it("labels the key field with the variable it will be written to", async () => {
    // The name answers what a paster cannot answer for themselves — where this
    // step puts the key — so it is the label rather than a sentence about it,
    // and it reaches assistive tech as the field's name too.
    const keyCard = await render(
      <ApiKeyField envKey="ANTHROPIC_API_KEY" value="" onChange={() => {}} />,
    );

    expect(keyCard.textContent).toContain("ANTHROPIC_API_KEY");
    expect(keyCard.querySelector("input")!.getAttribute("aria-label")).toBe("ANTHROPIC_API_KEY");
    // Still a password field: the key is a secret even while being pasted.
    expect(keyCard.querySelector("input")!.getAttribute("type")).toBe("password");
  });
});
