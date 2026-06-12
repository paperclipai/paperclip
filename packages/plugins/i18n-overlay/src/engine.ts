export interface Dictionary {
  $meta?: { language: string; version?: number };
  text?: Record<string, string>;
  attr?: Record<string, string>;
}

export interface TranslatorOptions {
  attributes?: string[];
  skipSelectors?: string[];
  root?: HTMLElement;
}

export interface Translator {
  start(): void;
  stop(): void;
  translateTree(root: Node): void;
}

const DEFAULT_ATTRS = ["placeholder", "title", "aria-label"];
const DEFAULT_SKIP = ["script", "style", "code", "pre", "textarea", '[contenteditable="true"]'];

export function createTranslator(dict: Dictionary, options: TranslatorOptions = {}): Translator {
  const text = dict.text ?? {};
  const skip = options.skipSelectors ?? DEFAULT_SKIP;
  // Records the exact value we wrote, so the observer (Task 4) can ignore our own writes.
  const written = new WeakMap<Node, string>();

  function inSkippedSubtree(node: Node): boolean {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return false;
    return skip.some((sel) => el.closest(sel) !== null);
  }

  function translateTextNode(node: Text): void {
    const raw = node.nodeValue ?? "";
    const key = raw.trim();
    if (!key) return;
    const value = text[key];
    if (value === undefined || value === key) return;
    if (inSkippedSubtree(node)) return;
    const lead = raw.slice(0, raw.indexOf(key));
    const trail = raw.slice(raw.indexOf(key) + key.length);
    const next = lead + value + trail;
    node.nodeValue = next;
    written.set(node, next);
  }

  function translateTree(root: Node): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let n = walker.nextNode();
    while (n) { nodes.push(n as Text); n = walker.nextNode(); }
    for (const t of nodes) translateTextNode(t);
  }

  const root = options.root ?? document.body;
  return {
    start() { translateTree(root); },
    stop() { /* observer wired up in Task 4 */ },
    translateTree,
  };
}
