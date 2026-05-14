export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function issueLink(identifier: string, text?: string): string {
  return `<a href="https://paperclip.avva.aero/CRE/issues/${encodeURIComponent(identifier)}">${escapeHtml(text ?? identifier)}</a>`;
}
