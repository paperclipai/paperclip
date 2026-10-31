export type DisplayCatalog = Record<string, string>;
export type DomTextTranslator = (raw: string) => string | null;

const SKIP_SELECTOR = [
  "code",
  "pre",
  "script",
  "style",
  "textarea",
  "input",
  "kbd",
  "samp",
  "[contenteditable=\"\"]",
  "[contenteditable=\"true\"]",
  "[data-no-translate]",
  ".ProseMirror",
  "[data-lexical-editor]",
  ".mdxeditor",
  ".cm-editor",
  ".monaco-editor",
  ".prose",
  ".paperclip-markdown",
  "[data-markdown]",
].join(",");

const DISPLAY_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];
const COUNTED_NOUN = /^(\d[\d\s.,]*)\s+([A-Za-z]+)$/;
const MAX_TEMPLATE_INPUT = 240;
const MAX_CACHE_SIZE = 20_000;

interface TemplateMatcher {
  pattern: RegExp;
  keys: string[];
  translation: string;
  anchor: string;
}

function hasOwn(catalog: DisplayCatalog, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(catalog, key);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fillPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(v\d+)\}\}/g, (token, key: string) => values[key] ?? token);
}

export function buildTemplateMatchers(catalog: DisplayCatalog): TemplateMatcher[] {
  const matchers: TemplateMatcher[] = [];
  for (const [source, translation] of Object.entries(catalog)) {
    if (!source.includes("{{v")) continue;
    const parts = source.split(/(\{\{v\d+\}\})/);
    const fixedParts = parts.filter((_, index) => index % 2 === 0);
    const anchor = fixedParts.reduce((longest, part) => (part.trim().length > longest.length ? part.trim() : longest), "");
    const fixedWords = fixedParts.join(" ").match(/[A-Za-z]{2,}/g) ?? [];
    if (fixedWords.length < 2 || anchor.replace(/[^A-Za-z]/g, "").length < 4) continue;
    const keys = parts.filter((_, index) => index % 2 === 1).map((part) => part.slice(2, -2));
    const pattern = new RegExp(`^${parts.map((part, index) => (index % 2 === 1 ? "(.+?)" : escapeRegExp(part))).join("")}$`, "s");
    matchers.push({ pattern, keys, translation, anchor });
  }
  return matchers.sort((left, right) => right.anchor.length - left.anchor.length);
}

export function createDomTranslator(catalog: DisplayCatalog): DomTextTranslator {
  const templates = buildTemplateMatchers(catalog);
  const translatedOutputs = new Set(Object.values(catalog).map((value) => value.replace(/\s+/g, " ").trim()));
  const cache = new Map<string, string | null>();

  const lookup = (text: string): string | null => {
    if (hasOwn(catalog, text)) return catalog[text];
    const counted = COUNTED_NOUN.exec(text);
    if (counted) {
      const key = `{{v0}} ${counted[2]}`;
      if (hasOwn(catalog, key)) return fillPlaceholders(catalog[key], { v0: counted[1] });
    }
    if (text.length >= MAX_TEMPLATE_INPUT) return null;
    for (const template of templates) {
      if (!text.includes(template.anchor)) continue;
      const match = template.pattern.exec(text);
      if (!match) continue;
      const values = Object.fromEntries(template.keys.map((key, index) => [key, match[index + 1]]));
      return fillPlaceholders(template.translation, values);
    }
    return null;
  };

  return (raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text.length < 2 || !/[A-Za-z]{2}/.test(text)) return null;
    if (translatedOutputs.has(text) && !hasOwn(catalog, text)) return null;
    let translated = cache.get(text);
    if (translated === undefined) {
      translated = lookup(text);
      if (cache.size > MAX_CACHE_SIZE) cache.clear();
      cache.set(text, translated);
    }
    if (translated === null || translated === text) return null;
    return (raw.match(/^\s*/)?.[0] ?? "") + translated + (raw.match(/\s*$/)?.[0] ?? "");
  };
}

