// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCapsule } from "./AgentCapsule";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentCapsule", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function render(node: React.ReactElement) {
    const root = createRoot(container);
    act(() => {
      root.render(node);
    });
    return container.querySelector('[role="img"]') as HTMLElement;
  }

  it("renders a dashed pulsing outline with no liquid in the slot state", () => {
    const cap = render(<AgentCapsule state="slot" />);
    expect(cap.dataset.state).toBe("slot");
    const dash = cap.querySelector(".agent-cap-dash") as HTMLElement;
    expect(dash).not.toBeNull();
    expect(dash.className).toContain("border-dashed");
    expect(dash.className).toContain("agent-cap-slot");
    expect(dash.className).toContain("opacity-100");
    // Solid stroke layer is present but faded out.
    expect((cap.querySelector(".agent-cap-stroke") as HTMLElement).className).toContain("opacity-0");
    expect(cap.querySelector(".agent-cap-liquid")).toBeNull();
    expect(cap.getAttribute("aria-label")).toBe("empty agent slot");
  });

  it("renders a solid stroke with no liquid in the configured state", () => {
    const cap = render(<AgentCapsule state="configured" />);
    expect(cap.dataset.state).toBe("configured");
    const stroke = cap.querySelector(".agent-cap-stroke") as HTMLElement;
    expect(stroke.className).toContain("border-solid");
    expect(stroke.className).toContain("opacity-100");
    // Dashed layer is present but faded out (no pulse).
    const dash = cap.querySelector(".agent-cap-dash") as HTMLElement;
    expect(dash.className).toContain("opacity-0");
    expect(dash.className).not.toContain("agent-cap-slot");
    expect(cap.querySelector(".agent-cap-liquid")).toBeNull();
  });

  it("renders the rising gradient liquid + green online pulse by default", () => {
    const cap = render(<AgentCapsule state="online" gradient={5} />);
    expect(cap.className).toContain("agent-cap-online");
    expect(cap.className).not.toContain("agent-cap-online-blue");
    expect(cap.dataset.glow).toBe("green");
    const liquid = cap.querySelector(".agent-cap-liquid") as HTMLElement;
    expect(liquid).not.toBeNull();
    expect(liquid.style.background).toContain("--agent-5a");
    expect(liquid.style.background).toContain("--agent-5b");
    expect(cap.dataset.gradient).toBe("5");
  });

  it("uses the blue online glow when glow='blue'", () => {
    const cap = render(<AgentCapsule state="online" gradient={5} glow="blue" />);
    expect(cap.className).toContain("agent-cap-online-blue");
    expect(cap.dataset.glow).toBe("blue");
    expect(cap.querySelector(".agent-cap-liquid")).not.toBeNull();
  });

  it("maps preset sizes to pixel dimensions (proportion 1:>=2)", () => {
    const cap = render(<AgentCapsule state="configured" size="md" />);
    expect(cap.style.width).toBe("34px");
    expect(cap.style.height).toBe("84px");
  });

  it("accepts an explicit pixel size", () => {
    const cap = render(<AgentCapsule state="slot" size={{ width: 28, height: 96 }} />);
    expect(cap.style.width).toBe("28px");
    expect(cap.style.height).toBe("96px");
  });

  it("wraps out-of-range gradient indices into 1..10", () => {
    expect(render(<AgentCapsule state="online" gradient={11} />).dataset.gradient).toBe("1");
    expect(render(<AgentCapsule state="online" gradient={0} />).dataset.gradient).toBe("10");
    expect(render(<AgentCapsule state="online" gradient={-1} />).dataset.gradient).toBe("9");
  });

  it("traces the outline instead of cross-fading it when strokeDraw is set", () => {
    // The cross-fade renders a bordered <span>; the trace renders an SVG rect
    // animated from pathLength 0 to 1.
    const cap = render(<AgentCapsule state="configured" strokeDraw />);
    expect(cap.querySelector("svg rect")).not.toBeNull();
    expect(cap.querySelector(".agent-cap-stroke")).toBeNull();
  });

  it("keeps the cross-fade when strokeDraw is not asked for", () => {
    // Everywhere outside the onboarding arc the quieter default applies.
    const cap = render(<AgentCapsule state="configured" />);
    expect(cap.querySelector(".agent-cap-stroke")).not.toBeNull();
    expect(cap.querySelector("svg rect")).toBeNull();
  });

  it("holds the dashed outline until the trace finishes", () => {
    // Fading the dashed layer on the usual schedule would leave the capsule
    // briefly outline-less in the middle of its own birth.
    const cap = render(<AgentCapsule state="configured" strokeDraw />);
    const dashed = cap.querySelector(".agent-cap-dash") as HTMLElement;
    expect(dashed).not.toBeNull();
    expect(dashed.style.transitionDelay).not.toBe("");
  });
});
