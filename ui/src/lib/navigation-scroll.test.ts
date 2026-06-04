// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  resetNavigationScroll,
  SIDEBAR_SCROLL_RESET_STATE,
  shouldResetScrollOnNavigation,
} from "./navigation-scroll";

describe("navigation-scroll", () => {
  it("resets scroll only for flagged sidebar navigation", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/issues",
        pathname: "/dashboard",
        navigationType: "PUSH",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(true);

    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/issues",
        pathname: "/dashboard",
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(false);
  });

  it("preserves scroll restoration for browser history navigation even for sidebar entries", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/issues",
        pathname: "/dashboard",
        navigationType: "POP",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(false);
  });

  it("resets scroll when navigating directly between issue detail routes", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/issues/PAP-1389",
        pathname: "/issues/PAP-1346",
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(true);

    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/PAP/issues/PAP-1389",
        pathname: "/PAP/issues/PAP-1346",
        navigationType: "REPLACE",
        state: null,
      }),
    ).toBe(true);
  });

  it("does not treat non-detail issue routes as issue-to-issue navigation", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/projects/project-1/issues/all",
        pathname: "/issues/PAP-1346",
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(false);

    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/issues/PAP-1389",
        pathname: "/projects/project-1/issues/all",
        navigationType: "PUSH",
        state: null,
      }),
    ).toBe(false);
  });

  it("does not reset scroll on the initial render or when the pathname is unchanged", () => {
    expect(
      shouldResetScrollOnNavigation({
        previousPathname: null,
        pathname: "/dashboard",
        navigationType: "PUSH",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(false);

    expect(
      shouldResetScrollOnNavigation({
        previousPathname: "/dashboard",
        pathname: "/dashboard",
        navigationType: "REPLACE",
        state: SIDEBAR_SCROLL_RESET_STATE,
      }),
    ).toBe(false);
  });

  it("resets both the main content container and page scroll state", () => {
    const main = document.createElement("main");
    main.scrollTop = 180;
    main.scrollLeft = 14;
    main.scrollTo = vi.fn();
    document.body.appendChild(main);

    document.documentElement.scrollTop = 240;
    document.documentElement.scrollLeft = 9;
    document.body.scrollTop = 120;
    document.body.scrollLeft = 7;
    const windowScrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    resetNavigationScroll(main);

    expect(main.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(main.scrollTop).toBe(0);
    expect(main.scrollLeft).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.documentElement.scrollLeft).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(document.body.scrollLeft).toBe(0);
    expect(windowScrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
  });
});
