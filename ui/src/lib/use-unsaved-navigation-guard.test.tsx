// @vitest-environment jsdom

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsavedNavigationGuard } from "./use-unsaved-navigation-guard";

describe("useUnsavedNavigationGuard", () => {
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
    vi.restoreAllMocks();
  });

  it("prompts once and keeps dirty state when navigation is cancelled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    function GuardedPage() {
      const navigate = useNavigate();
      const location = useLocation();
      const [dirty] = useState(true);

      useUnsavedNavigationGuard(dirty, "Discard changes?");

      return (
        <>
          <button
            type="button"
            onClick={() => {
              navigate("/dashboard");
            }}
          >
            Dashboard
          </button>
          <span data-location>{location.pathname}</span>
          <span data-dirty>{String(dirty)}</span>
        </>
      );
    }

    const router = createMemoryRouter(
      [{ path: "*", element: <GuardedPage /> }],
      { initialEntries: ["/agents/test/configuration"] },
    );

    flushSync(() => {
      root.render(<RouterProvider router={router} />);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    flushSync(() => {
      container.querySelector("button")?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-location]")?.textContent).toBe("/agents/test/configuration");
    expect(container.querySelector("[data-dirty]")?.textContent).toBe("true");

    router.dispose();
  });
});
