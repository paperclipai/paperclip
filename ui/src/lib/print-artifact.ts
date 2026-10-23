import type { CompanyArtifact } from "@/api/artifacts";

/**
 * 
 * Aupy Consulting
 * 2026
 *
 * Where the printable bytes of an artifact live.
 *
 * Artifact kinds differ: attachment and work-product artifacts expose a file
 * (`contentPath` / `openPath` / `downloadPath`), while `document` artifacts
 * carry no file at all. A document's body lives on its issue and is served by
 * `GET /api/issues/:issueId/documents/:key`, and its `href` points at
 * `/…/issues/<ID>#document-<key>`.
 */
export type ArtifactPrintSource =
  | { kind: "file"; url: string }
  | { kind: "document"; issueId: string; documentKey: string }
  | { kind: "none" };

const DOCUMENT_HREF_MARKER = "#document-";

export function resolvePrintSource(
  artifact: Pick<CompanyArtifact, "contentPath" | "openPath" | "downloadPath" | "href" | "issue">,
): ArtifactPrintSource {
  const fileUrl = artifact.openPath ?? artifact.contentPath ?? artifact.downloadPath;
  if (fileUrl) return { kind: "file", url: fileUrl };

  const href = artifact.href ?? "";
  const markerIndex = href.indexOf(DOCUMENT_HREF_MARKER);
  if (markerIndex >= 0 && artifact.issue?.id) {
    const documentKey = href.slice(markerIndex + DOCUMENT_HREF_MARKER.length);
    if (documentKey) return { kind: "document", issueId: artifact.issue.id, documentKey };
  }

  return { kind: "none" };
}

/**
 * How a file artifact gets printed, decided from its recorded content type
 * before a single byte is fetched.
 *
 * - `inline`: the browser's own viewer renders the file (PDF, image) and
 *   printing happens from there. A PDF inside a frame prints as blank pages,
 *   which is why these are never printed in-app.
 * - `text`: plain text, Markdown, JSON and similar are fetched and printed as
 *   preformatted text.
 * - `handoff`: everything else — HTML, SVG, video and binaries such as DOCX —
 *   is handed to the browser exactly like the Open action does. Untrusted
 *   markup is never fetched into an app-origin document, and a ZIP or DOCX is
 *   never printed as megabytes of binary noise.
 */
export type ArtifactFilePrintPlan = "inline" | "text" | "handoff";

const PRINTABLE_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
]);

export function planFilePrint(
  contentType: string | null | undefined,
  mediaKind?: CompanyArtifact["mediaKind"],
): ArtifactFilePrintPlan {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();

  if (type) {
    if (type.startsWith("text/html") || type.includes("svg")) return "handoff";
    if (type === "application/pdf" || type.startsWith("image/")) return "inline";
    if (type.startsWith("text/") || type.endsWith("+json") || type.endsWith("+xml")) return "text";
    if (PRINTABLE_APPLICATION_TYPES.has(type)) return "text";
    return "handoff";
  }

  if (mediaKind === "image") return "inline";
  if (mediaKind === "text") return "text";
  return "handoff";
}

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Allow-list a URL before it reaches an `href` or `src`.
 *
 * The print document is written into a same-origin window, so a `javascript:`
 * or `data:` URL taken from a document body would run with the app's own
 * authority. Relative paths and fragments are kept; any other scheme is
 * dropped so the caller renders plain text instead.
 */
export function safeArtifactUrl(value: string): string | null {
  const url = value.trim().replace(/[\u0000-\u0020]+/g, "");
  if (!url) return null;

  const scheme = URL_SCHEME.exec(url);
  if (!scheme) return url;
  return SAFE_URL_PROTOCOLS.has(`${scheme[1].toLowerCase()}:`) ? url : null;
}

