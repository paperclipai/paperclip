// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoneycombRunLink } from "./HoneycombRunLink";
import { HONEYCOMB_RUN_HASH_ATTRIBUTE } from "@/lib/honeycomb-run-link";

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("HoneycombRunLink", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stays hidden when Paperclip developer mode is off", async () => {
    flushSync(() => {
      root.render(<HoneycombRunLink runId="run-123" enabled={false} />);
    });
    await flushReact();

    expect(container.textContent).not.toContain("View in Honeycomb");
  });

  it.each([0, 50])("links the run hash query when Paperclip developer mode is on (digest delay %i ms)", async (digestDelayMs) => {
    if (digestDelayMs > 0) {
      const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
      vi.spyOn(webcrypto.subtle, "digest").mockImplementation(async (...args) => {
        await new Promise((resolve) => window.setTimeout(resolve, digestDelayMs));
        return digest(...args);
      });
    }
    flushSync(() => {
      root.render(<HoneycombRunLink runId="abc" enabled />);
    });
    // WebCrypto finishes off the JS event loop. A fixed number of timer turns
    // does not prove that its result has reached React.
    await vi.waitFor(() => {
      expect(container.querySelector("a")?.textContent).toContain("View in Honeycomb");
    });

    const link = container.querySelector<HTMLAnchorElement>("a");
    expect(link?.textContent).toContain("View in Honeycomb");
    expect(link?.target).toBe("_blank");
    const query = JSON.parse(
      new URL(link?.href ?? "about:blank").searchParams.get("query") ?? "null",
    ) as { filters: Array<{ column: string; value: string }> };
    expect(
      query.filters.find(
        (filter) => filter.column === HONEYCOMB_RUN_HASH_ATTRIBUTE,
      )?.value,
    ).toBe("ba7816bf8f01");
  });
});
