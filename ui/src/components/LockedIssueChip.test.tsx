// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockedIssueChip, isLockedIssueStub } from "./LockedIssueChip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

describe("LockedIssueChip", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  function renderChip(node: React.ReactNode) {
    root = createRoot(container);
    act(() => root!.render(node));
  }

  it("shows the identifier and a lock icon, never a title, and is not a link", () => {
    renderChip(<LockedIssueChip identifier="PAP-1234" />);
    const chip = container.querySelector('[data-testid="locked-issue-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("SPAN");
    expect(container.querySelector("a")).toBeNull();
    expect(chip?.querySelector("svg")).not.toBeNull();
    expect(chip?.textContent).toContain("PAP-1234");
    expect(chip?.getAttribute("aria-label")).toContain("private");
  });

  it("falls back to a neutral Private label when the identifier is withheld", () => {
    renderChip(<LockedIssueChip identifier={null} />);
    const chip = container.querySelector('[data-testid="locked-issue-chip"]');
    expect(chip?.textContent).toContain("Private");
  });

  it("uses a dashed, muted border (design-token classes)", () => {
    renderChip(<LockedIssueChip identifier="PAP-9" />);
    const chip = container.querySelector('[data-testid="locked-issue-chip"]');
    expect(chip?.className).toContain("border-dashed");
    expect(chip?.className).toContain("text-muted-foreground");
  });
});

describe("isLockedIssueStub", () => {
  it("recognizes only objects with locked === true", () => {
    expect(isLockedIssueStub({ id: "x", identifier: "PAP-1", locked: true })).toBe(true);
    expect(isLockedIssueStub({ id: "x", identifier: "PAP-1", title: "t", status: "todo" })).toBe(false);
    expect(isLockedIssueStub({ locked: false })).toBe(false);
    expect(isLockedIssueStub(null)).toBe(false);
    expect(isLockedIssueStub(undefined)).toBe(false);
  });
});
