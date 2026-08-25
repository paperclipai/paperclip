// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostFeatureGate } from "./HostFeatureGate";

const enabledFeatures = vi.hoisted(() => new Set<string>());

vi.mock("@/context/RuntimeFeaturesContext", () => ({
  useRuntimeFeatures: () => ({ hasFeature: (feature: string) => enabledFeatures.has(feature) }),
}));

vi.mock("@/lib/router", () => ({
  Outlet: () => <div>feature route</div>,
  Navigate: ({ to }: { to: string }) => <div data-navigate={to}>redirect</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("HostFeatureGate", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    enabledFeatures.clear();
    container.remove();
  });

  it("redirects unavailable feature routes and restores them when enabled", () => {
    flushSync(() => root.render(<HostFeatureGate feature="apps.access_profiles" />));
    expect(container.querySelector("[data-navigate]")?.getAttribute("data-navigate")).toBe("/apps/connections");

    enabledFeatures.add("apps.access_profiles");
    flushSync(() => root.render(<HostFeatureGate feature="apps.access_profiles" />));
    expect(container.textContent).toBe("feature route");
  });
});
