/** New identity files use a portable basename and a fixed Markdown extension. */
export function markdownFileName(prefix: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix) ? `${prefix}.md` : null;
}
