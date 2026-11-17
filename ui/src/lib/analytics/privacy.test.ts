// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYTICS_MASK_CLASS,
  ANALYTICS_NO_CAPTURE_CLASS,
  ANALYTICS_UNMASK_ATTRIBUTE,
  maskReplayText,
} from "./privacy";

function render(html: string) {
  document.body.innerHTML = html;
  return (id: string) => document.getElementById(id) as HTMLElement;
}

describe("session replay text masking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("masks text on any surface that nobody marked", () => {
    const el = render(`<main><p id="p">Quarterly revenue plan</p></main>`);
    expect(maskReplayText("Quarterly revenue plan", el("p"))).toBe("********* ******* ****");
  });

  it("masks text when the element is unknown", () => {
    expect(maskReplayText("hello", null)).toBe("*****");
    expect(maskReplayText("hello")).toBe("*****");
  });

  it("shows text inside opted-in chrome", () => {
    const el = render(`<button ${ANALYTICS_UNMASK_ATTRIBUTE}><span id="s">New task</span></button>`);
    expect(maskReplayText("New task", el("s"))).toBe("New task");
  });

  it("keeps customer content masked even inside opted-in chrome", () => {
    const el = render(
      `<nav ${ANALYTICS_UNMASK_ATTRIBUTE}><div class="${ANALYTICS_MASK_CLASS}"><p id="c">Customer secret</p></div>`
      + `<div contenteditable="true"><p id="e">Draft</p></div>`
      + `<div class="${ANALYTICS_NO_CAPTURE_CLASS}"><span id="k">sk-123</span></div></nav>`,
    );
    expect(maskReplayText("Customer secret", el("c"))).toBe("******** ******");
    expect(maskReplayText("Draft", el("e"))).toBe("*****");
    expect(maskReplayText("sk-123", el("k"))).toBe("******");
  });
});
