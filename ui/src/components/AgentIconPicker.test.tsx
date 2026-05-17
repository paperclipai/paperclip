// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIconPicker";

describe("AgentIcon", () => {
  it("renders an uploaded avatar image before the symbolic icon fallback", () => {
    const html = renderToStaticMarkup(
      <AgentIcon
        icon="code"
        avatarUrl="/api/assets/avatar-1/content"
        className="h-full w-full"
      />,
    );

    expect(html).toContain('src="/api/assets/avatar-1/content"');
    expect(html).toContain("object-cover");
    expect(html).not.toContain("lucide-code");
  });
});
