// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { PaperclipLoading } from "./AnimatedPaperclipIcon";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("PaperclipLoading", () => {
  it("localizes the accessible loading message without changing the decorative icon", async () => {
    await i18n.changeLanguage("ru");
    const html = renderToStaticMarkup(<PaperclipLoading />);
    expect(html).toContain('<span class="sr-only">Загрузка…</span>');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
  });
  it("renders an accessible full-page loading state", () => {
    const html = renderToStaticMarkup(<PaperclipLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-dvh");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<span class="sr-only">Loading…</span>');
  });

  it("allows containing layouts to override the full-page height", () => {
    const html = renderToStaticMarkup(<PaperclipLoading className="min-h-0" />);

    expect(html).toContain("min-h-0");
    expect(html).not.toContain("min-h-dvh");
  });
});
