/**
 * Copies text to the clipboard with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is only available in secure contexts (HTTPS or localhost).
 * On LAN HTTP (e.g. http://192.168.x.x), `window.isSecureContext` is false and
 * `navigator.clipboard` is undefined — the operation silently fails.
 *
 * This utility checks `window.isSecureContext` before using the Clipboard API
 * and falls back to the classic `document.execCommand("copy")` technique when
 * the modern API is unavailable.
 */
export async function copyTextWithFallback(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    const success = document.execCommand("copy");
    if (!success) throw new Error("execCommand copy failed");
  } finally {
    document.body.removeChild(textarea);
  }
}
