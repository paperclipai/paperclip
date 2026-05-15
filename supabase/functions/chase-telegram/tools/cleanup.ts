export function cleanTaskTitle(title: string, assigneeName?: string): string {
  let cleaned = title;

  if (assigneeName) {
    const escaped = assigneeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = new RegExp(`^${escaped}\\s*:\\s*`, "i");
    cleaned = cleaned.replace(prefix, "");
  }

  cleaned = cleaned.trim();

  if (cleaned.length > 0) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }

  cleaned = cleaned.replace(/\?+$/, "");
  cleaned = cleaned.replace(/[\s:]+$/, "");
  cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, "$1");

  return cleaned;
}

export function cleanTaskDescription(desc: string): string {
  let cleaned = desc.trim();

  if (cleaned.length > 0) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }

  cleaned = cleaned.replace(/\?+$/, "");
  cleaned = cleaned.replace(/\s+$/, "");
  cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, "$1");

  return cleaned;
}
