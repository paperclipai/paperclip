// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopyText } from "./CopyText";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CopyText", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("uses the provided accessible label for icon-only copy controls", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <CopyText text="https://example.com/projects/project-1" ariaLabel="Copy permanent project link">
          <span aria-hidden="true">copy icon</span>
        </CopyText>,
      );
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy permanent project link");

    act(() => root.unmount());
  });
});
