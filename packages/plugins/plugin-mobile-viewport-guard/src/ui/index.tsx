import { useEffect } from "react";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import {
  MOBILE_DROPDOWN_INPUT_GUARD_MARKER,
  MOBILE_VIEWPORT_GUARD_META_CONTENT,
  MOBILE_VIEWPORT_GUARD_META_MARKER,
  MOBILE_VIEWPORT_GUARD_STYLE_ID,
  mobileViewportGuardCss,
  shouldGuardDropdownKeyboard,
} from "../mobile-viewport-guard.js";

type AttributeSnapshot = Record<string, string | null>;

const guardedInputAttributes = [
  MOBILE_DROPDOWN_INPUT_GUARD_MARKER,
  "inputmode",
  "autocomplete",
  "autocorrect",
  "autocapitalize",
  "spellcheck",
  "readonly",
];

function snapshotAttributes(element: Element, attributes: string[]): AttributeSnapshot {
  return Object.fromEntries(attributes.map((attribute) => [attribute, element.getAttribute(attribute)]));
}

function restoreAttributes(element: Element, snapshot: AttributeSnapshot): void {
  for (const [attribute, value] of Object.entries(snapshot)) {
    if (value === null) {
      element.removeAttribute(attribute);
    } else {
      element.setAttribute(attribute, value);
    }
  }
}

function ensureViewportMeta(createdElements: Set<Element>, originalAttributes: WeakMap<Element, AttributeSnapshot>): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "viewport";
    document.head.prepend(meta);
    createdElements.add(meta);
  }

  if (!originalAttributes.has(meta)) {
    originalAttributes.set(meta, snapshotAttributes(meta, ["content", MOBILE_VIEWPORT_GUARD_META_MARKER]));
  }

  meta.setAttribute("content", MOBILE_VIEWPORT_GUARD_META_CONTENT);
  meta.setAttribute(MOBILE_VIEWPORT_GUARD_META_MARKER, "true");
  return meta;
}

function ensureGuardStyle(
  createdElements: Set<Element>,
  originalAttributes: WeakMap<Element, AttributeSnapshot>,
  originalTextContent: WeakMap<Element, string>,
): HTMLStyleElement {
  let style = document.getElementById(MOBILE_VIEWPORT_GUARD_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = MOBILE_VIEWPORT_GUARD_STYLE_ID;
    style.setAttribute(MOBILE_VIEWPORT_GUARD_META_MARKER, "true");
    document.head.appendChild(style);
    createdElements.add(style);
  }

  if (!originalAttributes.has(style)) {
    originalAttributes.set(style, snapshotAttributes(style, [MOBILE_VIEWPORT_GUARD_META_MARKER]));
    originalTextContent.set(style, style.textContent ?? "");
  }

  style.textContent = mobileViewportGuardCss();
  return style;
}

function guardDropdownInput(input: HTMLInputElement, originalAttributes: WeakMap<Element, AttributeSnapshot>): void {
  if (!originalAttributes.has(input)) {
    originalAttributes.set(input, snapshotAttributes(input, guardedInputAttributes));
  }

  input.setAttribute(MOBILE_DROPDOWN_INPUT_GUARD_MARKER, "true");
  input.setAttribute("inputmode", "none");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("readonly", "true");
}

export function installMobileViewportGuard(): () => void {
  if (typeof document === "undefined") return () => undefined;

  const createdElements = new Set<Element>();
  const originalAttributes = new WeakMap<Element, AttributeSnapshot>();
  const originalTextContent = new WeakMap<Element, string>();
  const guardedInputs = new Set<HTMLInputElement>();
  const guardCss = mobileViewportGuardCss();

  const guardAndTrackDropdownInput = (input: HTMLInputElement): void => {
    guardDropdownInput(input, originalAttributes);
    guardedInputs.add(input);
  };

  const unguardDropdownInput = (input: HTMLInputElement): void => {
    const snapshot = originalAttributes.get(input);
    if (snapshot) restoreAttributes(input, snapshot);
    originalAttributes.delete(input);
    guardedInputs.delete(input);
  };

  const guardAndTrackMobileDropdownInputs = (root: ParentNode = document): void => {
    root.querySelectorAll("input").forEach((input) => {
      if (shouldGuardDropdownKeyboard(input)) {
        guardAndTrackDropdownInput(input);
      }
    });
  };

  const handleFocus = (event: FocusEvent | PointerEvent | TouchEvent): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      if (shouldGuardDropdownKeyboard(target)) {
        guardAndTrackDropdownInput(target);
      } else if (guardedInputs.has(target)) {
        unguardDropdownInput(target);
      }
    }
  };

  ensureViewportMeta(createdElements, originalAttributes);
  ensureGuardStyle(createdElements, originalAttributes, originalTextContent);
  guardAndTrackMobileDropdownInputs();

  const observer = new MutationObserver((mutations) => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta || meta.getAttribute("content") !== MOBILE_VIEWPORT_GUARD_META_CONTENT) {
      ensureViewportMeta(createdElements, originalAttributes);
    }

    const style = document.getElementById(MOBILE_VIEWPORT_GUARD_STYLE_ID);
    if (!style || style.textContent !== guardCss) {
      ensureGuardStyle(createdElements, originalAttributes, originalTextContent);
    }

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLInputElement && shouldGuardDropdownKeyboard(node)) {
          guardAndTrackDropdownInput(node);
        } else if (node instanceof Element) {
          guardAndTrackMobileDropdownInputs(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["content"],
  });

  document.addEventListener("focusin", handleFocus, true);
  document.addEventListener("pointerdown", handleFocus, true);
  document.addEventListener("touchstart", handleFocus, true);

  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", handleFocus, true);
    document.removeEventListener("pointerdown", handleFocus, true);
    document.removeEventListener("touchstart", handleFocus, true);

    guardedInputs.forEach((input) => {
      const snapshot = originalAttributes.get(input);
      if (snapshot) restoreAttributes(input, snapshot);
    });

    const meta = document.querySelector<HTMLMetaElement>(`meta[${MOBILE_VIEWPORT_GUARD_META_MARKER}="true"]`);
    if (meta) {
      if (createdElements.has(meta)) {
        meta.remove();
      } else {
        const snapshot = originalAttributes.get(meta);
        if (snapshot) restoreAttributes(meta, snapshot);
      }
    }

    const style = document.getElementById(MOBILE_VIEWPORT_GUARD_STYLE_ID);
    if (style && createdElements.has(style)) {
      style.remove();
    } else if (style) {
      const snapshot = originalAttributes.get(style);
      if (snapshot) restoreAttributes(style, snapshot);
      const text = originalTextContent.get(style);
      if (text !== undefined) style.textContent = text;
    }
  };
}

function MobileViewportGuard() {
  useEffect(() => installMobileViewportGuard(), []);
  return <span hidden data-paperclip-mobile-viewport-guard="mounted" />;
}

export function MobileViewportGuardSidebarPanel(_props: PluginSidebarProps) {
  return <MobileViewportGuard />;
}
