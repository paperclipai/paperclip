// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouterProvider, useBlocker } from "@/lib/router";
import { createAppRouter } from "./app-router";

describe("createAppRouter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/agents/test/configuration");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("provides the data-router context required by navigation blockers", async () => {
    function BlockerProbe() {
      const blocker = useBlocker(true);
      return <span>{blocker.state}</span>;
    }

    const router = createAppRouter(<BlockerProbe />);

    flushSync(() => root.render(<RouterProvider router={router} />));

    expect(container.textContent).toBe("unblocked");
    router.dispose();
  });
});
