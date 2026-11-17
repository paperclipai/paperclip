// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYTICS_MASK_CLASS,
  ANALYTICS_NO_CAPTURE_CLASS,
  ANALYTICS_UNMASK_ATTRIBUTE,
  maskReplayAttribute,
  maskReplayText,
  redactAnalyticsUrl,
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

describe("session replay attribute masking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("masks free-text attributes that carry customer data, such as an organization switcher label", () => {
    const el = render(
      `<button ${ANALYTICS_UNMASK_ATTRIBUTE} id="b" aria-label="Open Verify Co organization switcher" title="Verify Co">`
      + `<span class="${ANALYTICS_MASK_CLASS}" id="n" title="Verify Co">Verify Co</span></button>`
      + `<span id="t" title="Customer task title">Customer task title</span>`
      + `<img id="i" src="/api/attachments/1" alt="Quarterly plan">`,
    );
    expect(maskReplayAttribute("aria-label", "Open Verify Co organization switcher", el("b")))
      .toBe("**** ****** ** ************ ********");
    expect(maskReplayAttribute("title", "Verify Co", el("b"))).toBe("****** **");
    expect(maskReplayAttribute("title", "Verify Co", el("n"))).toBe("****** **");
    expect(maskReplayAttribute("title", "Customer task title", el("t"))).toBe("******** **** *****");
    expect(maskReplayAttribute("src", "/api/attachments/1", el("i"))).toBe("******************");
    expect(maskReplayAttribute("alt", "Quarterly plan", el("i"))).toBe("********* ****");
    expect(maskReplayAttribute("data-anything", "secret", el("t"))).toBe("******");
    // Element references often embed names or slugs (for example a skill slug).
    expect(maskReplayAttribute("id", "skill-acme-secret-plan", el("t"))).toBe("**********************");
    expect(maskReplayAttribute("for", "skill-acme-secret-plan", el("t"))).toBe("**********************");
    expect(maskReplayAttribute("aria-labelledby", "label-acme", el("t"))).toBe("**********");
    // Fixed layout IDs that page CSS targets keep their value.
    expect(maskReplayAttribute("id", "main-content", el("t"))).toBe("main-content");
  });

  it("keeps layout attributes and masks labels even on opted-in chrome", () => {
    const el = render(`<button ${ANALYTICS_UNMASK_ATTRIBUTE} id="b" aria-label="New task" class="btn" data-state="open">New task</button>`);
    expect(maskReplayAttribute("aria-label", "New task", el("b"))).toBe("*** ****");
    expect(maskReplayAttribute("class", "btn", el("b"))).toBe("btn");
    expect(maskReplayAttribute("data-state", "open", el("b"))).toBe("open");
    expect(maskReplayAttribute("rr_width", "10px", el("b"))).toBe("10px");
  });

  it("masks every link href, such as a download link carrying a file path, and keeps stylesheets", () => {
    const el = render(
      `<a id="nav" href="/VER/issues">Tasks</a>`
      + `<a id="dl" href="/api/files/content?path=customers%2Fplan.md">Download</a>`
      + `<link id="css" rel="stylesheet" href="/assets/index.css">`,
    );
    expect(maskReplayAttribute("href", "/VER/issues", el("nav"))).toBe("***********");
    expect(maskReplayAttribute("href", "/api/files/content?path=customers%2Fplan.md", el("dl"))).not.toContain("plan");
    expect(maskReplayAttribute("href", "/assets/index.css", el("css"))).toBe("/assets/index.css");
  });
});

describe("analytics URL redaction", () => {
  it("redacts claim and invite tokens and secret query values", () => {
    expect(redactAnalyticsUrl("/board-claim/abc123")).toBe("/board-claim/REDACTED");
    expect(redactAnalyticsUrl("https://x.paperclip.app/invite/tok?x=1")).toBe("https://x.paperclip.app/invite/REDACTED");
    expect(redactAnalyticsUrl("https://x.paperclip.app/cli-auth/id1?token=s3cr3t")).not.toContain("s3cr3t");
    expect(redactAnalyticsUrl("/VER/issues/VER-1")).toBe("/VER/issues/VER-1");
    expect(redactAnalyticsUrl("Desktop")).toBe("Desktop");
    // Query and hash never leave: they can hold file paths or search text.
    expect(redactAnalyticsUrl("https://x.paperclip.app/VER/files?path=customers/plan.md#L3")).toBe("https://x.paperclip.app/VER/files");
    expect(redactAnalyticsUrl("/VER/issues?q=acme%20merger")).toBe("/VER/issues");
    // Non-URL strings keep their text; only secret key=value pairs are redacted.
    expect(redactAnalyticsUrl("Mozilla/5.0 (Macintosh)")).toBe("Mozilla/5.0 (Macintosh)");
  });

  it("redacts secrets in stylesheet links in replay", () => {
    document.body.innerHTML = `<link id="l" rel="stylesheet" href="/x.css?token=abc">`;
    expect(maskReplayAttribute("href", "/x.css?token=abc", document.getElementById("l"))).toBe("/x.css");
    document.body.innerHTML = "";
  });
});
