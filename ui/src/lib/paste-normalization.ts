import { $insertDataTransferForRichText } from "@lexical/clipboard";
import { createRootEditorSubscription$, realmPlugin } from "@mdxeditor/editor";
import { $addUpdateTag, $getSelection, $isRangeSelection, $isTextNode, $isLineBreakNode, COMMAND_PRIORITY_CRITICAL, PASTE_COMMAND, PASTE_TAG } from "lexical";
import { looksLikeMarkdownPaste } from "./markdownPaste";
import { normalizeMarkdown } from "./normalize-markdown";

function isPastedLinkTarget(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(?:mailto|tel|sms):\S/i.test(trimmed)) return true;
  if (/^[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}])?$/iu.test(trimmed)) return true;
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}`
    : trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return false;
  try {
    const hostname = new URL(candidate).hostname;
    return hostname.length > 0 && !/^www\.?$/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * MDXEditor/Lexical plugin that intercepts paste events and normalizes
 * markdown content before the editor processes it. Fixes issues with
 * extra leading spaces when pasting from terminals or consoles.
 */
export const pasteNormalizationPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [
      (editor) => {
        let skipNext = false;

        return editor.registerCommand(
          PASTE_COMMAND,
          (event) => {
            if (skipNext) {
              skipNext = false;
              return false;
            }

            const clipboardData =
              event instanceof ClipboardEvent ? event.clipboardData : null;
            if (!clipboardData || Array.from(clipboardData.types).includes("Files")) return false;

            const text = clipboardData.getData("text/plain");
            if (!text) return false;

            const html = clipboardData.getData("text/html");

            // Markdown-looking pastes are handled by MarkdownEditor.tsx via
            // insertMarkdown(), so the plugin only owns the plain-text fallback.
            if (!html && looksLikeMarkdownPaste(text)) return false;

            const cleaned = normalizeMarkdown(text);
            const selection = $getSelection();
            if ($isRangeSelection(selection) && !selection.isCollapsed()
              && selection.getNodes().every(node => $isLineBreakNode(node) || ($isTextNode(node) && node.isSimpleText()))
              && !isPastedLinkTarget(cleaned)) {
              $addUpdateTag(PASTE_TAG);
              // Use the native rich-paste insertion path before LinkPlugin can
              // mistake the plain-text flavor of this payload for a link URL.
              if (html) $insertDataTransferForRichText(clipboardData, selection, editor);
              else selection.insertRawText(cleaned);
              event.preventDefault();
              return true;
            }
            if (html || cleaned === text) return false;

            // Prevent the original paste from being processed
            if (event instanceof ClipboardEvent) {
              event.preventDefault();
            }

            // Re-dispatch with cleaned data so MDXEditor's handler processes it
            const dt = new DataTransfer();
            dt.setData("text/plain", cleaned);
            const newEvent = new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            });

            skipNext = true;
            editor.dispatchCommand(PASTE_COMMAND, newEvent);
            return true;
          },
          COMMAND_PRIORITY_CRITICAL,
        );
      },
    ]);
  },
});
