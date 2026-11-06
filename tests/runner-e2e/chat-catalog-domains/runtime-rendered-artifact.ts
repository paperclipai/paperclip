import type { ChatCatalogContext } from "../chat-catalog-contract.js";
export interface RuntimeRenderedNode { tag: string; role: string | null; text: string; href: string | null; inNavigation: boolean; color: string; background: string }
/** Render only independently downloaded artifact bytes, with no scripts, network or authenticated storage. */
export async function renderRuntimeArtifact(ctx: ChatCatalogContext, html: string): Promise<RuntimeRenderedNode[]> {
  if (Buffer.byteLength(html) > 262_144) throw new Error("Rendered runtime artifact exceeds its registered bounded size");
  const browser = ctx.input.page.context().browser(); if (!browser) throw new Error("Actual rendered artifact inspection requires the existing browser");
  const preview = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await preview.newPage(); await page.route("**/*", route => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await page.locator("body, main, section, header, h1, h2, h3, p, button, a, nav, [role]").evaluateAll(elements => {
      if (elements.length > 2_000) throw new Error("Rendered artifact exceeds its finite DOM inspection bound");
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect(); if (rect.width < 2 || rect.height < 2 || rect.right <= 0 || rect.left >= innerWidth) return false;
        for (let node: Element | null = element; node; node = node.parentElement) { const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false; }
        return true;
      };
      const text = (element: Element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), parts: string[] = []; let node: Node | null; let count = 0;
        while ((node = walker.nextNode())) { if (++count > 10_000) throw new Error("Rendered artifact exceeds its finite text inspection bound");
          if (node.parentElement && visible(node.parentElement) && node.textContent?.trim()) parts.push(node.textContent.trim()); }
        return parts.join(" ").replace(/\s+/g, " ").slice(0, 20_000);
      };
      return elements.filter(visible).map(element => { const style = getComputedStyle(element);
        return { tag: element.tagName, role: element.getAttribute("role"), text: text(element) || element.getAttribute("aria-label") || "", href: element.getAttribute("href"),
          inNavigation: !!element.closest('nav, [role="navigation"]'), color: style.color, background: style.backgroundColor }; });
    });
  } finally { await preview.close(); }
}
export function hasSimplerWebsite(nodes: RuntimeRenderedNode[]) {
  const headline = nodes.some(node => (node.tag === "H1" || node.role === "heading") && /\bAcorn\s+Notes\b/i.test(node.text));
  const content = nodes.some(node => node.tag === "MAIN" && node.text.length >= 40);
  const signup = nodes.some(node => ["BUTTON", "A"].includes(node.tag) && /sign.?up|subscribe|join|early access/i.test(node.text));
  const tabbed = nodes.some(node => ["tab", "tablist", "tabpanel"].includes(node.role ?? ""));
  const multiPage = nodes.some(node => node.tag === "A" && node.inNavigation && !!node.href && !/^#|^\s*$/.test(node.href));
  return headline && content && signup && !tabbed && !multiPage;
}
