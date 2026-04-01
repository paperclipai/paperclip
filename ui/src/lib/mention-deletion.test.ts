import { describe, expect, it } from "vitest";
import { $createLinkNode, LinkNode } from "@lexical/link";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  createEditor,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from "lexical";
import { deleteSelectedMentionChip } from "./mention-deletion";

function createTestEditor() {
  return createEditor({
    namespace: "mention-deletion-test",
    nodes: [LinkNode],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("mention deletion", () => {
  it("removes the full mention when backspacing from inside the chip", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Hello ");
      const mention = $createLinkNode(buildAgentMentionHref("agent-123", "code"));
      const mentionText = $createTextNode("@QA");
      const after = $createTextNode(" world");

      mention.append(mentionText);
      paragraph.append(before, mention, after);
      root.append(paragraph);

      mentionText.selectEnd();

      expect(deleteSelectedMentionChip("backward")).toBe(true);
      expect(root.getTextContent()).toBe("Hello  world");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after backward mention deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(before)).toBe(true);
      expect(selection.anchor.offset).toBe(before.getTextContentSize());
    });
  });

  it("removes the full mention when deleting forward from adjacent text", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Hello ");
      const mention = $createLinkNode(buildAgentMentionHref("agent-123", "code"));
      const mentionText = $createTextNode("@QA");
      const after = $createTextNode(" world");

      mention.append(mentionText);
      paragraph.append(before, mention, after);
      root.append(paragraph);

      before.selectEnd();

      expect(deleteSelectedMentionChip("forward")).toBe(true);
      expect(root.getTextContent()).toBe("Hello  world");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after forward mention deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(after)).toBe(true);
      expect(selection.anchor.offset).toBe(0);
    });
  });
});
