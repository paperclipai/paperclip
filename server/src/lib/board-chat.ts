export function deriveBoardChatIssueTitle(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return "New chat";
  if (singleLine.length <= 80) return singleLine;
  return `${singleLine.slice(0, 77).trimEnd()}...`;
}
