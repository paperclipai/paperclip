import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EntityRow } from "./EntityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("EntityRow", () => {
  it("keeps caller text color classes on linked rows", () => {
    const markup = renderToStaticMarkup(
      <EntityRow
        title="Left project"
        to="/projects/left-project"
        className="group text-foreground/55"
      />,
    );

    expect(markup).toContain("text-foreground/55");
    expect(markup).not.toContain("text-inherit");
  });
});
