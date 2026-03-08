// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeDetailCardHeader } from "./KnowledgeDetailCardHeader";

describe("KnowledgeDetailCardHeader", () => {
  it("adds explicit top padding so section titles do not stick to the card border", () => {
    const html = renderToStaticMarkup(
      <KnowledgeDetailCardHeader
        title="Content"
        description="Full shared context for future issue runs."
      />,
    );

    expect(html).toContain("pt-6");
  });
});
