// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Identity } from "./Identity";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Identity", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("allows long names to shrink and exposes the full name on hover", () => {
    const root = createRoot(container);
    const longName = "QA and Repo Compliance Engineer";

    act(() => {
      root.render(<Identity name={longName} size="xs" />);
    });

    const wrapper = container.querySelector("span[title]") as HTMLSpanElement | null;
    const name = wrapper?.querySelector("span.truncate") as HTMLSpanElement | null;

    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("title")).toBe(longName);
    expect(wrapper?.className).toContain("min-w-0");
    expect(wrapper?.className).toContain("max-w-full");
    expect(name).not.toBeNull();
    expect(name?.className).toContain("min-w-0");
    expect(name?.className).toContain("truncate");

    act(() => {
      root.unmount();
    });
  });
});
