import { useEffect } from "react";

const pseudoState = /(?<!\\):(hover|focus-visible|active)\b/g;

/** Mirror the browser's compiled state rules under a preview attribute. Keeping
 * the original selectors, layers and media conditions avoids a second palette. */
function forcedRule(rule: CSSRule, inheritedState = false): string {
  if (rule instanceof CSSStyleRule) {
    // A negated pseudo would otherwise match ordinary, unforced elements after
    // replacement. The shared Button uses positive interaction rules only.
    if (/:not\([^)]*(?<!\\):(hover|focus-visible|active)\b/.test(rule.selectorText)) return "";
    const hasState = /(?<!\\):(hover|focus-visible|active)\b/.test(rule.selectorText);
    const declarations = hasState || inheritedState ? rule.style.cssText : "";
    const children = Array.from(rule.cssRules ?? []).map(child => forcedRule(child, inheritedState || hasState)).join("");
    if (!declarations && !children) return "";
    return `${rule.selectorText.replace(pseudoState, '[data-button-preview-state="$1"]')}{${declarations}${children}}`;
  }
  if ("cssRules" in rule) {
    const children = Array.from((rule as CSSGroupingRule).cssRules).map(child => forcedRule(child, inheritedState)).join("");
    return children ? `${rule.cssText.slice(0, rule.cssText.indexOf("{") + 1)}${children}}` : "";
  }
  // Nested declarations inside an already selected state (modern CSS nesting).
  return inheritedState && rule.constructor.name === "CSSNestedDeclarations" ? rule.cssText : "";
}

export function useButtonPreviewStates() {
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.buttonPreviewStates = "";
    style.textContent = Array.from(document.styleSheets).flatMap(sheet => {
      try { return Array.from(sheet.cssRules).map(rule => forcedRule(rule)); }
      catch { return []; } // External stylesheets may not expose their CSSOM.
    }).join("\n");
    document.head.append(style);
    return () => style.remove();
  }, []);
}
