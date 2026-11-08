// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDetailHeader } from "./AgentDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentDetailHeader", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it("wraps on narrow screens so the action row moves below the identity", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() =>
      root!.render(
        <AgentDetailHeader
          avatarLabel="Test agent avatar"
          portrait={<div data-testid="portrait" />}
          identity={<div data-testid="identity" />}
          actions={
            <div
              data-testid="actions"
              className="flex items-center gap-1 sm:gap-2 shrink-0 max-sm:w-full max-sm:justify-end"
            />
          }
        />,
      ),
    );

    const header = container.querySelector("header");
    expect(header?.className).toContain("flex-wrap");
    expect(header?.className).toContain("gap-y-3");

    const portrait = container.querySelector('[data-testid="portrait"]');
    expect(portrait?.parentElement?.getAttribute("aria-label")).toBe("Test agent avatar");

    const actions = container.querySelector('[data-testid="actions"]');
    expect(actions?.className).toContain("max-sm:w-full");
    expect(actions?.className).toContain("max-sm:justify-end");
  });
});
