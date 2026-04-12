import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

export interface SanitizeOptions {
  allowStyles?: boolean;
  maxLength?: number;
}

export function sanitizeHtml(
  html: string,
  options: SanitizeOptions = {}
): { sanitized: string; warnings: string[] } {
  const warnings: string[] = [];

  const config = {
    ALLOWED_TAGS: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "strike",
      "del",
      "s",
      "blockquote",
      "q",
      "cite",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "a",
      "abbr",
      "acronym",
      "address",
      "img",
      "figure",
      "figcaption",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "div",
      "span",
      "header",
      "footer",
      "main",
      "section",
      "article",
      "aside",
      "nav",
      "pre",
      "code",
      "kbd",
      "samp",
      "var",
      "details",
      "summary",
      "mark",
      "small",
      "sub",
      "sup",
      "time",
      "svg",
      "circle",
      "rect",
      "ellipse",
      "line",
      "polyline",
      "polygon",
      "path",
      "text",
      "g",
      "defs",
      "use",
      "linearGradient",
      "radialGradient",
      "stop",
    ],
    ALLOWED_ATTR: [
      "href",
      "title",
      "alt",
      "src",
      "width",
      "height",
      "class",
      "id",
      "style",
      "target",
      "colspan",
      "rowspan",
      "data-*",
      "xmlns",
      "viewBox",
      "fill",
      "stroke",
      "stroke-width",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "x",
      "y",
      "x1",
      "y1",
      "x2",
      "y2",
      "points",
      "d",
      "transform",
      "opacity",
    ],
    FORBIDDEN_ATTR: ["onclick", "onload", "onerror", "onmouseover", "onmouseenter", "onmouseleave", "onsubmit", "onchange", "oninput"],
    ALLOW_DATA_ATTR: true,
  };

  const sanitized = DOMPurify.sanitize(html, config);

  const dirty = DOMPurify.removed;
  if (dirty.length > 0) {
    warnings.push(`Removed ${dirty.length} unsafe elements/attributes`);
  }

  return { sanitized, warnings };
}
