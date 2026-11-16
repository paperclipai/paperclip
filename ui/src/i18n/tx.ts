import { cloneElement, isValidElement, useCallback, type ReactNode } from "react";

import { useTranslation } from "./index";
import { isSelectableLocale, readChosenLocale, readStoredLocale } from "./preference";
import { ruLabels } from "./ru-labels";

/** `ru`, `ru-RU`, and any other region of Russian. Not a prefix of an unrelated code. */
export function isRussianLocale(language: string | null | undefined): boolean {
  if (!language) return false;
  return language.toLowerCase().split("-")[0] === "ru";
}

/**
 * Locale the label map should follow. The switcher writes `paperclip.locale`
 * before i18next finishes `changeLanguage`. A stale `en` resolution must not
 * hide a non-English choice that is already in `SELECTABLE_LOCALES`.
 */
export function effectiveUiLanguage(
  resolved: string | undefined,
  stored?: string | null,
): string | undefined {
  const chosen = readChosenLocale();
  if (chosen) return chosen;
  if (isSelectableLocale(stored) && stored !== "en") return stored;
  if (isRussianLocale(resolved)) return "ru";
  if (isSelectableLocale(resolved)) return resolved;
  const base = resolved?.toLowerCase().split("-")[0];
  if (isSelectableLocale(base)) return base;
  return resolved;
}

function ownRussianLabel(text: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(ruLabels, text)) return undefined;
  const value = ruLabels[text];
  return typeof value === "string" ? value : undefined;
}

export function translateLabel(language: string | undefined, text: string): string {
  if (!isRussianLocale(language) || text.length === 0) return text;
  const direct = ownRussianLabel(text);
  if (direct !== undefined) return direct;
  const trimmed = text.trim();
  if (trimmed !== text && trimmed.length > 0) {
    const hit = ownRussianLabel(trimmed);
    if (hit !== undefined) return hit;
  }
  return text;
}

export function useUiLanguage(): string | undefined {
  const { i18n } = useTranslation();
  return effectiveUiLanguage(i18n.resolvedLanguage ?? i18n.language, readStoredLocale());
}

export function useTx(): (text: string) => string {
  const language = useUiLanguage();
  return useCallback((text: string) => translateLabel(language, text), [language]);
}

/** Translate string children a few levels down. Elements, keys, and props stay as they are. */
export function translateTextNode(tx: (text: string) => string, node: ReactNode, depth = 0): ReactNode {
  if (typeof node === "string") return tx(node);
  if (node == null || typeof node === "number" || typeof node === "boolean" || depth >= 4) return node;
  if (Array.isArray(node)) return node.map((child) => translateTextNode(tx, child, depth + 1));
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    if (props == null || !("children" in props)) return node;
    const nextChildren = translateTextNode(tx, props.children, depth + 1);
    if (nextChildren === props.children) return node;
    return cloneElement(node, undefined, nextChildren);
  }
  return node;
}

type TextProps = {
  "aria-label"?: unknown;
  title?: unknown;
  placeholder?: unknown;
};

export function withTranslatedTextProps<T extends TextProps>(tx: (text: string) => string, props: T): T {
  let next = props;
  const patch: Partial<Record<keyof TextProps, string>> = {};
  if (typeof props["aria-label"] === "string") patch["aria-label"] = tx(props["aria-label"]);
  if (typeof props.title === "string") patch.title = tx(props.title);
  if (typeof props.placeholder === "string") patch.placeholder = tx(props.placeholder);
  if (Object.keys(patch).length > 0) next = { ...props, ...patch };
  return next;
}
