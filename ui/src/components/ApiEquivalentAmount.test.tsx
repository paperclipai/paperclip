// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiEquivalent } from "@paperclipai/shared";
import { ApiEquivalentAmount } from "./ApiEquivalentAmount";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const value = (overrides: Partial<ApiEquivalent> = {}): ApiEquivalent =>
  ({ cents: 1480, reportedCents: 1480, listPriceCents: 0, unpricedTokens: 0, unpricedModels: [], ...overrides });

describe("ApiEquivalentAmount", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("shows the amount as an estimate", () => {
    act(() => root.render(<ApiEquivalentAmount value={value()} />));
    expect(container.textContent).toContain("$14.80");
    expect(container.textContent).toContain("Estimated");
    expect(container.textContent).not.toContain("not priced");
  });

  it("shows tokens on unknown models as not priced", () => {
    act(() => root.render(<ApiEquivalentAmount value={value({ unpricedTokens: 1000 })} />));
    expect(container.textContent).toContain("not priced");
  });

  it("does not show a fully unpriced estimate as $0", () => {
    act(() => root.render(<ApiEquivalentAmount value={value({ cents: 0, reportedCents: 0, unpricedTokens: 1000 })} />));
    expect(container.textContent).toContain("Not priced");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("renders a dash without a value", () => {
    act(() => root.render(<ApiEquivalentAmount />));
    expect(container.textContent).toBe("—");
  });
});
