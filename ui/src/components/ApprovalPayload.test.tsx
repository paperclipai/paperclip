// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/issues", () => ({
  issuesApi: { get: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function withProviders(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
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
        withProviders(
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
          />,
        ),
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

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        withProviders(
          <ApprovalPayloadRenderer
            type="request_board_approval"
            hidePrimaryTitle
            payload={{
              title: "Reply with an ASCII frog",
              summary: "Board asked for approval before posting the frog.",
            }}
          />,
        ),
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

describe("BoardApprovalPayloadContent markdown rendering", () => {
  it("renders a ## header in summary as an h2 element", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{ summary: "## Analysis\n\nThis is the summary." }}
        />,
      ),
    );
    expect(html).toContain("<h2");
    expect(html).toContain("Analysis");
    expect(html).toContain("This is the summary.");
  });

  it("renders a bulleted list in summary as ul and li elements", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{ summary: "- Item one\n- Item two" }}
        />,
      ),
    );
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("Item one");
    expect(html).toContain("Item two");
  });

  it("renders a ## header in recommendedAction as an h2 element", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{ recommendedAction: "## Approve\n\nApprove this action." }}
        />,
      ),
    );
    expect(html).toContain("<h2");
    expect(html).toContain("Approve");
    expect(html).toContain("Approve this action.");
  });

  it("renders a bulleted list in recommendedAction as ul and li elements", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{ recommendedAction: "- Step one\n- Step two" }}
        />,
      ),
    );
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("Step one");
  });

  it("renders plain prose summary without adding list or heading markup", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{ summary: "This is a simple one-line summary." }}
        />,
      ),
    );
    expect(html).toContain("This is a simple one-line summary.");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<h2");
  });

  it("renders plain prose recommendedAction without markdown markup", () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{ recommendedAction: "Approve the deployment." }}
        />,
      ),
    );
    expect(html).toContain("Approve the deployment.");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<h2");
  });
});
