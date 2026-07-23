// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StatusCardSettingsForm, defaultSettingsValue, type StatusCardSettingsValue } from "./StatusCardSettingsForm";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

function render(value: StatusCardSettingsValue) {
  flushSync(() =>
    root.render(<StatusCardSettingsForm value={value} onChange={() => {}} />),
  );
}

describe("StatusCardSettingsForm cost preview", () => {
  it("renders a manual per-refresh estimate by default", () => {
    render(defaultSettingsValue());
    expect(container.textContent).toContain("Estimated cost");
    expect(container.textContent).toContain("per refresh");
  });

  it("reacts to an interval policy", () => {
    render({
      ...defaultSettingsValue(),
      refreshPolicy: { mode: "interval", intervalMinutes: 30, triggers: defaultSettingsValue().refreshPolicy.triggers },
    });
    expect(container.textContent).toContain("updates/day");
    expect(container.textContent).toContain("every 30 min");
  });
});
