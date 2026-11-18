// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  ANALYTICS_MASK_CLASS,
  ANALYTICS_MASK_TEXT_SELECTOR,
  ANALYTICS_NO_CAPTURE_CLASS,
  maskReplayAttribute,
  redactAnalyticsUrl,
} from "./privacy";

function render(html: string) {
  document.body.innerHTML = html;
  return (id: string) => document.getElementById(id) as HTMLElement;
}

describe("session replay text mask selector", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("matches only text inside customer content, secrets and editable content", () => {
    const el = render(
      `<nav><a id="n">Tasks</a></nav><main><p id="p">Quarterly revenue plan</p>`
      + `<div class="${ANALYTICS_MASK_CLASS}"><p id="c">Customer secret</p></div>`
      + `<div contenteditable="true"><p id="e">Draft</p></div>`
      + `<div contenteditable="false"><p id="r">Read only</p></div>`
      + `<div class="${ANALYTICS_NO_CAPTURE_CLASS}"><span id="k">sk-123</span></div></main>`,
    );
    const masked = (id: string) => el(id).closest(ANALYTICS_MASK_TEXT_SELECTOR) !== null;
    expect(masked("n")).toBe(false);
    expect(masked("p")).toBe(false);
    expect(masked("r")).toBe(false);
    expect(masked("c")).toBe(true);
    expect(masked("e")).toBe(true);
    expect(masked("k")).toBe(true);
  });
});

describe("session replay attribute masking", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("masks free-text attributes that carry customer data, such as an organization switcher label", () => {
    const el = render(
      `<button id="b" aria-label="Open Verify Co organization switcher" title="Verify Co">`
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

  it("keeps layout attributes and masks labels on chrome", () => {
    const el = render(`<button id="b" aria-label="New task" class="btn" data-state="open">New task</button>`);
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
