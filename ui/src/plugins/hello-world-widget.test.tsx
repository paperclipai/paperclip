import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelloWorldDashboardWidget } from "../../../packages/plugins/examples/plugin-hello-world-example/src/ui/index.js";

describe("HelloWorldDashboardWidget", () => {
  it("renders the hello world widget copy and company context", () => {
    const html = renderToStaticMarkup(
      <HelloWorldDashboardWidget
        context={{
          companyId: "company-123",
          companyPrefix: null,
          projectId: null,
          entityId: null,
          entityType: null,
          userId: null,
        }}
      />,
    );

    expect(html).toContain('aria-label="Hello world plugin widget"');
    expect(html).toContain("Hello world");
    expect(html).toContain(
      "This widget was added by @paperclipai/plugin-hello-world-example.",
    );
    expect(html).toContain("Company context: company-123");
  });
});
