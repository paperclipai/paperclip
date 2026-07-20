import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import legacyZhCN from "./legacy-zh-CN.json";
import legacyZhCNOverrides from "./legacy-zh-CN.overrides.json";

const LOCALIZED_ATTRIBUTES = ["alt", "aria-description", "aria-label", "placeholder", "title"] as const;
const SKIPPED_SELECTOR = [
  "[data-i18n-skip]",
  "[contenteditable='true']",
  ".paperclip-markdown",
  "code",
  "kbd",
  "noscript",
  "pre",
  "script",
  "style",
  "textarea",
].join(",");

type LegacyTranslations = Record<string, string>;
type TemplateTranslation = {
  expression: RegExp;
  translation: string;
};

const translations = {
  ...(legacyZhCN as LegacyTranslations),
  ...(legacyZhCNOverrides as LegacyTranslations),
};

function decodeJsxEntities(value: string) {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&lsquo;", "‘")
    .replaceAll("&rsquo;", "’")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalize(value: string) {
  return decodeJsxEntities(value).replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const exactTranslations = new Map<string, string>();
const templateTranslations: TemplateTranslation[] = [];

for (const [source, translation] of Object.entries(translations)) {
  const normalizedSource = normalize(source);
  if (!normalizedSource) continue;
  const placeholderMatches = [...normalizedSource.matchAll(/{{value(\d+)}}/g)];
  if (placeholderMatches.length === 0) {
    exactTranslations.set(normalizedSource, translation);
    continue;
  }

  let cursor = 0;
  let pattern = "^";
  for (const match of placeholderMatches) {
    pattern += escapeRegExp(normalizedSource.slice(cursor, match.index));
    pattern += "(.+?)";
    cursor = (match.index ?? 0) + match[0].length;
  }
  pattern += `${escapeRegExp(normalizedSource.slice(cursor))}$`;
  templateTranslations.push({ expression: new RegExp(pattern), translation });
}

templateTranslations.sort((left, right) => right.expression.source.length - left.expression.source.length);

export function translateLegacyLiteral(value: string) {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return null;

  const exact = exactTranslations.get(normalizedValue);
  if (exact) return exact;

  for (const template of templateTranslations) {
    const match = normalizedValue.match(template.expression);
    if (!match) continue;
    return template.translation.replace(/{{value(\d+)}}/g, (_, index: string) => match[Number(index)] ?? "");
  }

  return null;
}

function isSkipped(node: Node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(SKIPPED_SELECTOR));
}

export function LegacyLiteralLocalizer() {
  const { i18n } = useTranslation();

  useEffect(() => {
    const originalText = new WeakMap<Text, string>();
    const originalAttributes = new WeakMap<Element, Map<string, string>>();
    const trackedText = new Set<Text>();
    const trackedElements = new Set<Element>();
    let chineseActive = i18n.resolvedLanguage === "zh-CN" || i18n.language === "zh-CN";

    function localizeTextNode(node: Text) {
      if (!chineseActive || !node.isConnected || isSkipped(node)) return;
      const translated = translateLegacyLiteral(node.data);
      if (!translated || translated === normalize(node.data)) return;
      originalText.set(node, node.data);
      trackedText.add(node);
      const leading = node.data.match(/^\s*/)?.[0] ?? "";
      const trailing = node.data.match(/\s*$/)?.[0] ?? "";
      node.data = `${leading}${translated}${trailing}`;
    }

    function localizeAttributes(element: Element) {
      if (!chineseActive || !element.isConnected || isSkipped(element)) return;
      for (const attribute of LOCALIZED_ATTRIBUTES) {
        const current = element.getAttribute(attribute);
        if (!current) continue;
        const translated = translateLegacyLiteral(current);
        if (!translated || translated === normalize(current)) continue;
        const originals = originalAttributes.get(element) ?? new Map<string, string>();
        originals.set(attribute, current);
        originalAttributes.set(element, originals);
        trackedElements.add(element);
        element.setAttribute(attribute, translated);
      }
    }

    function localizeTree(root: Node) {
      if (root.nodeType === Node.TEXT_NODE) {
        localizeTextNode(root as Text);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE || isSkipped(root)) return;
      const element = root as Element;
      localizeAttributes(element);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        if (current.nodeType === Node.TEXT_NODE) localizeTextNode(current as Text);
        else localizeAttributes(current as Element);
        current = walker.nextNode();
      }
    }

    function restoreEnglish() {
      for (const node of trackedText) {
        const original = originalText.get(node);
        if (original !== undefined && node.isConnected) node.data = original;
      }
      for (const element of trackedElements) {
        const originals = originalAttributes.get(element);
        if (!originals || !element.isConnected) continue;
        for (const [attribute, original] of originals) element.setAttribute(attribute, original);
      }
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") localizeTextNode(mutation.target as Text);
        else if (mutation.type === "attributes") localizeAttributes(mutation.target as Element);
        else for (const node of mutation.addedNodes) localizeTree(node);
      }
    });
    observer.observe(document.body, {
      attributeFilter: [...LOCALIZED_ATTRIBUTES],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    function handleLanguageChanged(locale: string) {
      chineseActive = locale === "zh-CN";
      if (chineseActive) localizeTree(document.body);
      else restoreEnglish();
    }

    i18n.on("languageChanged", handleLanguageChanged);
    handleLanguageChanged(i18n.resolvedLanguage ?? i18n.language);

    return () => {
      observer.disconnect();
      i18n.off("languageChanged", handleLanguageChanged);
      restoreEnglish();
    };
  }, [i18n]);

  return null;
}
