// @vitest-environment jsdom

import type { AnchorHTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntityRow } from "./EntityRow";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    onClick,
    to,
    ...props
  }: {
    children: ReactNode;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    to: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={to}
      onClick={onClick}
      {...props}
    >
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}));

describe("EntityRow", () => {
  afterEach(() => {
    cleanup();
    navigateMock.mockReset();
  });

  it("navigates when trailing metadata outside the main link is clicked", () => {
    render(
      <EntityRow
        title="Builder Bot"
        to="/agents/agent-1"
        trailingOutsideLink
        trailing={<span>idle 5m ago</span>}
      />,
    );

    fireEvent.click(screen.getByText("idle 5m ago"));

    expect(navigateMock).toHaveBeenCalledWith("/agents/agent-1");
  });

  it("does not hijack clicks from trailing interactive controls", () => {
    render(
      <EntityRow
        title="Builder Bot"
        to="/agents/agent-1"
        trailingOutsideLink
        trailing={<button type="button">Open run</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open run" }));

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
