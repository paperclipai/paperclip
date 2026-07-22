/**
 * Normalize pasted markdown by removing common leading whitespace (dedent)
 * and normalizing line endings. This fixes formatting issues when pasting
 * content from terminals/consoles that add uniform indentation.
 */
export function normalizeMarkdown(text: string): string {
  // Normalize line endings
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const lines = result.split("\n");
  if (lines.length <= 1) return result;

  // Find minimum indentation across non-empty lines
  let minIndent = Infinity;
  let indentStyle: "spaces" | "tabs" | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = line.match(/^(\s+)/);
    if (match) {
      const leadingWhitespace = match[1];
      const currentStyle = leadingWhitespace.includes("\t") ? "tabs" : "spaces";
      if (indentStyle && indentStyle !== currentStyle) {
        return result;
      }
      indentStyle = currentStyle;
      minIndent = Math.min(minIndent, leadingWhitespace.length);
    } else {
      minIndent = 0;
      break;
    }
  }

  // Strip common indent and trim whitespace-only lines
  if (minIndent > 0 && minIndent < Infinity) {
    result = lines
      .map((line) => {
        if (line.trim() === "") return "";
        return line.slice(minIndent);
      })
      .join("\n");
  }

  return result;
}
