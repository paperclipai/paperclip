// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { readPageContentGates, resetPageContentGatesForTest } from "@/lib/browser-tracing/page-content-gates";
import { usePageContentReady } from "./usePageContentReady";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ enabled }: { enabled: boolean }) {
  usePageContentReady(false, null, { enabled });
  return null;
}

describe("usePageContentReady", () => {
  afterEach(() => resetPageContentGatesForTest());

  it("registers a pending content gate while enabled and none while disabled", () => {
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe enabled />));
    expect(readPageContentGates()).toMatchObject({ contentCount: 1, pendingContentCount: 1 });
    // An agent chat with no saved task has no content signal; it must not hold the page open.
    act(() => root.render(<Probe enabled={false} />));
    expect(readPageContentGates()).toMatchObject({ contentCount: 0, pendingContentCount: 0 });
    act(() => root.unmount());
  });
});
