import { ANALYTICS_MASK_TEXT_SELECTOR, ANALYTICS_NO_CAPTURE_CLASS } from "./privacy";

const BLOCK_SELECTOR = `.${ANALYTICS_NO_CAPTURE_CLASS}`;

export function recordedTextNode(node: Text): string {
  const parent = node.parentElement;
  if (parent?.closest(BLOCK_SELECTOR)) return "";
  if (parent?.closest(ANALYTICS_MASK_TEXT_SELECTOR)) return node.data.replace(/\S/g, "*");
  return node.data;
}

export function recordedText(root: Node = document.body): string {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  while (walker.nextNode()) text += recordedTextNode(walker.currentNode as Text);
  return text;
}

export function replayLeaks(sensitive: string, root: Node = document.body): { rendered: boolean; recorded: boolean } {
  return {
    rendered: (root.textContent ?? "").includes(sensitive),
    recorded: recordedText(root).includes(sensitive),
  };
}

export function isBlockedFromReplay(sensitive: string, root: Node = document.body): boolean {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let found = false;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data.includes(sensitive)) continue;
    found = true;
    if (!node.parentElement?.closest(BLOCK_SELECTOR)) return false;
  }
  return found;
}
