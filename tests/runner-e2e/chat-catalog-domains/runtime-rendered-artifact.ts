import type { ChatCatalogContext } from "../chat-catalog-contract.js";
export interface RuntimeRenderedNode { tag: string; role: string | null; text: string; href: string | null; inNavigation: boolean; color: string; background: string;
  /** FORM nodes only: a visible labelled email field and a visible submit control inside the form. */
  form?: { labelledField: boolean; submit: boolean } }
/** Render only independently downloaded artifact bytes, with no scripts, network or authenticated storage. */
export async function renderRuntimeArtifact(ctx: ChatCatalogContext, html: string): Promise<RuntimeRenderedNode[]> {
  if (Buffer.byteLength(html) > 262_144) throw new Error("Rendered runtime artifact exceeds its registered bounded size");
  const browser = ctx.input.page.context().browser(); if (!browser) throw new Error("Actual rendered artifact inspection requires the existing browser");
  const preview = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await preview.newPage(); await page.route("**/*", route => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await page.locator("body, main, section, header, h1, h2, h3, p, button, a, nav, form, [role]").evaluateAll(elements => {
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
      const formShape = (form: Element) => {
        const fields = [...form.querySelectorAll("input, textarea")].filter(field => visible(field)
          && !["hidden", "submit", "button", "reset", "checkbox", "radio", "image"].includes((field.getAttribute("type") ?? "text").toLowerCase()));
        // A real accessible name: aria-label text, an existing aria-labelledby target with text, or a
        // wrapping/for label with text. A signup field takes an email address.
        const labelled = (field: Element) => !!field.getAttribute("aria-label")?.trim()
          || (field.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).some(id => !!form.ownerDocument.getElementById(id)?.textContent?.trim())
          || !!field.closest("label")?.textContent?.trim()
          || (!!field.id && [...form.ownerDocument.querySelectorAll("label")].some(label => label.getAttribute("for") === field.id && !!label.textContent?.trim()));
        // An email entry: type or autocomplete email, or a text field whose own label, name or placeholder says
        // email. A search field (type search, or labelled only "Search") is not a signup field.
        const accessibleName = (field: Element) => [field.getAttribute("aria-label"), field.closest("label")?.textContent,
          ...(field.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map(id => form.ownerDocument.getElementById(id)?.textContent),
          ...(field.id ? [...form.ownerDocument.querySelectorAll("label")].filter(label => label.getAttribute("for") === field.id).map(label => label.textContent) : [])].join(" ");
        const emailField = (field: Element) => { const type = (field.getAttribute("type") ?? "text").toLowerCase();
          return type === "email" || /\bemail\b/i.test(field.getAttribute("autocomplete") ?? "")
            || (type === "text" && /\be-?mail\b/i.test([accessibleName(field), field.getAttribute("name"), field.getAttribute("placeholder")].join(" "))); };
        const submit = [...form.querySelectorAll("button, input[type=submit], input[type=image]")].some(control => visible(control)
          && !["button", "reset"].includes((control.getAttribute("type") ?? "submit").toLowerCase()));
        return { labelledField: fields.some(field => labelled(field) && emailField(field)), submit };
      };
      return elements.filter(visible).map(element => { const style = getComputedStyle(element);
        return { tag: element.tagName, role: element.getAttribute("role"), text: text(element) || element.getAttribute("aria-label") || "", href: element.getAttribute("href"),
          inNavigation: !!element.closest('nav, [role="navigation"]'), color: style.color, background: style.backgroundColor,
          ...(element.tagName === "FORM" ? { form: formShape(element) } : {}) }; });
    });
  } finally { await preview.close(); }
}
/** Closed sub-results of the single-page check, for diagnosis without retaining page text. */
export function simplerWebsiteChecks(nodes: RuntimeRenderedNode[]) {
  // A visible heading, and the product named somewhere visible. The request asked for a heading,
  // not for the brand inside it (a tagline H1 under a brand header is a natural design).
  const headline = nodes.some(node => (node.tag === "H1" || node.role === "heading") && node.text.trim().length > 0)
    && nodes.some(node => /\bAcorn\s+Notes\b/i.test(node.text));
  // A visible product paragraph; the request never named a <main> landmark.
  const content = nodes.some(node => ["MAIN", "SECTION", "P"].includes(node.tag) && node.text.length >= 40);
  // A labelled signup action: structurally, a visible form with a labelled email field and a submit
  // control, whatever its button says ("Start writing free" is as valid as "Sign up"); or a visible
  // control that is itself labelled as a signup action.
  const signup = nodes.some(node => node.tag === "FORM" && node.form?.labelledField === true && node.form.submit === true)
    || nodes.some(node => ["BUTTON", "A"].includes(node.tag) && /sign.?up|subscribe|join|early access/i.test(node.text));
  const tabbed = nodes.some(node => ["tab", "tablist", "tabpanel"].includes(node.role ?? ""));
  const multiPage = nodes.some(node => node.tag === "A" && node.inNavigation && !!node.href && !/^#|^\s*$/.test(node.href));
  return { headline, content, signup, tabbed, multiPage };
}
export function hasSimplerWebsite(nodes: RuntimeRenderedNode[]) {
  const { headline, content, signup, tabbed, multiPage } = simplerWebsiteChecks(nodes);
  return headline && content && signup && !tabbed && !multiPage;
}
