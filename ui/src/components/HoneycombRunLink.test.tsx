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
    vi.unstubAllGlobals();
  });

  it("stays hidden when Paperclip developer mode is off", async () => {
    flushSync(() => {
      root.render(<HoneycombRunLink runId="run-123" enabled={false} />);
    });
    await flushReact();

    expect(container.textContent).not.toContain("View in Honeycomb");
  });

  it("links the run hash query when Paperclip developer mode is on", async () => {
    flushSync(() => {
      root.render(<HoneycombRunLink runId="abc" enabled />);
    });
    await flushReact();

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
