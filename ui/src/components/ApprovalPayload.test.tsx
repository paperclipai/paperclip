// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";
import { ThemeProvider } from "../context/ThemeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });

  it("labels a secret operation from its free-text title", () => {
    // The board has to read what it is authorizing: the server executes a
    // `secret_operation` the moment it is approved.
    expect(
      approvalLabel("secret_operation", {
        op: "delete",
        targetId: "7d2e9a41-6b3c-4f5d-8e19-2a4b6c8d0e1f",
        title: "Delete the superseded gateway token",
      }),
    ).toBe("Secret Operation: Delete the superseded gateway token");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
              recommendedAction: "Approve the frog reply.",
              nextActionOnApproval: "Post the frog comment on the issue.",
              risks: ["The frog might be too powerful."],
              proposedComment: "(o)<",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("renders markdown in board approval prose fields", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              summary: "**Bold** and `code` and [a link](https://example.com).",
              recommendedAction: "Approve the **frog** reply.",
              nextActionOnApproval: "Post the `frog` comment.",
              risks: ["The **frog** might be too powerful."],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(4);

    const summary = bodies[0];
    expect(summary.querySelector("strong")?.textContent).toBe("Bold");
    expect(summary.querySelector("code")?.textContent).toBe("code");
    const link = summary.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.textContent).toBe("a link");

    // The raw markdown characters must not survive into the rendered text.
    expect(container.textContent).not.toContain("**Bold**");
    expect(container.textContent).not.toContain("[a link](https://example.com)");

    expect(bodies[1].querySelector("strong")?.textContent).toBe("frog");
    expect(bodies[2].querySelector("code")?.textContent).toBe("frog");
    expect(bodies[3].querySelector("strong")?.textContent).toBe("frog");

    act(() => {
      root.unmount();
    });
  });

  it("does not nest a second bullet when a risk is authored as a markdown list item", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            payload={{
              title: "Reply with an ASCII frog",
              risks: [
                "- **Leading dash** risk.",
                "* Leading star risk.",
                "• Leading dot risk.",
                "1. Leading number risk.",
                "2) Leading paren risk.",
              ],
            }}
          />
        </ThemeProvider>,
      );
    });

    const bodies = container.querySelectorAll(".paperclip-markdown");
    expect(bodies.length).toBe(5);
    for (const body of bodies) {
      expect(body.querySelector("ul")).toBeNull();
      expect(body.querySelector("ol")).toBeNull();
      expect(body.querySelector("li")).toBeNull();
    }

    expect(bodies[0].querySelector("strong")?.textContent).toBe("Leading dash");
    expect(container.textContent).toContain("Leading star risk.");
    expect(container.textContent).toContain("Leading dot risk.");
    expect(container.textContent).toContain("Leading number risk.");
    expect(container.textContent).toContain("Leading paren risk.");
    expect(container.textContent).not.toContain("- **Leading dash**");

    act(() => {
      root.unmount();
    });
  });

  it("renders every risk when two entries collapse to the same text after marker stripping", () => {
    const root = createRoot(container);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      act(() => {
        root.render(
          <ThemeProvider>
            <ApprovalPayloadRenderer
              type="request_board_approval"
              payload={{
                title: "Reply with an ASCII frog",
                risks: ["- Low probability", "* Low probability"],
              }}
            />
          </ThemeProvider>,
        );
      });

      expect(container.querySelectorAll(".paperclip-markdown").length).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      console.error = originalError;
      act(() => {
        root.unmount();
      });
    }
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer
            type="request_board_approval"
            hidePrimaryTitle
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
            }}
          />
        </ThemeProvider>,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

describe("SecretOperation card", () => {
  const TARGET = "7d2e9a41-6b3c-4f5d-8e19-2a4b6c8d0e1f";

  function render(payload: Record<string, unknown>, hidePrimaryTitle = false) {
    // Static render: the board must see what it authorizes, and this needs no
    // effects or interaction.
    return renderToStaticMarkup(
      <ThemeProvider>
        <ApprovalPayloadRenderer
          type="secret_operation"
          payload={payload}
          hidePrimaryTitle={hidePrimaryTitle}
        />
      </ThemeProvider>,
    );
  }

  it("shows operation, target and new name for a rename", () => {
    const html = render({ op: "rename", targetId: TARGET, newName: "gateway-client-secret" });
    expect(html).toContain("Operation");
    expect(html).toContain("rename");
    expect(html).toContain(TARGET);
    expect(html).toContain("New name");
    expect(html).toContain("gateway-client-secret");
  });

  it("shows operation and target but no new name for a delete", () => {
    const html = render({ op: "delete", targetId: TARGET });
    expect(html).toContain("delete");
    expect(html).toContain(TARGET);
    expect(html).not.toContain("New name");
  });

  it("keeps the operation fields when the title is hidden", () => {
    const html = render(
      { op: "rename", targetId: TARGET, newName: "gateway-client-secret", title: "Rename it" },
      true,
    );
    expect(html).not.toContain("Rename it");
    expect(html).toContain(TARGET);
    expect(html).toContain("gateway-client-secret");
  });
});
