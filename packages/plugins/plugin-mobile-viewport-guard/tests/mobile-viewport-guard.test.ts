import { describe, expect, it } from "vitest";
import {
  MOBILE_DROPDOWN_INPUT_GUARD_MARKER,
  MOBILE_DROPDOWN_INPUT_SELECTOR,
  MOBILE_VIEWPORT_GUARD_META_MARKER,
  MOBILE_VIEWPORT_GUARD_META_CONTENT,
  MOBILE_VIEWPORT_GUARD_STYLE_ID,
  isGuardedMobileViewport,
  mobileViewportGuardCss,
  shouldGuardDropdownKeyboard,
} from "../src/mobile-viewport-guard.js";
import { installMobileViewportGuard } from "../src/ui/index.js";

describe("mobile viewport guard", () => {
  it("sets mobile viewport width while preserving browser zoom", () => {
    expect(MOBILE_VIEWPORT_GUARD_META_CONTENT).toContain("width=device-width");
    expect(MOBILE_VIEWPORT_GUARD_META_CONTENT).toContain("initial-scale=1");
    expect(MOBILE_VIEWPORT_GUARD_META_CONTENT).toContain("viewport-fit=cover");
    expect(MOBILE_VIEWPORT_GUARD_META_CONTENT).not.toContain("maximum-scale");
    expect(MOBILE_VIEWPORT_GUARD_META_CONTENT).not.toContain("user-scalable");
  });

  it("targets mobile/coarse-pointer form controls with a 16px minimum font size", () => {
    const css = mobileViewportGuardCss();
    expect(css).toContain("@media (max-width: 820px), (pointer: coarse)");
    expect(css).toContain("input,");
    expect(css).toContain("textarea,");
    expect(css).toContain("select,");
    expect(css).toContain('[role="combobox"]');
    expect(css).toContain("font-size: max(16px, 1em) !important");
  });

  it("treats common phone/tablet widths and coarse pointers as guarded mobile viewports", () => {
    expect(isGuardedMobileViewport(390)).toBe(true);
    expect(isGuardedMobileViewport(820)).toBe(true);
    expect(isGuardedMobileViewport(1024)).toBe(false);
    expect(isGuardedMobileViewport(1200, true)).toBe(true);
  });

  it("targets dropdown search inputs for keyboard suppression without matching ordinary text fields", () => {
    expect(MOBILE_DROPDOWN_INPUT_SELECTOR).toContain("[cmdk-root] input");
    expect(MOBILE_DROPDOWN_INPUT_SELECTOR).not.toContain('input[role="combobox"]');
    expect(MOBILE_DROPDOWN_INPUT_SELECTOR).not.toContain('input[role="searchbox"]');

    const ordinary = document.createElement("input");
    ordinary.type = "text";
    expect(shouldGuardDropdownKeyboard(ordinary, 390, false)).toBe(false);

    const standaloneCmdkInput = document.createElement("input");
    standaloneCmdkInput.setAttribute("cmdk-input", "");
    expect(shouldGuardDropdownKeyboard(standaloneCmdkInput, 390, false)).toBe(false);

    const standaloneComboboxInput = document.createElement("input");
    standaloneComboboxInput.setAttribute("role", "combobox");
    expect(shouldGuardDropdownKeyboard(standaloneComboboxInput, 390, false)).toBe(false);

    const standaloneSearchboxInput = document.createElement("input");
    standaloneSearchboxInput.setAttribute("role", "searchbox");
    expect(shouldGuardDropdownKeyboard(standaloneSearchboxInput, 390, false)).toBe(false);

    const cmdkRoot = document.createElement("div");
    cmdkRoot.setAttribute("cmdk-root", "");
    const cmdkInput = document.createElement("input");
    cmdkRoot.appendChild(cmdkInput);
    document.body.appendChild(cmdkRoot);
    expect(shouldGuardDropdownKeyboard(cmdkInput, 390, false)).toBe(true);
    expect(shouldGuardDropdownKeyboard(cmdkInput, 1024, false)).toBe(false);
    expect(shouldGuardDropdownKeyboard(cmdkInput, 1024, true)).toBe(true);
    cmdkRoot.remove();

    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    const listboxInput = document.createElement("input");
    listbox.appendChild(listboxInput);
    document.body.appendChild(listbox);
    expect(shouldGuardDropdownKeyboard(listboxInput, 390, false)).toBe(true);
    listbox.remove();

    const explicitScope = document.createElement("div");
    explicitScope.setAttribute("data-paperclip-mobile-dropdown-keyboard-guard-scope", "true");
    const scopedInput = document.createElement("input");
    explicitScope.appendChild(scopedInput);
    document.body.appendChild(explicitScope);
    expect(shouldGuardDropdownKeyboard(scopedInput, 390, false)).toBe(true);
    explicitScope.remove();
  });

  it("includes CSS for visually neutralized guarded dropdown inputs", () => {
    const css = mobileViewportGuardCss();
    expect(css).toContain(`input[${MOBILE_DROPDOWN_INPUT_GUARD_MARKER}=\"true\"]`);
    expect(css).toContain("caret-color: transparent");
  });

  it("installs, re-enforces, unguards, and cleans up DOM mutations", async () => {
    const originalMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });

    const existingViewport = document.createElement("meta");
    existingViewport.name = "viewport";
    existingViewport.content = "width=980";
    document.head.appendChild(existingViewport);

    const existingStyle = document.createElement("style");
    existingStyle.id = MOBILE_VIEWPORT_GUARD_STYLE_ID;
    existingStyle.textContent = "/* existing */";
    document.head.appendChild(existingStyle);

    const scope = document.createElement("div");
    scope.setAttribute("cmdk-root", "");
    const dropdownInput = document.createElement("input");
    dropdownInput.setAttribute("autocomplete", "on");
    scope.appendChild(dropdownInput);
    document.body.appendChild(scope);

    const cleanup = installMobileViewportGuard();

    expect(existingViewport.content).toBe(MOBILE_VIEWPORT_GUARD_META_CONTENT);
    expect(existingViewport.getAttribute(MOBILE_VIEWPORT_GUARD_META_MARKER)).toBe("true");
    expect(existingStyle.textContent).toBe(mobileViewportGuardCss());
    expect(dropdownInput.getAttribute(MOBILE_DROPDOWN_INPUT_GUARD_MARKER)).toBe("true");
    expect(dropdownInput.getAttribute("inputmode")).toBe("none");
    expect(dropdownInput.hasAttribute("readonly")).toBe(true);

    existingViewport.content = "width=320";
    existingStyle.textContent = "/* clobbered */";
    document.documentElement.appendChild(document.createElement("span"));
    await Promise.resolve();

    expect(existingViewport.content).toBe(MOBILE_VIEWPORT_GUARD_META_CONTENT);
    expect(existingStyle.textContent).toBe(mobileViewportGuardCss());

    scope.removeAttribute("cmdk-root");
    dropdownInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(dropdownInput.getAttribute("autocomplete")).toBe("on");
    expect(dropdownInput.hasAttribute(MOBILE_DROPDOWN_INPUT_GUARD_MARKER)).toBe(false);
    expect(dropdownInput.hasAttribute("readonly")).toBe(false);

    scope.setAttribute("cmdk-root", "");
    dropdownInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(dropdownInput.getAttribute(MOBILE_DROPDOWN_INPUT_GUARD_MARKER)).toBe("true");

    cleanup();

    expect(existingViewport.content).toBe("width=980");
    expect(existingViewport.hasAttribute(MOBILE_VIEWPORT_GUARD_META_MARKER)).toBe(false);
    expect(existingStyle.textContent).toBe("/* existing */");
    expect(existingStyle.hasAttribute(MOBILE_VIEWPORT_GUARD_META_MARKER)).toBe(false);
    expect(dropdownInput.getAttribute("autocomplete")).toBe("on");
    expect(dropdownInput.hasAttribute(MOBILE_DROPDOWN_INPUT_GUARD_MARKER)).toBe(false);
    expect(dropdownInput.hasAttribute("readonly")).toBe(false);

    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    document.head.replaceChildren();
    document.body.replaceChildren();
  });
});
