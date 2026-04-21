import { createRootEditorSubscription$, realmPlugin } from "@mdxeditor/editor";
import { $isLinkNode, type LinkNode } from "@lexical/link";
import {
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalNode,
  type PointType,
} from "lexical";
import { parseMentionChipHref } from "./mention-chips";

export type MentionDeletionDirection = "backward" | "forward";

function isMentionLinkNode(node: LexicalNode | null | undefined): node is LinkNode {
  return Boolean(node && $isLinkNode(node) && parseMentionChipHref(node.getURL()));
}

function findMentionLinkNode(node: LexicalNode | null | undefined): LinkNode | null {
  if (!node) return null;
  if (isMentionLinkNode(node)) return node;

  let parent = node.getParent();
  while (parent) {
    if (isMentionLinkNode(parent)) return parent;
    parent = parent.getParent();
  }

  return null;
}

function findMentionLinkNodeAtPoint(point: PointType, direction: MentionDeletionDirection): LinkNode | null {
  const node = point.getNode();
  const directMention = findMentionLinkNode(node);
  if (directMention) return directMention;

  if (point.type === "element" && $isElementNode(node)) {
    const childIndex = direction === "backward" ? point.offset - 1 : point.offset;
    if (childIndex < 0) return null;
    return findMentionLinkNode(node.getChildAtIndex(childIndex));
  }

  if (point.type === "text" && $isTextNode(node)) {
    if (direction === "backward" && point.offset === 0) {
      return findMentionLinkNode(node.getPreviousSibling());
    }

    if (direction === "forward" && point.offset === node.getTextContentSize()) {
      return findMentionLinkNode(node.getNextSibling());
    }
  }

  return null;
}

export function findMentionLinkForDeletion(direction: MentionDeletionDirection): LinkNode | null {
  const selection = $getSelection();
  if (!selection) return null;

  if ($isNodeSelection(selection)) {
    const [selectedNode] = selection.getNodes();
    return selectedNode ? findMentionLinkNode(selectedNode) : null;
  }

  if (!$isRangeSelection(selection)) return null;

  const anchorMention = findMentionLinkNode(selection.anchor.getNode());
  const focusMention = findMentionLinkNode(selection.focus.getNode());
  if (anchorMention && focusMention && anchorMention.is(focusMention)) {
    return anchorMention;
  }

  if (!selection.isCollapsed()) return null;

  return findMentionLinkNodeAtPoint(selection.anchor, direction);
}

export function deleteSelectedMentionChip(direction: MentionDeletionDirection): boolean {
  const mentionNode = findMentionLinkForDeletion(direction);
  if (!mentionNode) return false;

  const previousSibling = mentionNode.getPreviousSibling();
  const nextSibling = mentionNode.getNextSibling();
  const parent = mentionNode.getParentOrThrow();

  mentionNode.remove();

  if (direction === "backward") {
    if (previousSibling) {
      previousSibling.selectEnd();
      return true;
    }
    if (nextSibling) {
      nextSibling.selectStart();
      return true;
    }
    parent.selectStart();
    return true;
  }

  if (nextSibling) {
    nextSibling.selectStart();
    return true;
  }
  if (previousSibling) {
    previousSibling.selectEnd();
    return true;
  }
  parent.selectEnd();
  return true;
}

function handleMentionDelete(direction: MentionDeletionDirection, event: KeyboardEvent | null): boolean {
  const didDelete = deleteSelectedMentionChip(direction);
  if (!didDelete) return false;

  event?.preventDefault();
  event?.stopPropagation();
  return true;
}

export const mentionDeletionPlugin = realmPlugin({
  init(realm) {
    realm.pub(createRootEditorSubscription$, [
      (editor) =>
        editor.registerCommand(
          KEY_BACKSPACE_COMMAND,
          (event) => handleMentionDelete("backward", event as KeyboardEvent | null),
          COMMAND_PRIORITY_HIGH,
        ),
      (editor) =>
        editor.registerCommand(
          KEY_DELETE_COMMAND,
          (event) => handleMentionDelete("forward", event as KeyboardEvent | null),
          COMMAND_PRIORITY_HIGH,
        ),
    ]);
  },
});
