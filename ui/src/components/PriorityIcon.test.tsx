// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriorityIcon } from "./PriorityIcon";

describe("PriorityIcon", () => {
  it("uses an accessible native button for the icon-only picker trigger", () => {
    const html = renderToStaticMarkup(<PriorityIcon priority="medium" onChange={() => {}} />);

    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="Change priority (current: Medium)"');
  });
});
