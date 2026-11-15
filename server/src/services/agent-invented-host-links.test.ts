import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_ROUTE_ROOTS, mayContainInventedHostLink, relativizeInventedHostLinks, type InventedHostLinkContext } from "./agent-invented-host-links.js";

const context: InventedHostLinkContext = { companyPrefix: "COM", ownOrigin: "https://board.example.com" };
const rewrite = (text: string, overrides: Partial<InventedHostLinkContext> = {}) =>
  relativizeInventedHostLinks(text, { ...context, ...overrides });

describe("invented-host Paperclip links", () => {
  it("rewrites the recorded cohort 16 reply link to a relative route", () => {
    // Recorded from chat-eval cohort 16 (agents.edit-instructions).
    const reply = "Done — I added the rule to [Morgan](https://paperclip.local/COM/agents/1fffd0bf-177a-4f4f-bb58-008160e407d5)'s persistent instructions in AGENTS.md.";
    expect(rewrite(reply)).toBe("Done — I added the rule to [Morgan](/COM/agents/1fffd0bf-177a-4f4f-bb58-008160e407d5)'s persistent instructions in AGENTS.md.");
  });

  it("rewrites the recorded cohort 16 attachment link on host paperclip", () => {
    // Recorded from chat-eval cohort 16 (onboarding.first-work worker comment).
    expect(rewrite("[index.html](https://paperclip/api/attachments/29ddbfd9-3dfc-4798-87d4-84fb99e68764/content)"))
      .toBe("[index.html](/api/attachments/29ddbfd9-3dfc-4798-87d4-84fb99e68764/content)");
  });

  it.each([
    ["a bare link with sentence punctuation", "See https://paperclip.local/COM/issues/COM-2.", "See [/COM/issues/COM-2](/COM/issues/COM-2)."],
    ["an autolink", "Open <https://paperclip/COM/approvals/a1>", "Open [/COM/approvals/a1](/COM/approvals/a1)"],
    ["a query and hash", "[plan](http://paperclip.internal:3100/COM/issues/COM-2#document-plan)", "[plan](/COM/issues/COM-2#document-plan)"],
    ["a localhost board link under this company's prefix", "[COM-2](http://localhost:3100/COM/issues/COM-2)", "[COM-2](/COM/issues/COM-2)"],
    ["an angle-bracket link destination", "[Morgan](<https://paperclip.local/COM/agents/morgan>)", "[Morgan](</COM/agents/morgan>)"],
    ["a reference definition", "See [Morgan].\n\n[Morgan]: https://paperclip.local/COM/agents/morgan", "See [Morgan].\n\n[Morgan]: /COM/agents/morgan"],
    ["an angle-bracket reference definition", "[Morgan]: <https://paperclip/COM/agents/morgan>", "[Morgan]: </COM/agents/morgan>"],
    ["an IPv6 loopback link", "[COM-2](http://[::1]:3100/COM/issues/COM-2)", "[COM-2](/COM/issues/COM-2)"],
    ["a profile page", "[Morgan](https://paperclip.local/COM/u/morgan)", "[Morgan](/COM/u/morgan)"],
    ["a link after quoted prose", "> Morgan said so.\n\nSee [COM-2](https://paperclip/COM/issues/COM-2).", "> Morgan said so.\n\nSee [COM-2](/COM/issues/COM-2)."],
    ["a loopback link under this company's prefix in lower case", "[case](http://127.0.0.1:3100/com/cases/COM-C1)", "[case](/com/cases/COM-C1)"],
  ])("rewrites %s", (_label, text, expected) => {
    expect(rewrite(text)).toBe(expected);
  });

  it.each([
    ["a genuine external link", "[docs](https://docs.github.com/COM/issues/1)"],
    ["a production Paperclip host", "[COM-2](https://paperclip.staging.paperclip.app/COM/issues/COM-2)"],
    ["this instance's own origin", "[COM-2](https://board.example.com/COM/issues/COM-2)"],
    ["a local app the agent built", "Open http://localhost:5173/ and call http://localhost:3000/api/hello."],
    ["a localhost route under another prefix", "[x](http://localhost:3100/V1/projects)"],
    ["a non-route path on an invented host", "[x](https://paperclip.local/about)"],
    ["a single-label host other than paperclip", "[build](http://jenkins/api/json)"],
    ["a link in inline code", "Run `curl https://paperclip/api/issues/COM-1` to check."],
    ["a link in a fence", "```sh\ncurl https://paperclip.local/COM/issues/COM-1\n```"],
    ["a link in a fence inside a block quote", "> ```sh\n> curl https://paperclip/api/issues/COM-1\n> ```"],
    ["a link in a fence inside a list item", "1. Run:\n   ```sh\n   curl https://paperclip/api/issues/COM-1\n   ```"],
    ["a link in an indented code block", "Run this:\n\n    curl https://paperclip/api/issues/COM-1\n    echo done"],
    ["a link in inline code across lines", "Run `curl\nhttps://paperclip/api/issues/COM-1` to check."],
    ["a link in double-backtick code", "Run ``curl https://paperclip/api/issues/COM-1`` now."],
    ["a relative link", "[COM-2](/COM/issues/COM-2)"],
  ])("leaves %s alone", (_label, text) => {
    expect(rewrite(text)).toBe(text);
  });

  it("knows every board route root the app serves", () => {
    const source = readFileSync(new URL("../../../ui/src/lib/company-routes.ts", import.meta.url), "utf8");
    const block = /const BOARD_ROUTE_ROOTS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
    const roots = [...block.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
    expect(roots.length).toBeGreaterThan(10);
    expect(roots.filter(root => !BOARD_ROUTE_ROOTS.has(root))).toEqual([]);
  });

  it("keeps a localhost link when the company prefix is unknown", () => {
    expect(rewrite("[COM-2](http://localhost:3100/COM/issues/COM-2)", { companyPrefix: null })).toBe("[COM-2](http://localhost:3100/COM/issues/COM-2)");
  });

  it("skips ordinary prose without parsing", () => {
    expect(mayContainInventedHostLink("Saved [COM-2](/COM/issues/COM-2) and https://github.com/x/y.")).toBe(false);
    expect(mayContainInventedHostLink("see https://paperclip/api/x")).toBe(true);
  });
});
