/**
 * Copy a string to the system clipboard.
 *
 * In secure contexts (HTTPS or `http://localhost`) this uses the async
 * `navigator.clipboard.writeText` API. In non-secure contexts — e.g. when a
 * user self-hosts Paperclip over plain HTTP at `http://<lan-host>:<port>` —
 * `navigator.clipboard` is `undefined` per the Clipboard API spec, so we fall
 * back to the legacy `document.execCommand("copy")` path via a transient
 * off-screen textarea.
 *
 * The fallback must run synchronously inside the user gesture (click handler)
 * that invoked this function; browsers only allow `execCommand("copy")` under
 * a trusted gesture, and this promise's executor runs synchronously on
 * construction, so callers that `await` or chain `.then` inside an onClick
 * preserve the invariant.
 *
 * Rejects if neither path succeeds, so callers can surface a toast on failure.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function" &&
    (typeof window === "undefined" || window.isSecureContext)
  ) {
    await navigator.clipboard.writeText(text);
    return;
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
