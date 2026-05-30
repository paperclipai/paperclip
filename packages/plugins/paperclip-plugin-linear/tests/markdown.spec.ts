import { describe, expect, it } from "vitest";
import {
  extractLinearWorkspaceSlug,
  linkifyBareLinearIssueRefs,
} from "../src/markdown.js";

describe("extractLinearWorkspaceSlug", () => {
  it("pulls slug from a workspace-prefixed issue url", () => {
    expect(
      extractLinearWorkspaceSlug(
        "https://linear.app/blockcast/issue/BLO-1488/title-slug",
      ),
    ).toBe("blockcast");
  });

  it("pulls slug from an initiatives url", () => {
    expect(
      extractLinearWorkspaceSlug(
        "https://linear.app/blockcast/initiative/abc-123",
      ),
    ).toBe("blockcast");
  });

  it("returns null for the slug-less webhook fallback", () => {
    expect(
      extractLinearWorkspaceSlug("https://linear.app/issue/BLO-1488"),
    ).toBeNull();
  });

  it("returns null for non-linear hosts", () => {
    expect(
      extractLinearWorkspaceSlug("https://github.com/org/repo/issues/1"),
    ).toBeNull();
  });

  it("returns null for empty / malformed input", () => {
    expect(extractLinearWorkspaceSlug("")).toBeNull();
    expect(extractLinearWorkspaceSlug(null)).toBeNull();
    expect(extractLinearWorkspaceSlug(undefined)).toBeNull();
    expect(extractLinearWorkspaceSlug("not a url at all")).toBeNull();
  });
});

describe("linkifyBareLinearIssueRefs", () => {
  it("wraps a single bare ref with the workspace url", () => {
    expect(linkifyBareLinearIssueRefs("see BLO-1488 for context", "blockcast"))
      .toBe("see [BLO-1488](https://linear.app/blockcast/issue/BLO-1488) for context");
  });

  it("wraps multiple bare refs in the same line", () => {
    expect(
      linkifyBareLinearIssueRefs("BLO-1488 and BLO-1489 are linked", "blockcast"),
    ).toBe(
      "[BLO-1488](https://linear.app/blockcast/issue/BLO-1488) and " +
        "[BLO-1489](https://linear.app/blockcast/issue/BLO-1489) are linked",
    );
  });

  it("falls back to slug-less url when workspace is unknown", () => {
    expect(linkifyBareLinearIssueRefs("see BLO-1488", null)).toBe(
      "see [BLO-1488](https://linear.app/issue/BLO-1488)",
    );
  });

  it("does not double-wrap an already-linked ref", () => {
    const input =
      "see [BLO-1488](https://linear.app/blockcast/issue/BLO-1488) for context";
    expect(linkifyBareLinearIssueRefs(input, "blockcast")).toBe(input);
  });

  it("wraps whole-ref inline code so the UI rewriter doesn't mis-route it", () => {
    // The UI rewriter (ui/src/lib/issue-reference.ts:127-133) rewrites
    // inlineCode whose value matches /^[A-Z][A-Z0-9]+-\d+$/i to /issues/<id>,
    // so we have to wrap whole-ref inline-code at import too — keeping the
    // backticks inside the link text preserves the code styling.
    expect(linkifyBareLinearIssueRefs("run `BLO-1488` first", "blockcast"))
      .toBe("run [`BLO-1488`](https://linear.app/blockcast/issue/BLO-1488) first");
  });

  it("leaves multi-token inline code untouched (UI rewriter ignores it too)", () => {
    expect(
      linkifyBareLinearIssueRefs("see `parseRef(BLO-1488)` for context", "blockcast"),
    ).toBe("see `parseRef(BLO-1488)` for context");
  });

  it("leaves refs inside fenced code blocks untouched", () => {
    const input = "before\n```\nBLO-1488\n```\nafter BLO-1489";
    expect(linkifyBareLinearIssueRefs(input, "blockcast")).toBe(
      "before\n```\nBLO-1488\n```\nafter [BLO-1489](https://linear.app/blockcast/issue/BLO-1489)",
    );
  });

  it("leaves refs inside autolinks untouched", () => {
    const input = "see <https://linear.app/blockcast/issue/BLO-1488>";
    expect(linkifyBareLinearIssueRefs(input, "blockcast")).toBe(input);
  });

  it("does not match mid-word identifiers", () => {
    expect(linkifyBareLinearIssueRefs("xBLO-1488y", "blockcast"))
      .toBe("xBLO-1488y");
  });

  it("linkifies compact slash-joined refs with a link per issue", () => {
    expect(linkifyBareLinearIssueRefs("BLO-1488/1489/1492", "blockcast"))
      .toBe(
        "[BLO-1488](https://linear.app/blockcast/issue/BLO-1488)/" +
          "[1489](https://linear.app/blockcast/issue/BLO-1489)/" +
          "[1492](https://linear.app/blockcast/issue/BLO-1492)",
      );
  });

  it("linkifies compact whole-ref inline code spans", () => {
    expect(linkifyBareLinearIssueRefs("run `BLO-1488/1489` next", "blockcast"))
      .toBe(
        "run [`BLO-1488`](https://linear.app/blockcast/issue/BLO-1488)/" +
          "[`1489`](https://linear.app/blockcast/issue/BLO-1489) next",
      );
  });

  it("leaves raw urls untouched", () => {
    const input = "see https://linear.app/blockcast/issue/BLO-1488/title-slug and BLO-1489";
    expect(linkifyBareLinearIssueRefs(input, "blockcast")).toBe(
      "see https://linear.app/blockcast/issue/BLO-1488/title-slug and " +
        "[BLO-1489](https://linear.app/blockcast/issue/BLO-1489)",
    );
  });

  it("preserves non-Linear markdown links nearby", () => {
    const input =
      "see [multicast#128](https://github.com/Blockcast/multicast/pull/128) and BLO-1488";
    expect(linkifyBareLinearIssueRefs(input, "blockcast")).toBe(
      "see [multicast#128](https://github.com/Blockcast/multicast/pull/128) and " +
        "[BLO-1488](https://linear.app/blockcast/issue/BLO-1488)",
    );
  });

  it("uppercases the path component but preserves the original casing in link text", () => {
    expect(linkifyBareLinearIssueRefs("see blo-1488", "blockcast")).toBe(
      "see [blo-1488](https://linear.app/blockcast/issue/BLO-1488)",
    );
  });

  it("returns empty body unchanged", () => {
    expect(linkifyBareLinearIssueRefs("", "blockcast")).toBe("");
  });
});