export function startDomTranslation(root: Node, translate: DomTextTranslator): () => void {
  const owned = new WeakMap<Node, string>();
  const isSkipped = (element: Element | null) => !element || Boolean(element.closest(SKIP_SELECTOR));

  const translateTextNode = (node: Node) => {
    const parent = node.parentElement;
    if (isSkipped(parent)) return;
    if (parent?.tagName === "OPTION" && !parent.hasAttribute("value")) return;
    const value = node.nodeValue;
    if (value === null || owned.get(node) === value) return;
    const translated = translate(value);
    if (translated !== null && translated !== value) {
      node.nodeValue = translated;
      owned.set(node, translated);
    }
  };

  const translateAttributes = (element: Element) => {
    for (const attribute of DISPLAY_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const marker = `data-display-${attribute}`;
      if (element.getAttribute(marker) === value) continue;
      const translated = translate(value);
      if (translated !== null && translated !== value) {
        element.setAttribute(attribute, translated);
        element.setAttribute(marker, translated);
      }
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      translateTextNode(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      translateAttributes(node as Element);
      if (isSkipped(node as Element)) return;
    }
    const document = node.ownerDocument ?? (node as Document);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.nodeType === Node.TEXT_NODE) translateTextNode(current);
      else translateAttributes(current as Element);
    }
  };

  walk(root);
  const view = (root.ownerDocument ?? (root as Document)).defaultView;
  if (!view) return () => {};
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") translateTextNode(record.target);
      else if (record.type === "attributes") translateAttributes(record.target as Element);
      else record.addedNodes.forEach(walk);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: DISPLAY_ATTRIBUTES,
  });
  return () => observer.disconnect();
}

type DateLocaleMethod = "toLocaleDateString" | "toLocaleTimeString" | "toLocaleString";
type PatchedFunction = { __paperclipDisplayLocale?: string };

export function installDisplayDateLocale(target: typeof globalThis, locale: string): void {
  const swap = (requested: unknown) =>
    requested === undefined || (typeof requested === "string" && /^en(-US)?$/i.test(requested)) ? locale : requested;

  const prototype = target.Date.prototype;
  for (const name of ["toLocaleDateString", "toLocaleTimeString", "toLocaleString"] as DateLocaleMethod[]) {
    const original = prototype[name] as ((this: Date, locales?: unknown, options?: unknown) => string) & PatchedFunction;
    if (original.__paperclipDisplayLocale) continue;
    const patched = function (this: Date, locales?: unknown, options?: unknown) {
      return original.call(this, swap(locales), options);
    } as typeof original;
    patched.__paperclipDisplayLocale = locale;
    prototype[name] = patched as Date[DateLocaleMethod];
  }

  const OriginalDateTimeFormat = target.Intl.DateTimeFormat as typeof Intl.DateTimeFormat & PatchedFunction;
  if (!OriginalDateTimeFormat.__paperclipDisplayLocale) {
    const PatchedDateTimeFormat = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      const instance = new OriginalDateTimeFormat(locales, options);
      const displayLocale = swap(locales);
      if (displayLocale !== locales) {
        const display = new OriginalDateTimeFormat(displayLocale as string, options);
        Object.defineProperty(instance, "format", { value: display.format, configurable: true });
        Object.defineProperty(instance, "formatRange", { value: display.formatRange.bind(display), configurable: true });
      }
      return instance;
    } as unknown as typeof Intl.DateTimeFormat & PatchedFunction;
    Object.defineProperty(PatchedDateTimeFormat, "prototype", { value: OriginalDateTimeFormat.prototype });
    Object.defineProperty(PatchedDateTimeFormat, "supportedLocalesOf", {
      value: OriginalDateTimeFormat.supportedLocalesOf.bind(OriginalDateTimeFormat),
    });
    PatchedDateTimeFormat.__paperclipDisplayLocale = locale;
    Object.defineProperty(target.Intl, "DateTimeFormat", { value: PatchedDateTimeFormat, configurable: true, writable: true });
  }

  const OriginalRelativeTimeFormat = target.Intl.RelativeTimeFormat as typeof Intl.RelativeTimeFormat & PatchedFunction;
  if (!OriginalRelativeTimeFormat.__paperclipDisplayLocale) {
    const PatchedRelativeTimeFormat = function (locales?: string | string[], options?: Intl.RelativeTimeFormatOptions) {
      return new OriginalRelativeTimeFormat(swap(locales) as string | string[] | undefined, options);
    } as unknown as typeof Intl.RelativeTimeFormat & PatchedFunction;
    Object.defineProperty(PatchedRelativeTimeFormat, "prototype", { value: OriginalRelativeTimeFormat.prototype });
    Object.defineProperty(PatchedRelativeTimeFormat, "supportedLocalesOf", {
      value: OriginalRelativeTimeFormat.supportedLocalesOf.bind(OriginalRelativeTimeFormat),
    });
    PatchedRelativeTimeFormat.__paperclipDisplayLocale = locale;
    Object.defineProperty(target.Intl, "RelativeTimeFormat", { value: PatchedRelativeTimeFormat, configurable: true, writable: true });
  }
}
