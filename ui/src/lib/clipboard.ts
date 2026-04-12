/**
 * Copy a string to the system clipboard.
 *
 * In secure contexts (HTTPS or `http://localhost`) this tries the async
 * `navigator.clipboard.writeText` API first. In non-secure contexts — e.g.
 * when a user self-hosts Paperclip over plain HTTP at `http://<lan-host>:<port>` —
 * `navigator.clipboard` is `undefined` per the Clipboard API spec, so we go
 * straight to the legacy `document.execCommand("copy")` path via a transient
 * textarea.
 *
 * If the native API is present but rejects (e.g. a transient `NotAllowedError`
 * from the document losing focus mid-click, or a Safari timing quirk), we
 * cascade to the `execCommand` fallback rather than surfacing the rejection —
 * the fallback uses the same user-gesture gate as the modern API, so if it
 * succeeds the user gets their copy through. If both paths fail, the utility
 * rejects with the most recent error so callers can surface a toast.
 *
 * The fallback must run synchronously inside the user gesture (click handler)
 * that invoked this function; browsers only allow `execCommand("copy")` under
 * a trusted gesture. Callers that `await` this inside an onClick preserve the
 * invariant because the fallback path runs before any microtask suspension.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function" &&
    (typeof window === "undefined" || window.isSecureContext)
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Native API rejected (permissions, focus, transient browser error).
      // Fall through to the execCommand path.
    }
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard unavailable: no document");
  }

  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  // Render on-screen but invisible. Off-screen (`left: -9999px`) textareas
  // refuse to become the document selection in some browsers, which silently
  // breaks execCommand("copy").
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "0",
    border: "0",
    outline: "none",
    boxShadow: "none",
    background: "transparent",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const succeeded = document.execCommand("copy");
    if (!succeeded) {
      throw new Error("execCommand('copy') returned false");
    }
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.({ preventScroll: true });
  }
}
