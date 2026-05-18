// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SystemNotice } from "./SystemNotice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe("SystemNotice", () => {
  it("renders the warning tone label and body in a single status container", () => {
    const node = render(
      <SystemNotice
        tone="warning"
        body="Paperclip needs a disposition before this issue can continue."
      />,
    );

    const status = node.querySelectorAll('[role="status"]');
    expect(status.length).toBe(1);
    expect(status[0]?.getAttribute("aria-label")).toBe("System warning");
    expect(node.textContent).toContain(
      "Paperclip needs a disposition before this issue can continue.",
    );
  });

  it("uses System alert label for danger tone", () => {
    const node = render(
      <SystemNotice tone="danger" body="Recovery escalated to CTO." />,
    );

    const status = node.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("System alert");
  });

  it("uses neutral System notice label by default", () => {
    const node = render(
      <SystemNotice tone="neutral" body="Reassigned to ClaudeFixer." />,
    );

    const status = node.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("System notice");
  });

  it("collapses metadata details by default and toggles aria-expanded on click", () => {
    const node = render(
      <SystemNotice
        tone="warning"
        body="Needs a disposition."
        metadata={[
          {
            title: "Required action",
            rows: [
              {
                kind: "issue",
                label: "Source issue",
                identifier: "PAP-3440",
                href: "/PAP/issues/PAP-3440",
              },
            ],
          },
        ]}
      />,
    );

    const button = node.querySelector("button[aria-expanded]");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-controls")).not.toBeNull();
    expect(node.textContent).not.toContain("PAP-3440");

    act(() => {
      (button as HTMLButtonElement).click();
    });

    const reopened = node.querySelector("button[aria-expanded]");
    expect(reopened?.getAttribute("aria-expanded")).toBe("true");
    expect(node.textContent).toContain("PAP-3440");
  });

  it("renders metadata expanded when detailsDefaultOpen is true", () => {
    const node = render(
      <SystemNotice
        tone="warning"
        body="Needs a disposition."
        detailsDefaultOpen
        metadata={[
          {
            rows: [{ kind: "text", label: "Suggested action", value: "Pick a disposition" }],
          },
        ]}
      />,
    );

    const button = node.querySelector("button[aria-expanded]");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(node.textContent).toContain("Suggested action");
    expect(node.textContent).toContain("Pick a disposition");
  });

  it("hides the details affordance when no metadata is provided", () => {
    const node = render(<SystemNotice tone="warning" body="Short notice." />);

    expect(node.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("renders typed metadata rows with hrefs when present", () => {
    const node = render(
      <SystemNotice
        tone="danger"
        body="Recovery blocked"
        detailsDefaultOpen
        metadata={[
          {
            rows: [
              {
                kind: "issue",
                label: "Recovery issue",
                identifier: "PAP-3440",
                href: "/PAP/issues/PAP-3440",
                title: "Disposition recovery",
              },
              {
                kind: "agent",
                label: "Owner",
                name: "CTO",
                href: "/PAP/agents/cto",
              },
              {
                kind: "run",
                label: "Source run",
                runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
                href: "/PAP/agents/codexcoder/runs/9cdba892",
                status: "succeeded",
              },
            ],
          },
        ]}
      />,
    );

    const links = Array.from(node.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toContain("/PAP/issues/PAP-3440");
    expect(links).toContain("/PAP/agents/cto");
    expect(links).toContain("/PAP/agents/codexcoder/runs/9cdba892");
    expect(node.textContent).toContain("PAP-3440");
    expect(node.textContent).toContain("Disposition recovery");
    expect(node.textContent).toContain("CTO");
    expect(node.textContent).toContain("succeeded");
  });

  it("renders metadata link rows as plain text when href is missing", () => {
    const node = render(
      <SystemNotice
        tone="neutral"
        body="Reassigned"
        detailsDefaultOpen
        metadata={[
          {
            rows: [
              { kind: "agent", label: "Reassigned to", name: "ClaudeFixer" },
              { kind: "run", label: "Run", runId: "abc12345" },
              { kind: "issue", label: "Issue", identifier: "PAP-1" },
            ],
          },
        ]}
      />,
    );

    expect(node.querySelectorAll("a").length).toBe(0);
    expect(node.textContent).toContain("ClaudeFixer");
    expect(node.textContent).toContain("abc12345");
    expect(node.textContent).toContain("PAP-1");
  });
});
