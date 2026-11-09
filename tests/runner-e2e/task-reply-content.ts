import { markdownReplyContent } from "../../ui/src/lib/markdown-reply-content.js";
import { applyCompanyPrefix, extractCompanyPrefixFromPath } from "../../ui/src/lib/company-routes.js";
import { parseIssueReferenceFromHref } from "../../ui/src/lib/issue-reference.js";

export type ReplyContentPart = { text: string } | { href: string; label?: string; decorated?: boolean } | { checked: boolean };

function normalized(parts: ReplyContentPart[], pageUrl: string, source = false) {
  const result: ReplyContentPart[] = [];
  for (const part of parts) {
    if ("checked" in part) {
      if (typeof part.checked !== "boolean") return null;
      result.push({ checked: part.checked });
    } else if ("href" in part) {
      try {
        const issueRef = source ? parseIssueReferenceFromHref(part.href) : null;
        const href = issueRef ? applyCompanyPrefix(issueRef.href, extractCompanyPrefixFromPath(new URL(pageUrl).pathname)) : part.href;
        result.push({ href: new URL(href, pageUrl).href, label: part.label?.replace(/\s+/g, " ").trim(), decorated: part.decorated });
      } catch { return null; }
    } else {
      const text = part.text.replace(/\s+/g, " ");
      const previous = result.at(-1);
      if (previous && "text" in previous) previous.text = (previous.text + text).replace(/\s+/g, " ");
      else if (text) result.push({ text });
    }
  }
  const first = result[0], last = result.at(-1);
  if (first && "text" in first) first.text = first.text.trimStart();
  if (last && "text" in last) last.text = last.text.trimEnd();
  return result.filter(part => !("text" in part) || part.text);
}

/** Compare complete message content while allowing the UI to decorate a link
 * with an issue/document chip. Its exact destination still has to match.
 * Unsupported Markdown fails closed rather than stripping arbitrary syntax. */
export function taskReplyContentMatches(
  observation: { body: string; content?: ReplyContentPart[]; origin?: string; pageUrl?: string; knownCompanyPrefixes?: string[] },
  markdown: string,
) {
  if (observation.content) {
    // Bind the structured projection to the independently observed innerText.
    // A destination alone cannot attest to arbitrary visible wording.
    if (observation.content.some(part => "href" in part && (typeof part.label !== "string" || !part.label.trim()))) return false;
    const displayed = observation.content.map(part => "text" in part ? part.text : "href" in part ? part.label! : "").join("").replace(/\s+/g, " ").trim();
    if (displayed !== observation.body.replace(/\s+/g, " ").trim()) return false;
  }
  const parts = markdownReplyContent(markdown, observation.knownCompanyPrefixes);
  if (!parts) return false;
  const pageUrl = observation.pageUrl ?? observation.origin ?? "https://reply.invalid";
  const expected = normalized(parts, pageUrl, true);
  const actual = normalized(observation.content ?? [{ text: observation.body }], pageUrl);
  return expected !== null && actual !== null && expected.length === actual.length && expected.every((part, index) => {
    const displayed = actual[index]!;
    return "text" in part ? "text" in displayed && part.text === displayed.text
      : "href" in part ? "href" in displayed && part.href === displayed.href && (part.label === displayed.label || displayed.decorated === true)
        : "checked" in displayed && part.checked === displayed.checked;
  });
}
