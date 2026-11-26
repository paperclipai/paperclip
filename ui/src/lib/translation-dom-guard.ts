import { hasPageTranslationMarker } from "./browser-error-context";

interface GuardedMethods {
  removeChild: Node["removeChild"];
  insertBefore: Node["insertBefore"];
}

let installed: GuardedMethods | undefined;

function childOfParentContaining(parent: Node, node: Node): Node | null {
  let current: Node | null = node;
  while (current && current.parentNode !== parent) current = current.parentNode;
  return current;
}

function isTranslationWrapper(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === "font";
}

interface ReplacementTracker {
  inserted: WeakMap<Node, Element>;
  replacements: WeakMap<Node, Element>;
}

function isTextNode(node: Node | null | undefined): node is Text {
  return !!node && node.nodeType === Node.TEXT_NODE;
}

function recordReplacements(records: MutationRecord[], tracker: ReplacementTracker) {
  for (const record of records) {
    if (record.type !== "childList") continue;
    const added = record.addedNodes.length === 1 ? record.addedNodes[0] : null;
    const wrapper = isTranslationWrapper(added) ? added : null;
    if (record.removedNodes.length === 0) {
      if (!wrapper) continue;
      if (isTextNode(record.previousSibling)) tracker.inserted.set(record.previousSibling, wrapper);
      if (isTextNode(record.nextSibling)) tracker.inserted.set(record.nextSibling, wrapper);
      continue;
    }
    if (record.removedNodes.length !== 1) continue;
    const removed = record.removedNodes[0];
    if (!isTextNode(removed)) continue;
    if (wrapper) {
      tracker.replacements.set(removed, wrapper);
      continue;
    }
    if (record.addedNodes.length > 0) continue;
    const insertedWrapper = tracker.inserted.get(removed);
    if (insertedWrapper && (record.previousSibling === insertedWrapper || record.nextSibling === insertedWrapper)) {
      tracker.replacements.set(removed, insertedWrapper);
    }
  }
}

export function startTranslationDomGuard(): () => void {
  if (installed || typeof Node !== "function" || !Node.prototype) return () => {};
  const proto = Node.prototype;
  const native: GuardedMethods = { removeChild: proto.removeChild, insertBefore: proto.insertBefore };
  installed = native;

  const tracker: ReplacementTracker = { inserted: new WeakMap(), replacements: new WeakMap() };
  let observer: MutationObserver | undefined;
  if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.documentElement) {
    observer = new MutationObserver((records) => recordReplacements(records, tracker));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  const replacementInside = (parent: Node, node: Node): Element | null => {
    if (observer) recordReplacements(observer.takeRecords(), tracker);
    const replacement = tracker.replacements.get(node);
    return replacement && replacement.parentNode === parent ? replacement : null;
  };

  proto.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (child && child.parentNode !== this && hasPageTranslationMarker()) {
      if (child.parentNode === null) {
        const replacement = replacementInside(this, child);
        if (replacement) native.removeChild.call(this, replacement);
        return child;
      }
      if (this.contains(child)) return native.removeChild.call(child.parentNode, child) as T;
    }
    return native.removeChild.call(this, child) as T;
  };

  proto.insertBefore = function insertBefore<T extends Node>(this: Node, node: T, child: Node | null): T {
    if (child && child.parentNode !== this && hasPageTranslationMarker()) {
      if (child.parentNode === null) {
        return native.insertBefore.call(this, node, replacementInside(this, child)) as T;
      }
      const wrapper = this.contains(child) ? childOfParentContaining(this, child) : null;
      if (wrapper) return native.insertBefore.call(this, node, wrapper) as T;
    }
    return native.insertBefore.call(this, node, child) as T;
  };

  return () => {
    if (installed !== native) return;
    observer?.disconnect();
    proto.removeChild = native.removeChild;
    proto.insertBefore = native.insertBefore;
    installed = undefined;
  };
}