const PRINT_STYLES = [
  "html,body{background:#fff;color:#111;margin:0}",
  "body{padding:14mm 16mm;font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}",
  "h1{font-size:21px;margin:0 0 10px}h2{font-size:18px;margin:18px 0 8px}h3{font-size:16px;margin:16px 0 6px}",
  "h4,h5,h6{font-size:15px;margin:14px 0 6px}h1,h2,h3{break-after:avoid-page}",
  "p,li{margin:0 0 8px}ul,ol{margin:0 0 10px 20px}hr{border:0;border-top:1px solid #bbb;margin:14px 0}",
  "code{font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;background:#f3f3f3;padding:1px 3px;border-radius:3px}",
  "pre{font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-wrap:break-word;",
  "background:#f7f7f7;border:1px solid #ddd;border-radius:4px;padding:8px;margin:0 0 10px;break-inside:avoid-page}",
  "pre.tbl{background:#fff;border:0;padding:0;font-size:11.5px}",
  "blockquote{margin:0 0 10px;padding-left:10px;border-left:3px solid #ccc;color:#333}",
  "a{color:#111}img{max-width:100%}",
].join("");

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    // Images first, so `![alt](url)` is never swallowed by the link pattern.
    .replace(IMAGE_PATTERN, (_match, alt: string, url: string) => {
      const safe = safeArtifactUrl(url);
      return safe ? `<img src="${safe}" alt="${alt}">` : alt;
    })
    .replace(LINK_PATTERN, (_match, label: string, url: string) => {
      const safe = safeArtifactUrl(url);
      return safe
        ? `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : label;
    });
}

/**
 * Deliberately small Markdown subset renderer for printing issue documents:
 * headings, nested lists, blockquotes, fenced code, tables (as fixed-width
 * blocks), horizontal rules, paragraphs, and inline code / emphasis / links /
 * images. Printing a document should never depend on the app shell being laid
 * out for paper.
 */
export function documentMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inCode = false;

  /** Open list levels, outermost first. */
  const listStack: Array<{ tag: "ul" | "ol"; indent: number; liOpen: boolean }> = [];
  /** The whole list is buffered so an item and its nested list stay contiguous. */
  let listHtml = "";

  /** An `<li>` stays open so an indented child list nests inside it. */
  const closeLi = () => {
    const top = listStack[listStack.length - 1];
    if (top?.liOpen) {
      listHtml += "</li>";
      top.liOpen = false;
    }
  };

  const closeLists = (depth = 0) => {
    while (listStack.length > depth) {
      closeLi();
      listHtml += `</${listStack.pop()!.tag}>`;
    }
    if (listHtml) {
      out.push(listHtml);
      listHtml = "";
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^```/.test(line.trim())) {
      closeLists();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    if (!line.trim()) {
      closeLists();
      continue;
    }
    if (/^\|/.test(line.trim())) {
      closeLists();
      const rows: string[] = [];
      while (index < lines.length && /^\|/.test(lines[index].trim())) {
        rows.push(escapeHtml(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      out.push(`<pre class="tbl">${rows.join("\n")}</pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) {
      closeLists();
      out.push("<hr>");
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const tag = bullet ? "ul" : "ol";
      const indent = (bullet ?? numbered)![1].length;
      const text = (bullet ?? numbered)![2];

      // Close any list level this item is outdented from.
      while (listStack.length && indent < listStack[listStack.length - 1].indent) {
        closeLi();
        listHtml += `</${listStack.pop()!.tag}>`;
      }

      const top = listStack[listStack.length - 1];
      if (top && indent <= top.indent) {
        // A sibling item, possibly switching bullet style: the previous <li> ends here.
        closeLi();
        if (top.tag !== tag) {
          listHtml += `</${top.tag}>`;
          listStack.pop();
        }
      }

      const current = listStack[listStack.length - 1];
      if (!current || indent > current.indent) {
        listHtml += `<${tag}>`;
        listStack.push({ tag, indent, liOpen: false });
      }

      listHtml += `<li>${renderInline(text)}`;
      listStack[listStack.length - 1].liOpen = true;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeLists();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    closeLists();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (inCode) out.push("</pre>");
  closeLists();
  return out.join("\n");
}

async function fetchDocumentMarkdown(issueId: string, documentKey: string): Promise<string> {
  const response = await fetch(
    `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(documentKey)}`,
    { credentials: "same-origin", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Document request failed with ${response.status}`);
  const payload = (await response.json()) as {
    body?: string;
    content?: string;
    document?: { body?: string };
  };
  return payload.body ?? payload.content ?? payload.document?.body ?? "";
}

function writePrintableShell(target: Window, title: string, bodyHtml: string): void {
  const documentRef = target.document;
  documentRef.open();
  documentRef.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<style>${PRINT_STYLES}</style></head><body>${bodyHtml}</body></html>`,
  );
  documentRef.close();
}

/** Let the viewer paint before printing: `load` can fire before the first frame. */
const PRINT_SETTLE_MS = 450;
/** Never leave a tab silently unprinted when the load event does not arrive. */
const PRINT_LOAD_TIMEOUT_MS = 5_000;

function printWindow(target: Window): void {
  try {
    target.focus();
    target.print();
  } catch {
    // The tab is open with the artifact in it; the user can print it directly.
  }
}

/** Print a shell this module wrote itself: the document is already complete. */
function printWhenReady(target: Window): void {
  window.setTimeout(() => printWindow(target), PRINT_SETTLE_MS);
}

/**
 * Print a tab that has been navigated to a file URL, once that file has loaded.
 *
 * A fixed delay is not enough here: a PDF or an image that takes longer than the
 * delay is still loading when the timer fires, and `print()` then produces blank
 * pages. Wait for the document's `load` event, then let the viewer paint. The
 * timer stays as a fallback so a document that never reports `load` — or a
 * cross-origin one, whose events are unreachable — is still printed rather than
 * silently doing nothing.
 */
function printAfterLoad(target: Window): void {
  let printed = false;
  const fire = () => {
    if (printed) return;
    printed = true;
    printWindow(target);
  };
  const settle = () => window.setTimeout(fire, PRINT_SETTLE_MS);

  try {
    target.addEventListener("load", settle, { once: true });
  } catch {
    // Cross-origin document: the event is unreachable, so the timer decides.
  }

  window.setTimeout(fire, PRINT_LOAD_TIMEOUT_MS);
}

/**
 * Print a single artifact, without the app shell around it.
 *
 * Opened as a top-level tab on purpose: a PDF inside a frame prints as blank
 * pages, and an off-screen frame is not reliably painted. The tab must be
 * opened while the click is still being handled, otherwise popup blockers drop
 * it. File artifacts are printed from the URL the attachment route serves — no
 * blob URLs, so arbitrary attachment markup never runs in an app-origin
 * document.
 */
export function printArtifact(artifact: CompanyArtifact): void {
  const source = resolvePrintSource(artifact);
  // Nothing to print: return without opening a tab, so a work product with no
  // file and no document body never flashes an empty window.
  if (source.kind === "none") return;

  const target = window.open("", "_blank");
  if (!target) {
    if (source.kind === "file") window.open(source.url, "_blank");
    return;
  }

  if (source.kind === "document") {
    fetchDocumentMarkdown(source.issueId, source.documentKey)
      .then((markdown) => {
        writePrintableShell(target, artifact.title, documentMarkdownToHtml(markdown));
        printWhenReady(target);
      })
      .catch(() => {
        writePrintableShell(
          target,
          artifact.title,
          `<h1>${escapeHtml(artifact.title)}</h1><p>This document could not be loaded for printing. Open it on ${escapeHtml(artifact.issue?.identifier ?? "the issue")} instead.</p>`,
        );
        printWhenReady(target);
      });
    return;
  }

  const plan = planFilePrint(artifact.contentType, artifact.mediaKind);

  if (plan === "inline") {
    target.location.replace(source.url);
    printAfterLoad(target);
    return;
  }

  if (plan === "handoff") {
    // The attachment route decides what happens: it serves HTML and other
    // untrusted files as a download, which is exactly what the Open action does.
    target.location.replace(source.url);
    return;
  }

  fetch(source.url, { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error(`Artifact request failed with ${response.status}`);
      return response.text();
    })
    .then((text) => {
      writePrintableShell(target, artifact.title, `<pre>${escapeHtml(text)}</pre>`);
      printWhenReady(target);
    })
    .catch(() => {
      try {
        target.location.replace(source.url);
      } catch {
        window.open(source.url, "_blank");
      }
    });
}
