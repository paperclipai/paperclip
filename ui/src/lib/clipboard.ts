export async function copyTextToClipboard(text: string): Promise<void> {
  // The async Clipboard API is only reliable in a secure context. Over plain
  // HTTP on a non-localhost host (e.g. a Tailscale name) `writeText` may resolve
  // without actually writing, so gate on `isSecureContext` and otherwise fall
  // through to the execCommand path below.
  const isSecure = typeof window === "undefined" || window.isSecureContext;
  if (isSecure && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for environments where the Clipboard API exists but is blocked.
    }
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard unavailable");
  }

  // Mirror the proven CopyText fallback: a plain off-screen textarea. Browsers
  // (notably Safari) refuse to copy from elements that are `readonly`, zero-size,
  // or `opacity: 0` — execCommand silently no-ops while the toast still reports
  // success — so keep the element simple and just push it off-screen.
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  const previouslyFocused = document.activeElement as (Element & {
    focus?: (options?: FocusOptions) => void;
  }) | null;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const success = document.execCommand("copy");
    if (!success) throw new Error("execCommand copy failed");
  } finally {
    document.body.removeChild(textarea);
    if (previouslyFocused !== document.activeElement && typeof previouslyFocused?.focus === "function") {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}
