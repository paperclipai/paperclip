// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateCardEquivalent } from "./RateCardEquivalent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(cents: number): void {
  flushSync(() => root.render(<RateCardEquivalent cents={cents} />));
}

describe("RateCardEquivalent", () => {
  it("renders the list-price value for subscription usage", () => {
    render(15_868);
    expect(container.textContent).toContain("$158.68");
  });

  it("labels the value as a rate card so it is not read as cash owed", () => {
    render(15_868);
    expect(container.textContent).toContain("rate card");
    expect(container.querySelector("span")?.getAttribute("title")).toContain("list price");
  });

  it("renders nothing when there is no subscription usage", () => {
    render(0);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for negative or non-finite input rather than a bogus figure", () => {
    render(-500);
    expect(container.textContent).toBe("");
    render(Number.NaN);
    expect(container.textContent).toBe("");
  });
});
