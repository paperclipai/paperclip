import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TextAttachmentPreview } from "./TaskAttachmentPanel";

describe("attachment Markdown media", () => {
  it("renders uploaded image references without loading or preloading their URLs", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <TextAttachmentPreview
          title="report.md"
          markdown
          text={[
            "# Report",
            "![External image](https://images.example/tracker.png)",
            "![Local image](/api/attachments/image-id/content)",
            "![Inline image](data:image/png;base64,iVBORw0KGgo=)",
          ].join("\n\n")}
          downloadUrl="/api/attachments/report-id/content?download=1"
        />
      </ThemeProvider>,
    );
    expect(html).toContain("Report</h1>");
    expect(html).toContain("data-markdown-image-reference");
    expect(html).toContain("External image");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('rel="preload"');
    expect(html).not.toContain('src="https://images.example/');
    expect(html).toContain("/api/attachments/report-id/content?download=1");
  });
});
