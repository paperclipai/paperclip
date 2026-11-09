// Detects leaked model/tool generation-wrapper markup in documentation.
//
// When a generator writes its raw completion envelope into a file, tags such as
// a trailing `</content>` or `</invoke>` escape into the committed prose. Plain
// link and OKF validation do not notice them, so `docs:validate` scans every
// markdown file with this detector and fails on the exact file and line. Prose
// docs never legitimately contain these tags, so any match is a defect.
export const WRAPPER_MARKUP =
  /<\/?(?:antml:[a-z0-9_-]+|content|invoke|parameter|function_calls|function_results)\b[^>]*>/i;

export function wrapperMarkupIn(markdown) {
  const hits = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(WRAPPER_MARKUP);
    if (match) {
      hits.push({ line: index + 1, tag: match[0] });
    }
  }
  return hits;
}
