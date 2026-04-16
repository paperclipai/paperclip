// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunButton } from "./AgentActionButtons";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("RunButton", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows a pending label while a heartbeat request is starting", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <RunButton
          onClick={() => undefined}
          pending
          label="Run Heartbeat"
        />,
      );
    });

    expect(container.textContent).toContain("Starting...");
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});
