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

function replacementCandidate(record: MutationRecord): Element | null {
  if (record.addedNodes.length === 1 && isTranslationWrapper(record.addedNodes[0])) return record.addedNodes[0];
  if (record.addedNodes.length > 0) return null;
  if (isTranslationWrapper(record.nextSibling)) return record.nextSibling;
  if (isTranslationWrapper(record.previousSibling)) return record.previousSibling;
  return null;
}

function recordReplacements(records: MutationRecord[], replacements: WeakMap<Node, Element>) {
  for (const record of records) {
    if (record.type !== "childList" || record.removedNodes.length !== 1) continue;
    const removed = record.removedNodes[0];
    if (removed.nodeType !== Node.TEXT_NODE || replacements.has(removed)) continue;
    const replacement = replacementCandidate(record);
    if (replacement) replacements.set(removed, replacement);
  }
}

export function startTranslationDomGuard(): () => void {
  if (installed || typeof Node !== "function" || !Node.prototype) return () => {};
  const proto = Node.prototype;
  const native: GuardedMethods = { removeChild: proto.removeChild, insertBefore: proto.insertBefore };
  installed = native;

  const replacements = new WeakMap<Node, Element>();
  let observer: MutationObserver | undefined;
  if (typeof MutationObserver === "function" && typeof document !== "undefined" && document.documentElement) {
    observer = new MutationObserver((records) => recordReplacements(records, replacements));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  const replacementInside = (parent: Node, node: Node): Element | null => {
    if (observer) recordReplacements(observer.takeRecords(), replacements);
    const replacement = replacements.get(node);
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
