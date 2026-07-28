// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeckProductFlowHarness } from "./ProductFlowHarness";
import { DECK_PRODUCT_FLOW_FIXTURE_SOURCE, DECK_PRODUCT_FLOW_SEED, deckProductFlowFixture } from "./fixtures";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DeckProductFlowHarness", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: React.ReactElement) {
    act(() => root.render(node));
    return container.querySelector("[data-deck-product-flow-ready='true']") as HTMLElement;
  }

  it("declares the product register, fixture source, seed, and no-app-chrome boundary", () => {
    const harness = render(<DeckProductFlowHarness initialFrame={0} mode="capture" />);

    expect(harness.dataset.register).toBe("product");
    expect(harness.dataset.fixtureSource).toBe(DECK_PRODUCT_FLOW_FIXTURE_SOURCE);
    expect(harness.dataset.fixtureSeed).toBe(DECK_PRODUCT_FLOW_SEED);
    expect(harness.dataset.appChrome).toBe("none");
    expect(harness.textContent).toContain("Seeded fixture");
  });

  it("keeps the only gradient on a named agent capsule", () => {
    render(<DeckProductFlowHarness initialFrame={1} mode="capture" />);

    const liquid = container.querySelector(".agent-cap-liquid") as HTMLElement;
    expect(liquid).not.toBeNull();
    expect(liquid.dataset.agentCapsule).toBe("Forge");
  });

  it("supports keyboard navigation in embedded mode", () => {
    const harness = render(<DeckProductFlowHarness initialFrame={0} mode="embed" />);
    expect(harness.textContent).toContain("01 Seed");

    act(() => {
      harness.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(harness.textContent).toContain("02 Story");

    act(() => {
      harness.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(harness.textContent).toContain("04 Embed");
  });

  it("clamps navigation against the active custom fixture length", () => {
    const shortFixture = {
      ...deckProductFlowFixture,
      frames: deckProductFlowFixture.frames.slice(0, 2),
      version: "deck-product-flow.test-short-fixture",
    };
    const harness = render(<DeckProductFlowHarness initialFrame={99} mode="embed" fixture={shortFixture} />);

    expect(harness.textContent).toContain("02 Story");
    expect(harness.textContent).toContain("2 of 2");

    act(() => {
      harness.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    expect(harness.textContent).toContain("02 Story");
    expect(harness.textContent).toContain("2 of 2");
    expect(harness.textContent).not.toContain("3 of 2");
  });
});
